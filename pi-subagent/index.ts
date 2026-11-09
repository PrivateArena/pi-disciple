/**
 * pi-subagent — one blocking `subagent(role, task)` tool (plan steps 15 and 16).
 *
 * Two parameters only: a model-chosen tool list or timeout would be a privilege-escalation primitive, and
 * the role table — built-in plus `subagent.roles` — is human-authored, so the model still only names a role.
 * The call blocks until the child finishes, returns its final message, and reports the child's token usage so
 * pi folds it into the footer and `/session` totals.
 *
 * Permission checks are not implemented here at all: the child's tools are shims onto the parent's
 * `ctx.executeTool()`, so every nested call runs in the parent's tool pipeline, where pi-gate lives.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolLoadout, type ToolLoadoutChanges } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { applyRoleConfig, canonicalRole, effectiveBudget, type RoleId, resolveCallRole, setConfiguredDefaultRole, type RoleTable, DEFAULT_ROLE_NAME } from "./roles.ts";
import { buildShims, type ShimHost } from "./shims.ts";
import { runChild } from "./child.ts";
import type { RunProgress } from "./child.ts";
import type { CeilingReport } from "./budget/ceiling-vocabulary.ts";
import { childSessionDir } from "./transcript/paths.ts";
import { pruneTranscripts } from "./transcript/retention.ts";
import { createCeilingBroker } from "./ceiling.ts";
import { loadSubagentLimits, type LoadedLimits, EXTENSION_CONFIG_SLUG } from "./config-file.ts";
import { resolveChildModel } from "./model-override.ts";
import { resolveChildRequest, resolveModelPin } from "./child-request.ts";
import { buildConfigView, buildModelCatalog, COMMAND_ARGS, formatRunning, type SubagentCommandArg } from "./config-view.ts";
import { buildDelegationSection, DELEGATION_SECTION } from "./delegation.ts";
import { buildToolDeclaration, type ToolDeclaration } from "./tool-declaration.ts";
import { claimGuard, currentGuard, releaseGuard } from "./run-guard.ts";
import { formatProgress, progressDetails } from "./card/progress.ts";
import { composeResult } from "./run.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";

/** How often a running child re-announces itself, even when it emitted no event. */
const PROGRESS_TICK_MS = 2000;

/**
 * The declaration in force: the model-facing strings of this tool, rebuilt from the config's `subagent.tool`
 * overrides and the *effective* role table.
 *
 * It is rebuilt at every `before_agent_start` — the one place that knows both the real cwd and the real trust
 * level, and where the config is already loaded — because pi snapshots a registered tool's `description`,
 * `promptSnippet` and `promptGuidelines` when the extension loads. A role the human added after that load is
 * callable either way (the schema takes a string, `execute` validates it against the table), and this holder is
 * what makes it *visible* in the prose without a restart. `loadSubagentLimits` is mtime-cached, so this costs
 * nothing when the file did not change. What still speaks the load-time text is the `role` parameter's schema and
 * any prompt read outside a run (`session.systemPrompt`), which is why the parameter lists no default and the
 * description repeats the list.
 */
let declaration = renderDeclaration();

/** Build the declaration from a loaded config: the overrides, over the shipped text, over this table. */
function declare(loaded: Pick<LoadedLimits, "limits" | "effectiveRoles">): ToolDeclaration {
	return buildToolDeclaration({ roles: loaded.effectiveRoles, defaultRole: loaded.limits.defaultRole }, loaded.limits.tool);
}

/**
 * Read the config and build the declaration. Everything is inside the `try`, including `process.cwd()` and
 * `getAgentDir()`: this runs at module load, and an extension whose import throws registers nothing at all.
 * The fallback is the shipped text over the built-in table, which is what a machine with no config gets.
 */
