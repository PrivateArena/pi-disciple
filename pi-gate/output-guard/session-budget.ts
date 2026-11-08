import { type GuardAction } from "../config-contract/guard-section.ts";

/**
 * Session state of the guard: what was already answered, how much reminder rope is left, and the two
 * resets (`session_start`, `/gatec`) that own it.
 */

/**
 * Session state for the guard: what was already answered and how much rope is left. Owned by the entry point
 * so `session_start` can clear it and `/gatec` can show and change it.
 */
export interface GuardBudget {
	/** Reminders sent this session, against `gate.guard.maxReminders`. */
	reminders: number;
	/** Entry ids already reminded — one nudge per assistant message. */
	seen: Set<string>;
	/** Rule ids the human switched off for this session. */
	disabled: Set<string>;
	/** Session override of `gate.guard.action`. */
	action?: GuardAction;
	/** The last hit, for `/gatec` and the footer. */
	last?: { rules: string[]; label: string };
}

export function createGuardBudget(): GuardBudget {
	return { reminders: 0, seen: new Set(), disabled: new Set() };
}

/** A real tool call means the model can call tools: the nudge budget is for the current trouble, not for the session. */
export function refillGuardBudget(budget: GuardBudget): void {
	budget.reminders = 0;
}

/** `/gatec guard reset`: the counters only — what the human switched off stays switched off. */
export function resetGuardCounters(budget: GuardBudget): void {
	budget.reminders = 0;
	budget.seen.clear();
	budget.last = undefined;
}

/** A new session: nothing carries over, including the human's session overrides of action and rules. */
export function resetGuardSession(budget: GuardBudget): void {
	resetGuardCounters(budget);
	budget.disabled.clear();
	budget.action = undefined;
}
