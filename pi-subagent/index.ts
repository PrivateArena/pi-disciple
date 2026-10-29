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

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { canonicalRole, type RoleId, resolveCallRole, ROLE_ORDER, setConfiguredDefaultRole, type RoleTable } from "./roles.ts";
import { buildShims, NESTED_CALL_CEILING, type ShimHost } from "./shims.ts";
import { childSessionDir, pruneTranscripts, runChild } from "./child.ts";
import { loadSubagentLimits } from "./config-file.ts";
import { childThinkingLevel, modelLabel, resolveChildModel } from "./model-override.ts";
import { buildConfigView, buildModelCatalog, COMMAND_ARGS, formatRunning, type SubagentCommandArg } from "./config-view.ts";
import { buildDelegationSection, DELEGATION_SECTION } from "./delegation.ts";
import { claimGuard, composeResult, currentGuard, formatProgress, progressDetails, releaseGuard } from "./run.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import type { RunProgress } from "./child.ts";

/** How often a running child re-announces itself, even when it emitted no event. */
const PROGRESS_TICK_MS = 2000;

type ToolArgs = Static<typeof parameters>;

const parameters = Type.Object({
	// Optional on purpose. A required role made every unnamed call a schema error, which teaches a model
	// that this tool is fragile; an unnamed call now gets the configured default role, visibly, in the card.
	//
	// A string, not an enum: the legal names come from the config (`subagent.roles`), which is read per call,
	// while a registered schema is fixed for the process — a stale enum would refuse a role the human had just
	// added. `execute` refuses a name no role answers to and lists the ones that do. Built-ins stay in the
	// description, which is where a model actually looks.
	role: Type.Optional(
		Type.String({
			description: `explore = read-only survey, general-purpose = the parent's own tool set, review = critique only${
				extraRoleHint() ? `, and subagent.roles in the config adds ${extraRoleHint()}` : ", plus any role the config defines under subagent.roles"
			}. Omit it for the configured default role. Any other name is refused, and the error lists the roles that exist.`,
		}),
	),
	task: Type.String({ description: "Self-contained brief; the child sees no conversation history, so put every file path, symbol and constraint in the text" }),
});

/** Role names beyond the built-ins that the global config adds, for the parameter description. */
function extraRoleHint(): string {
	try {
		return Object.keys(loadSubagentLimits(process.cwd(), false).effectiveRoles)
			.filter((name) => !ROLE_ORDER.some((builtIn) => builtIn === name))
			.join(", ");
	} catch {
		return "";
	}
}

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
		description:
			"Run a one-shot child session in an isolated context and wait for its answer. The child shares none of this conversation, and only " +
			"its final report comes back: the searching, reading and bulky output it produced never enters your context. That is what it is for. " +
			"Reach for it when an answer needs more than about three reads or greps, when a command's output is bulky and only its verdict matters, " +
			"for a bounded change you can describe completely, and for a review of work you just did — not for a single read or edit you can do " +
			"yourself. One child at a time; the call blocks until it finishes. The child's tool calls go through this session's permission checks, so a " +
			"denial reaches the child as an error.",
		promptSnippet: "Delegate open-ended search, surveys, bulky command output or a bounded sub-task to an isolated child session (saves context)",
		promptGuidelines: [
			"Prefer subagent(role, task) over reading many files inline: the child's report costs one message, its searches never enter your context",
			"The child sees none of this conversation: name every path, symbol and command in the task text, and say what shape the report should take",
			"role: explore (read-only survey), general-purpose (may edit; also what an unnamed call gets), review (findings only)",
		],
		parameters,
		prepareArguments: prepareRoleArgs,
		executionMode: "sequential",
		// The tool draws its own call title and result block, so the report is rendered instead of
		// falling back to the raw result text (see render.ts).
		renderCall: (args, theme, context) => renderSubagentCall(args, theme, { argsComplete: context?.argsComplete, expanded: context?.expanded }),
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
			const roleForRun = {
				...role,
				maxTurns: Math.min(role.maxTurns, limits.maxTurns),
				timeoutMinutes: Math.min(role.timeoutMinutes, limits.timeoutMinutes),
			};

			// Child model: the session's model, unless the human pinned subagent.model in the config.
			let model = ctx.model;
			let overridden = false;
			if (limits.model) {
				const resolved = resolveChildModel(limits.model, ctx.modelRegistry, ctx.model);
				if (resolved.status === "error") ctx.ui.notify(`[subagent] ${resolved.message} — running on the session model`, "warning");
				else {
					model = resolved.model;
					overridden = true;
				}
			}

			const controller = new AbortController();
			const parentSignal = signal ?? ctx.signal;
			if (parentSignal?.aborted) controller.abort();
			else parentSignal?.addEventListener("abort", () => controller.abort(), { once: true });

			claimGuard({ callId: toolCallId, role: role.name, defaulted, startedAt: Date.now(), abort: () => controller.abort() });

			const tally = { calls: 0, overCeiling: 0 };
			const host: ShimHost = {
				parentCallId: toolCallId,
				executeTool: ctx.executeTool,
				onNestedCall: () => {
					tally.calls++;
					if (tally.calls > NESTED_CALL_CEILING) tally.overCeiling++;
				},
			};
			const shims = buildShims(ctx.tools, roleForRun, host, limits);
			const shimNames = shims.map((shim) => shim.name);
			const childModel = modelLabel(model, overridden);
			const startedAt = Date.now();
			let latest: RunProgress = { turns: 0, toolCalls: 0, elapsedMs: 0 };
			let lastEmitAt = 0;
			const emitProgress = (force = false) => {
				if (!onUpdate) return;
				const now = Date.now();
				if (!force && now - lastEmitAt < PROGRESS_TICK_MS) return;
				lastEmitAt = now;
				onUpdate({
					content: [{ type: "text", text: formatProgress(latest, shims.length) }],
					details: progressDetails(latest, { role: role.name, roleDefaulted: defaulted, task: args.task, model: childModel, shimTools: shimNames, nestedCalls: tally.calls }),
				});
			};
			// A child that thinks for minutes without a tool event must still be heard from, or its card
			// sits on a "no activity" placeholder for the whole run.
			const heartbeat = setInterval(() => emitProgress(true), PROGRESS_TICK_MS);
			heartbeat.unref?.();

			try {
				const result = await runChild({
					role: roleForRun,
					task: args.task,
					cwd: ctx.cwd,
					agentDir: getAgentDir(),
					model: model,
					thinkingLevel: childThinkingLevel(model, ctx.thinkingLevel ?? "off"),
					tools: shims,
					sessionDir: ctx.sessionManager.getSessionDir(),
					signal: controller.signal,
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
		const active = pi.getActiveTools();
		const has = active.includes("subagent");
		if (!loaded.limits.enabled && has) pi.setActiveTools(active.filter((name) => name !== "subagent"));
		else if (loaded.limits.enabled && !has && pi.getAllTools().some((tool) => tool.name === "subagent")) {
			pi.setActiveTools([...active, "subagent"]);
		}
		setConfiguredDefaultRole(loaded.limits.defaultRole);
		applyDelegationSection(event.systemPromptOptions, loaded.limits, loaded.effectiveRoles);
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
						files: loaded.files,
						defaultConfigFile: join(getAgentDir(), "extensions", "pi-gate", "config.json"),
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