function renderDeclaration(cwd?: string, trusted = false): ToolDeclaration {
	try {
		return declare(loadSubagentLimits(cwd ?? process.cwd(), trusted));
	} catch {
		return buildToolDeclaration({ roles: applyRoleConfig(undefined).roles, defaultRole: DEFAULT_ROLE_NAME });
	}
}

/**
 * Where a registered tool may put a description it rebuilt after registration: pi applies `prepareLoadout` to the
 * declared tools of every request, so a description here replaces the one the process registered
 * (`agent-session.js::_applyToolLoadout`).
 */
function applyDeclaredDescription(_loadout: ToolLoadout): ToolLoadoutChanges {
	return { descriptions: { subagent: declaration.description } };
}

type ToolArgs = Static<typeof parameters>;

const parameters = Type.Object({
	// Optional on purpose. A required role made every unnamed call a schema error, which teaches a model
	// that this tool is fragile; an unnamed call now gets the configured default role, visibly, in the card.
	//
	// A string, not an enum: the legal names come from the config (`subagent.roles`), which is read per call,
	// while a registered schema is fixed for the process — a stale enum would refuse a role the human had just
	// added. `execute` refuses a name no role answers to and lists the ones that do. Built-ins stay in the
	// description, which is where a model actually looks — rendered from the table, never hand-written.
	role: Type.Optional(Type.String({ description: declaration.roleParameterDescription })),
	task: Type.String({ description: "Self-contained brief; the child sees no conversation history, so put every file path, symbol and constraint in the text" }),
});

/**
 * Canonicalize a role the model spelled loosely ("Explore", "general purpose", "gp"). An unknown word is
 * left alone on purpose: the schema then rejects it and names the allowed values, which beats silently
 * running some role the model never asked for.
 */
export function prepareRoleArgs(args: unknown): ToolArgs {
	const raw = args as { role?: unknown } | undefined;
	if (!raw || typeof raw !== "object" || typeof raw.role !== "string") return args as ToolArgs;
	const name = canonicalRole(raw.role);
	return name ? ({ ...raw, role: name } as ToolArgs) : (args as ToolArgs);
}

/** The part of the prompt options this helper touches (structural, so the real event type fits). */
interface PromptSectionsLike {
	sections: Record<string, string>;
	/** Deliberately not consulted: see the function's comment. */
	customPrompt?: string;
	forceSystemPrompt?: string;
}

interface PromptDeclarationLike extends PromptSectionsLike {
	/** One-line `<available_tools>` entries, keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** `<rules>` bullets contributed by each tool, keyed by tool name. */
	toolGuidelines?: Record<string, string[]>;
}

/**
 * Put this run's declaration into the prompt options: pi snapshots `promptSnippet`/`promptGuidelines` at
 * registration (`agent-session.js::_toolPromptSnippets`), and the options are the mutable copy of that snapshot,
 * read again when the sections are built — which happens after `before_agent_start` returns.
 *
 * Only the two prompt fields travel this way. The tool *description* goes through `prepareLoadout` (it is part of
 * the declaration, not the prompt), and the `role` parameter's schema text goes through neither: a registered
 * schema is fixed for the process, which is why its role list is rendered once at load and repeated, current,
 * in the description.
 */
export function applyToolPromptDeclaration(options: PromptDeclarationLike, current: ToolDeclaration): void {
	options.toolSnippets = { ...(options.toolSnippets ?? {}), subagent: current.promptSnippet };
	options.toolGuidelines = { ...(options.toolGuidelines ?? {}), subagent: current.promptGuidelines };
}

/**
 * Add, or take away, the `<delegation>` section of this run's system prompt.
 *
 * It is the only place the *reason* to delegate outlives the tool description: pi renders `promptGuidelines`
 * as flat bullets at the tail of `<rules>`, beside every other tool's mechanics, which states what a tool is
 * and never why to reach for it.
 *
 * A `customPrompt` does not suppress it. pi renders a custom prompt as the `preamble` section and still
 * appends the addendum, project context, skills and cwd after it — a prompt package replaces pi's own
 * preamble, it does not ask for silence from everything else. Measured on a machine with the
 * `pi-system-prompt` package installed: skipping on `customPrompt` meant this section never arrived at all,
 * which is the opposite of the point. `forceSystemPrompt` is different: that is a handler's exact full text
 * for the turn, and adding a section to it would be arguing with the human who set it.
 */
