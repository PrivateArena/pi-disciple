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
import { Type } from "typebox";
import { ROLE_ORDER, resolveRole } from "./roles.ts";
import { buildShims, NESTED_CALL_CEILING, type ShimHost } from "./shims.ts";
import { childSessionDir, pruneTranscripts, runChild } from "./child.ts";
import { loadSubagentLimits } from "./config-file.ts";
import { childThinkingLevel, modelLabel, resolveChildModel } from "./model-override.ts";
import { claimGuard, composeResult, currentGuard, formatProgress, releaseGuard, type SubagentDetails } from "./run.ts";

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
			const startedAt = Date.now();
			let lastEmitAt = 0;

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
						const now = Date.now();
						if (now - lastEmitAt < 1000) return;
						lastEmitAt = now;
						onUpdate?.({ content: [{ type: "text", text: formatProgress(progress, shims.length) }], details: {} as SubagentDetails });
					},
				});
				const removed = await pruneTranscripts(childSessionDir(ctx.sessionManager.getSessionDir()), limits.keepTranscripts);
				return composeResult(result, role.name, limits.maxResultBytes, Date.now() - startedAt, {
					removedTranscripts: removed,
					nestedCalls: tally.calls,
					shimTools: shims.map((shim) => shim.name),
					model: modelLabel(model, overridden),
				});
			} finally {
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

	pi.registerCommand("subagents", {
		description: "Show the running subagent, if any",
		async handler(_args, ctx: ExtensionContext) {
			const running = currentGuard();
			ctx.ui.notify(
				running
					? `subagent: ${running.role} running for ${Math.round((Date.now() - running.startedAt) / 1000)}s (call ${running.callId})`
					: "subagent: idle",
				"info",
			);
		},
	});
}
