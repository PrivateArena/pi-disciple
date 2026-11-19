/**
 * session-budget.ts — the ceiling answer a human gives once and means for every later run: "extend by 200 turns /
 * 50 min, and keep doing it this session".
 *
 * It exists because a delegation's size is not knowable from the role that guessed it. Without it the extension
 * question is asked again on the next call — the same question, with the same answer, to the same human, for as
 * long as they keep delegating. The permission gate solved the identical problem with session grants
 * (`pi-gate/grants.ts::createSessionGrants`) and this is the same trade: one explicit human choice, remembered in
 * process memory only, applied without asking, and gone when the session is.
 *
 * What it deliberately is not:
 * - **Not persisted.** Nothing here reaches a file, because a budget that survives a restart is a budget nobody
 *   agreed to in this session. `subagent.extendOptions` is the durable knob; this is the in-session one.
 * - **Not a ceiling removal.** It answers the question the clock already decided to ask, once per run at most —
 *   the clock's own one-offer rule (`budget/ceiling-clock.ts::offerSettled`) still bounds a single run.
 * - **Not a config layer.** It holds one rung, the last one a human chose, and applying it grants exactly that.
 *
 * A leaf module: the types come from `ceiling-vocabulary.ts`; `../ceiling.ts` is the only writer (its session
 * menu, and the `forget` choice beside it), while `../index.ts` shows and clears it (`/subagentc budget`) and keeps
 * it across the runs of one session.
 */

import type { CeilingGrant } from "./ceiling-vocabulary.ts";

/** The one rung this session was told to hand out at every spent budget, or `undefined` for "ask each run". */
export interface SessionBudget {
	/** What to grant without asking, or `undefined` when the question is still a question. A copy, so no caller can
	 * write through into what the next run will read. */
	get(): CeilingGrant | undefined;
	/** Remember this rung, replacing whatever was remembered. */
	set(grant: CeilingGrant): void;
	/** Go back to asking. Returns whether there was anything to forget. */
	clear(): boolean;
}

/** One remembered rung per store; the store is per session, see {@link currentSessionBudget}. */
export function createSessionBudget(): SessionBudget {
	let remembered: CeilingGrant | undefined;
	return {
		get: () => (remembered ? { ...remembered } : undefined),
		set: (grant) => {
			// Copied, so a caller's rung (a rung of the shipped ladder, or one from a config array) cannot be
			// written through into the remembered figure later.
			remembered = { turns: grant.turns, minutes: grant.minutes };
		},
		clear: () => {
			const had = remembered !== undefined;
			remembered = undefined;
			return had;
		},
	};
}

/**
 * The store for this process, cleared at session boundaries by `../index.ts` (`session_start` / `session_shutdown`)
 * exactly as the gate clears its session grants (`pi-gate/grants.ts`), because pi can start, fork, switch or reload
 * a session inside one process. Tests build their own with {@link createSessionBudget} and hand it to the broker.
 */
const processSessionBudget = createSessionBudget();

export function currentSessionBudget(): SessionBudget {
	return processSessionBudget;
}