export function applyDelegationSection(
	options: PromptSectionsLike,
	limits: { enabled: boolean; delegationPrompt: boolean; defaultRole: RoleId },
	roles?: RoleTable,
): string {
	if (!limits.enabled || !limits.delegationPrompt || options.forceSystemPrompt) {
		delete options.sections[DELEGATION_SECTION];
		return "";
	}
	const text = buildDelegationSection({ defaultRole: limits.defaultRole, roles });
	options.sections[DELEGATION_SECTION] = text;
	return text;
}

export default function piSubagent(pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "subagent",
		// The three strings below are the shipped defaults unless `subagent.tool` rewords them, and their role
		// lists come from the role table rather than from prose (`tool-declaration.ts`).
		description: declaration.description,
		promptSnippet: declaration.promptSnippet,
		promptGuidelines: declaration.promptGuidelines,
		parameters,
		prepareArguments: prepareRoleArgs,
		prepareLoadout: applyDeclaredDescription,
		executionMode: "sequential",
		// The tool draws its own call title and result block, so the report is rendered instead of
		// falling back to the raw result text (see render.ts).
		renderCall: (args, theme, context) => renderSubagentCall(args, theme, { argsComplete: context?.argsComplete }),
		renderResult: (result, options, theme) => renderSubagentResult(result, options, theme),

		async execute(toolCallId, args, signal, onUpdate, ctx) {
			if (!ctx.model) throw new Error("pi-subagent: no model is selected for this session");

			const loaded = loadSubagentLimits(ctx.cwd, ctx.isProjectTrusted());
			for (const error of loaded.errors.slice(0, 2)) ctx.ui.notify(`[subagent] ${error}`, "warning");
			const limits = loaded.limits;
			if (!limits.enabled) throw new Error("pi-subagent is disabled: set \"subagent\": { \"enabled\": true } in the config file");

			// An unnamed call gets the human's configured default, never a guess about the task text: only the
			// model knows the intent, and it just declined to choose. `roleDefaulted` is carried so the card admits it.
			// The table is the effective one, so a role added under `subagent.roles` is callable the same way.
			const roles = loaded.effectiveRoles;
			const { role, roleDefaulted: defaulted } = resolveCallRole(args.role, limits.defaultRole, roles);
			if (!role) {
				throw new Error(`pi-subagent: role "${String(args.role)}" names no role; use one of ${Object.keys(roles).join(", ")} (or omit it for "${limits.defaultRole}")`);
			}
			setConfiguredDefaultRole(limits.defaultRole);
			const budget = effectiveBudget(role, limits);
			const roleForRun = { ...role, maxTurns: budget.turns, timeoutMinutes: budget.minutes };

			// Child model: the session's model, unless the human pinned subagent.model in the config.
			const pin = resolveModelPin(limits.model, ctx.modelRegistry, ctx.model, (text) => ctx.ui.notify(text, "warning"));
			const model = pin.model;
			const overridden = pin.overridden;

			const controller = new AbortController();
			const parentSignal = signal ?? ctx.signal;
			if (parentSignal?.aborted) controller.abort();
			else parentSignal?.addEventListener("abort", () => controller.abort(), { once: true });

			claimGuard({ callId: toolCallId, role: role.name, defaulted, startedAt: Date.now(), abort: () => controller.abort() });

			// The ceiling itself is enforced where the nested calls actually run (`child.ts`, on the child's own
			// tool counter); the parent only tallies to report the number on the card.
			const tally = { calls: 0 };
			const host: ShimHost = {
				parentCallId: toolCallId,
				executeTool: ctx.executeTool,
				onNestedCall: () => {
					tally.calls++;
				},
			};
			const shims = buildShims(ctx.tools, roleForRun, host, limits);
			const shimNames = shims.map((shim) => shim.name);
			// The child's own model, thinking level and sampling params — decided where it has always been decided,
			// after the guard is claimed (see child-request.ts for why the two halves are not one call).
			const childRequest = resolveChildRequest({
				role: roleForRun,
				sessionModel: model,
				overridden,
				sessionThinkingLevel: ctx.thinkingLevel ?? "off",
				onWarning: (text) => ctx.ui.notify(text, "warning"),
			});
			const childModel = childRequest.label;
			const childLevel = childRequest.thinkingLevel;
			const thinkingText = childRequest.thinking;
			const samplingText = childRequest.sampling;
			const startedAt = Date.now();
			// A granted extension goes on the live card, so a run that got more rope looks like one.
			let ceiling: CeilingReport | undefined;
			let latest: RunProgress = { turns: 0, toolCalls: 0, elapsedMs: 0 };
			let lastEmitAt = 0;
			const emitProgress = (force = false) => {
				if (!onUpdate) return;
				const now = Date.now();
				if (!force && now - lastEmitAt < PROGRESS_TICK_MS) return;
				lastEmitAt = now;
				onUpdate({
					content: [{ type: "text", text: formatProgress(latest, shims.length) }],
					details: progressDetails(latest, {
						role: role.name,
						roleDefaulted: defaulted,
						task: args.task,
						model: childModel,
						thinking: thinkingText,
						sampling: samplingText,
						shimTools: shimNames,
						nestedCalls: tally.calls,
						ceiling,
					}),
				});
			};
			// A child that thinks for minutes without a tool event must still be heard from, or its card
			// sits on a "no activity" placeholder for the whole run.
			const heartbeat = setInterval(() => emitProgress(true), PROGRESS_TICK_MS);
			heartbeat.unref?.();

			// A spent budget is a question before it is a verdict: one dialog per run, and only an explicit "Extend"
			// answer raises it. Switched off, or with no UI, nothing is asked and the ceiling lands exactly as it did
			// before this existed.
			const onCeiling = limits.askToExtend
				? createCeilingBroker({
						hasUI: ctx.hasUI,
						ui: ctx.ui,
						signal: controller.signal,
						onOutcome: (reason, answer) => {
							if (answer.outcome !== "granted" || !answer.grant) return;
							ceiling = { reason, outcome: "granted", turns: answer.grant.turns, minutes: answer.grant.minutes };
							emitProgress(true);
						},
					})
				: undefined;

			try {
				const result = await runChild({
					role: roleForRun,
					task: args.task,
					cwd: ctx.cwd,
					agentDir: getAgentDir(),
					model: childRequest.model,
					thinkingLevel: childLevel,
					tools: shims,
					sessionDir: ctx.sessionManager.getSessionDir(),
					signal: controller.signal,
					onCeiling,
					onProgress: (progress) => {
						latest = progress;
						emitProgress();
					},
				});
				const removed = await pruneTranscripts(childSessionDir(ctx.sessionManager.getSessionDir()), limits.keepTranscripts);
				return composeResult(result, role.name, limits.maxResultBytes, Date.now() - startedAt, {
					removedTranscripts: removed,
					nestedCalls: tally.calls,
					shimTools: shimNames,
					model: childModel,
					thinking: thinkingText,
					sampling: samplingText,
					task: args.task,
					roleDefaulted: defaulted,
					activity: latest.lastTool ?? "reported",
				});
			} finally {
				clearInterval(heartbeat);
				releaseGuard(toolCallId);
			}
		},
	});

	// Hidden from the model when the config turns the extension off — a tool the human cannot answer
	// for should not be offered at all.
	pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
		const loaded = loadSubagentLimits(ctx.cwd, ctx.isProjectTrusted());
		// Refresh the declaration before anything below can change the active tools, so the loadout hook and the
		// prompt sections of this run both speak of the table this cwd actually has.
		// A process-global holder: `prepareLoadout` is handed the tool set, never a cwd. Same shape as
		// `setConfiguredDefaultRole` below, and one session per process is what pi gives us.
		declaration = declare(loaded);
		const active = pi.getActiveTools();
		const has = active.includes("subagent");
		if (!loaded.limits.enabled && has) pi.setActiveTools(active.filter((name) => name !== "subagent"));
		else if (loaded.limits.enabled && !has && pi.getAllTools().some((tool) => tool.name === "subagent")) {
			pi.setActiveTools([...active, "subagent"]);
		}
		setConfiguredDefaultRole(loaded.limits.defaultRole);
		applyDelegationSection(event.systemPromptOptions, loaded.limits, loaded.effectiveRoles);
		applyToolPromptDeclaration(event.systemPromptOptions, declaration);
	});

	pi.on("session_shutdown", () => {
		currentGuard()?.abort();
	});

	/**
	 * `/subagentc` — the subagent config as it actually applies, because the interesting part of this
	 * extension is invisible otherwise: which model a child runs on, and where that value was set.
	 * `status` keeps the old "what is running" answer, which is only ever informative during a run.
	 */
	pi.registerCommand("subagentc", {
		description: "Subagent config: (all) | model | limits | roles | status | models — the model a child runs on, effective limits, roles, pins",
		getArgumentCompletions: (argumentPrefix: string) => {
			if (argumentPrefix.includes(" ")) return null; // one argument only
			return COMMAND_ARGS.filter((name) => name.startsWith(argumentPrefix)).map((value) => ({ value, label: value }));
		},
		async handler(args: string, ctx: ExtensionContext) {
			const [raw = "all"] = args.trim().split(/\s+/).filter(Boolean);
			const section = raw.toLowerCase() as SubagentCommandArg;
			if (!COMMAND_ARGS.includes(section)) {
				ctx.ui.notify(`[subagent] unknown section "${raw}" (expected ${COMMAND_ARGS.join(", ")})`, "warning");
				return;
			}
			const loaded = loadSubagentLimits(ctx.cwd, ctx.isProjectTrusted());
			if (section === "models") {
				const pin = loaded.limits.model ? resolveChildModel(loaded.limits.model, ctx.modelRegistry, ctx.model) : undefined;
				await ctx.ui.editor(
					"pi-subagent models",
					buildModelCatalog(ctx.modelRegistry.getAll(), {
						sessionModel: ctx.model,
						pinnedRef: pin?.status === "resolved" ? pin.ref : undefined,
						available: new Set(ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`)),
					}),
				);
				return;
			}
			if (section === "status") {
				ctx.ui.notify(`[subagent] ${formatRunning(currentGuard())}`, "info");
				return;
			}
			const reference = loaded.limits.model;
			await ctx.ui.editor(
				`pi-subagent ${section}`,
				buildConfigView(
					{
						limits: loaded.limits,
						origins: loaded.origins,
						effectiveRoles: loaded.effectiveRoles,
						roleOrigins: loaded.roleOrigins,
						toolOrigins: loaded.toolOrigins,
						files: loaded.files,
						defaultConfigFile: join(getAgentDir(), "extensions", EXTENSION_CONFIG_SLUG, "config.json"),
						errors: loaded.errors,
						cwd: ctx.cwd,
						trusted: ctx.isProjectTrusted(),
						sessionModel: ctx.model,
						thinkingLevel: ctx.thinkingLevel,
						pin: reference ? { reference, resolution: resolveChildModel(reference, ctx.modelRegistry, ctx.model) } : undefined,
						parentTools: pi.getActiveTools(),
						sessionDir: ctx.sessionManager.getSessionDir(),
						running: currentGuard(),
					},
					section,
				),
			);
		},
	});
}
