/**
 * The `tool_call` decision pipeline, separated from the extension wiring so it can be tested with a
 * stubbed UI and a throwing extractor (plan steps 8, 9, FM-5).
 *
 * Every outcome except an explicit allow blocks: `deny` from policy, an abort, a dismissed or timed
 * out dialog, no UI at all, or an internal error.
 */

import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { extract, type Facts } from "./inspect.ts";
import {
	ALLOW_ALL_WINDOW_MS,
	allowAllActive,
	allowAllBypasses,
	blockReason,
	evaluate,
	type AllowAll,
	type Decision,
	type Policy,
	withSessionGrants,
} from "./policy.ts";
import { appendPersisted, appendSession, type PersistedScope, type WriteResult } from "./grants.ts";
import { ask, type AskResult } from "./prompt.ts";
import { defaultLogPath, redact, reviewLog } from "./log.ts";
import { displaySnippet } from "./match.ts";
import type { GrantRule } from "./schema.ts";

export interface GateState {
	policy: Policy;
	sessionGrants: GrantRule[];
	/** "Allow everything" mode, set from the dialog; `undefined` when every call is judged normally. */
	allowAll: AllowAll | undefined;
	/** callId → what the `subagent(...)` call asked for, so nested dialogs can name their owner. */
	subagentCalls: Map<string, { role: string; task: string }>;
	/** Called after a grant changes the effective policy: reload + recompute active tools (step 9). */
	policyChanged: (policy: Policy) => void;
	/** Called when the human turns "allow everything" on or off, so the entry point can show and time it. */
	allowAllChanged?: (allowAll: AllowAll) => void;
}

export interface GateDeps {
	extract?: (toolName: string, input: Record<string, unknown>, cwd: string, call: { callId: string; parentCallId?: string }) => Facts;
	ask?: typeof ask;
	appendPersisted?: typeof appendPersisted;
	reviewLog?: typeof reviewLog;
	logPath?: () => string;
	/** Injectable so the timed window is testable. */
	now?: () => number;
}

export const OBSERVED_CALL_LIMIT = 64;

export function observeSubagentCall(state: GateState, event: ToolCallEvent): void {
	if (event.toolName !== "subagent") return;
	const input = (event.input ?? {}) as Record<string, unknown>;
	if (typeof input.task !== "string") return;
	if (state.subagentCalls.size >= OBSERVED_CALL_LIMIT) {
		const oldest = state.subagentCalls.keys().next();
		if (!oldest.done) state.subagentCalls.delete(oldest.value);
	}
	state.subagentCalls.set(event.toolCallId, { role: String(input.role ?? "?"), task: input.task });
}

export function subagentOwner(state: GateState, parentToolCallId?: string): { role: string; task: string } | undefined {
	if (!parentToolCallId) return undefined;
	const root = parentToolCallId.split("/")[0]!;
	return state.subagentCalls.get(root) ?? state.subagentCalls.get(parentToolCallId);
}

