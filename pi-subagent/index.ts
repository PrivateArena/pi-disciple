/**
 * pi-subagent — one blocking `subagent(role, task)` tool (plan steps 15 and 16).
 *
 * Two parameters only: a model-chosen tool list or timeout would be a privilege-escalation
 * primitive, and roles are hard-coded (see the plan's key decisions). The call blocks until the child
 * finishes, returns its final message, and reports the child's token usage so pi folds it into the
 * footer and `/session` totals.
 *
 * Permission checks are not implemented here at all: the child's tools are shims onto the parent's
 * `ctx.executeTool()`, so every nested call runs in the parent's tool pipeline, where pi-gate lives.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import { ROLE_ORDER, resolveRole } from "./roles.ts";
import { buildShims, NESTED_CALL_CEILING, type ShimHost } from "./shims.ts";
import { childSessionDir, pruneTranscripts, runChild } from "./child.ts";
import { loadSubagentLimits } from "./config-file.ts";
import { childThinkingLevel, modelLabel, resolveChildModel } from "./model-override.ts";
import { buildConfigView, buildModelCatalog, COMMAND_ARGS, formatRunning, type SubagentCommandArg } from "./config-view.ts";
import { claimGuard, composeResult, currentGuard, formatProgress, progressDetails, releaseGuard } from "./run.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import type { RunProgress } from "./child.ts";

/** How often a running child re-announces itself, even when it emitted no event. */
const PROGRESS_TICK_MS = 2000;

const parameters = Type.Object({
	role: StringEnum([...ROLE_ORDER], {
		description: "explore = read-only survey, general-purpose = parent's full tool set, review = critique only",
	}),
	task: Type.String({ description: "Self-contained brief; the child sees no conversation history, so put every file path in the text" }),
});

export default function piSubagent(pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "subagent",
		description:
			"Run a one-shot subagent in an isolated context and wait for its answer. One child at a time; the call blocks until it " +
			"finishes. The child's tool calls go through this session's permission checks, so a denial reaches the child as an error.",
		promptSnippet: "Run a one-shot subagent with an isolated context",
		promptGuidelines: [
			"Use subagent for open-ended search or review; the call blocks until it finishes",
			"subagent(role, task) — role: explore (read-only survey), general-purpose (full tools), review (critique only)",
		],
		parameters,
		executionMode: "sequential",
		// The tool draws its own call title and result block, so the report is rendered instead of
		// falling back to the raw result text (see render.ts).
		renderCall: (args, theme) => renderSubagentCall(args, theme),
		renderResult: (result, options, theme) => renderSubagentResult(result, options, theme),

		async execute(toolCallId, args, signal, onUpdate, ctx) {
			const role = resolveRole(args.role);
			if (!role) throw new Error(`pi-subagent: unknown role "${args.role}" (expected one of ${ROLE_ORDER.join(", ")})`);
			if (!ctx.model) throw new Error("pi-subagent: no model is selected for this session");

			const loaded = loadSubagentLimits(ctx.cwd, ctx.isProjectTrusted());
			for (const error of loaded.errors.slice(0, 2)) ctx.ui.notify(`[subagent] ${error}`, "warning");
			const limits = loaded.limits;
			if (!limits.enabled) throw new Error("pi-subagent is disabled: set \"subagent\": { \"enabled\": true } in the config file");
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

			claimGuard({ callId: toolCallId, role: role.name, startedAt: Date.now(), abort: () => controller.abort() });

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
					details: progressDetails(latest, { role: role.name, task: args.task, model: childModel, shimTools: shimNames, nestedCalls: tally.calls }),
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
	pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
		const loaded = loadSubagentLimits(ctx.cwd, ctx.isProjectTrusted());
		const active = pi.getActiveTools();
		const has = active.includes("subagent");
		if (!loaded.limits.enabled && has) pi.setActiveTools(active.filter((name) => name !== "subagent"));
		else if (loaded.limits.enabled && !has && pi.getAllTools().some((tool) => tool.name === "subagent")) {
			pi.setActiveTools([...active, "subagent"]);
		}
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
