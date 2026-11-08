import { type ExtensionContext, type SessionBoundaryDraft, type TurnEndEvent, type TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { type GuardLogEntry, defaultGuardLogPath, guardLog } from "../log.ts";
import { type GuardAction, type GuardConfig } from "../config-contract/guard-section.ts";
import { type Policy } from "../policy-resolution/call-decision.ts";

/**
 * The `turn_end` pipeline: decide whether this turn is the one the guard may read, and turn a hit into a
 * `continue` plus the message that makes the continuation runnable.
 */

import { GUARD_MESSAGE_TYPE, REMINDABLE_STOP_REASONS, REMINDER_MEMORY_LIMIT } from "./guard-limits.ts";
import { detectMalformedCall } from "./detection.ts";
import { guardNotice, reminderText } from "./reminder-copy.ts";
import { type GuardBudget } from "./session-budget.ts";

export interface GuardTurnState {
	policy: Policy;
	/** `pi.getActiveTools()`, lowercased — the names `matchToolNames` recognises. */
	toolNames: ReadonlySet<string>;
	budget: GuardBudget;
}

export interface GuardTurnDeps {
	guardLog?: typeof guardLog;
	logPath?: () => string;
	now?: () => Date;
}

/**
 * The action for this turn. A session override wins over the config in both directions, including over
 * `enabled: false`: the human who just typed `/gatec guard remind` means it, and there is no other way to ask
 * of a config that switched the guard off. `/gatec guard off` is the answer back.
 */
export function effectiveGuardAction(config: GuardConfig, budget: GuardBudget): GuardAction {
	return budget.action ?? (config.enabled ? config.action : "off");
}

/** The assistant message a turn ends on — `turn_end` always carries one, but `AgentMessage` is a union. */
type GuardedMessage = Extract<TurnEndEvent["message"], { role: "assistant" }>;

/** Text blocks of a finished message, joined. */
export function assistantText(message: GuardedMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n");
}

function assistantThinking(message: GuardedMessage): string {
	const content = message.content;
	if (typeof content === "string") return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "thinking") parts.push(block.thinking);
	}
	return parts.join("\n");
}

/**
 * The `turn_end` hook: guard the message the model just finished, and only when the run would otherwise end
 * on it.
 *
 * Skipped, in order: every form of "off" (`--no-gate`, `/gatec off`, `gate.guard.enabled=false`,
 * `action:"off"`); a turn that ran tools, because that model already has a tool result to read and the run is
 * continuing anyway; an aborted or errored turn, because a human pressed Escape or the provider failed, and
 * neither is the model's mistake to correct; a message already reminded; and a spent reminder budget.
 */
export function guardTurnEnd(event: TurnEndEvent, ctx: ExtensionContext, state: GuardTurnState, deps: GuardTurnDeps = {}): TurnEndEventResult | undefined {
	const config = state.policy.config.guard;
	const action = effectiveGuardAction(config, state.budget);
	if (action === "off") return undefined;
	if (event.outcome !== "completed") return undefined;
	if (event.toolResults.length > 0) return undefined;
	const message = event.message;
	if (message.role !== "assistant") return undefined;
	if (!REMINDABLE_STOP_REASONS.has(message.stopReason)) return undefined;
	if (state.budget.seen.has(event.messageEntryId)) return undefined;

	const hit = detectMalformedCall({
		text: assistantText(message),
		thinking: assistantThinking(message),
		toolNames: state.toolNames,
		config,
		sessionDisabled: state.budget.disabled,
	});
	if (!hit) return undefined;

	const budget = state.budget;
	const spend = action === "remind" && budget.reminders < config.maxReminders;
	budget.last = { rules: hit.rules, label: hit.label };
	if (spend) {
		budget.reminders++;
		budget.seen.add(event.messageEntryId);
		if (budget.seen.size > REMINDER_MEMORY_LIMIT) {
			const oldest = budget.seen.values().next();
			if (!oldest.done) budget.seen.delete(oldest.value);
		}
	}

	const appendLog = deps.guardLog ?? guardLog;
	const logPath = deps.logPath?.() ?? defaultGuardLogPath();
	const entry: GuardLogEntry = {
		ts: (deps.now ?? (() => new Date()))().toISOString(),
		kind: "malformed-tool-call",
		rules: hit.rules,
		label: hit.label,
		evidence: hit.evidence,
		action: spend ? "remind" : action,
		turnIndex: event.turnIndex,
		stopReason: message.stopReason,
		model: message.model,
		reminders: budget.reminders,
	};
	void appendLog(logPath, entry);

	ctx.ui.notify(guardNotice(hit, action), "warning");
	if (!spend) {
		if (action === "remind") {
			ctx.ui.notify(`[gate] reminder budget spent (${config.maxReminders}) — leaving the run alone; raise gate.guard.maxReminders or run /gatec guard reset`, "warning");
		}
		return undefined;
	}

	const entries: SessionBoundaryDraft[] = [
		{
			type: "custom_message",
			customType: GUARD_MESSAGE_TYPE,
			content: [{ type: "text", text: reminderText(hit, message.stopReason === "length") }],
			display: true,
			details: { rules: hit.rules, label: hit.label, evidence: hit.evidence, turnIndex: event.turnIndex },
		},
	];
	// `continue` is Pi's boundary answer for "run another turn", and the appended message is what makes the
	// continuation runnable: a context ending on an assistant message is not.
	return { entries, continue: true };
}