export async function handleToolCall(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	state: GateState,
	deps: GateDeps = {},
): Promise<ToolCallEventResult | undefined> {
	const extractFn = deps.extract ?? extract;
	const askFn = deps.ask ?? ask;
	const writePersisted = deps.appendPersisted ?? appendPersisted;
	const appendLog = deps.reviewLog ?? reviewLog;
	const logPath = deps.logPath?.() ?? defaultLogPath();
	const now = deps.now ?? (() => Date.now());

	try {
		observeSubagentCall(state, event);
		const policy = state.policy;
		if (!policy.config.enabled) return;

		const facts = extractFn(event.toolName, (event.input ?? {}) as Record<string, unknown>, ctx.cwd, {
			callId: event.toolCallId,
			parentCallId: event.parentToolCallId,
		});
		const decision = evaluate(facts, policy);
		const sub = subagentOwner(state, event.parentToolCallId);

		if (decision.action === "allow") {
			if (policy.config.reviewLog) await logit(appendLog, logPath, policy, decision, "allow", sub);
			return;
		}
		if (decision.action === "deny") {
			await logit(appendLog, logPath, policy, decision, "deny", sub);
			return { block: true, reason: blockReason(decision, "policy_deny") };
		}

		// "Allow everything" silences every approval but the hard ones — the gate's own config, pi's config
		// files, git hooks, and a config too broken to read. Those reach the dialog with the reason in the title.
		const bypassing = allowAllActive(state.allowAll, now()) && allowAllBypasses(decision);
		if (bypassing) {
			await logit(appendLog, logPath, policy, decision, "allow_all", sub);
			return;
		}

		if (!ctx.hasUI) {
			await logit(appendLog, logPath, policy, decision, "no_ui", sub);
			return { block: true, reason: blockReason(decision, "no_ui") };
		}

		const answer: AskResult = await askFn(ctx, decision, {
			cwd: ctx.cwd,
			signal: ctx.signal,
			timeoutMs: policy.config.promptTimeoutMs,
			sub,
			note: allowAllNote(state.allowAll, now()),
		});
		await logit(appendLog, logPath, policy, decision, answer.choice, sub);

		switch (answer.choice) {
			case "once":
				return;
			case "session": {
				if (decision.grant) appendSession(state.sessionGrants, decision.grant);
				state.policyChanged(withSessionGrants(policy, state.sessionGrants));
				return;
			}
			case "project":
			case "global": {
				const scope: PersistedScope = answer.choice;
				if (decision.grant) {
					const written: WriteResult = await writePersisted(decision.grant, scope, ctx.cwd);
					if (!written.ok) ctx.ui.notify(`[gate] could not save the grant to ${written.file}: ${written.error}`, "error");
				}
				state.policyChanged(withSessionGrants(policy, state.sessionGrants));
				return;
			}
			case "all_session":
				setAllowAll(state, { until: null });
				ctx.ui.notify("[gate] allow-everything is ON for this session — the footer shows it, /gate allow off stops it", "warning");
				return;
			case "all_timed":
				setAllowAll(state, { until: now() + ALLOW_ALL_WINDOW_MS });
				ctx.ui.notify(`[gate] allow-everything is ON for ${Math.round(ALLOW_ALL_WINDOW_MS / 60_000)} minutes — /gate allow off stops it sooner`, "warning");
				return;
			case "abort_reason":
				return { block: true, reason: blockReason(decision, "user_abort", redact(answer.reason ?? "")) };
			case "abort":
			default:
				return { block: true, reason: blockReason(decision, "user_abort") };
		}
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		return { block: true, reason: `[gate] internal error: ${message}. The call was blocked (fail closed); run /gate status.` };
	}
}

export function setAllowAll(state: GateState, allowAll: AllowAll): void {
	state.allowAll = allowAll;
	state.allowAllChanged?.(allowAll);
}

/** Tells the human, inside the dialog, why they are still being asked while "allow everything" is on. */
export function allowAllNote(allowAll: AllowAll | undefined, now: number): string | undefined {
	if (!allowAll || !allowAllActive(allowAll, now)) return undefined;
	const scope = allowAll.until === null ? "for this session" : "until this window ends";
	return (
		"[gate] allow-everything is ON " +
		scope +
		": only the gate's own config, pi's config files and git hooks still ask, because those could switch the gate off. " +
		"`/gate off` silences the gate itself for this run."
	);
}

async function logit(
	appendLog: typeof reviewLog,
	path: string,
	policy: Policy,
	decision: Decision,
	resolution: string,
	sub: { role: string; task: string } | undefined,
): Promise<void> {
	if (!policy.config.reviewLog) return;
	await appendLog(path, {
		ts: new Date().toISOString(),
		callId: decision.facts.callId,
		parentCallId: decision.facts.parentCallId,
		toolName: decision.facts.toolName,
		surface: decision.matched?.surface ?? decision.facts.toolName,
		pattern: decision.matched?.pattern,
		scope: decision.matched?.scope,
		resolution,
		preview: redact(displaySnippet(JSON.stringify({ surfaces: decision.facts.surfaces, paths: decision.facts.paths }))),
		sub: sub ? { role: sub.role, taskExcerpt: displaySnippet(sub.task, 160) } : undefined,
		floors: decision.floors,
	});
}
