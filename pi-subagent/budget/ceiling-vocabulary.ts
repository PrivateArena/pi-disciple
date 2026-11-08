/**
 * ceiling-vocabulary.ts — the words a spent budget speaks: which budget ran out, what the human is asked to
 * decide on, what more rope looks like, what they answered, and what the run reports about the whole exchange.
 *
 * Types only, and the whole of the ceiling's public vocabulary: the machine that uses them is
 * `budget/ceiling-clock.ts`, the dialog that asks them is `pi-subagent/ceiling.ts`, and the two are split on
 * purpose (mechanism vs. question — see that file's header). Nothing under `budget/` imports `../child.ts`;
 * `child.ts` keeps re-exporting every name here as its facade, because all of them were public there.
 */

/** Which budget ran out. */
export type CeilingReason = "maxTurns" | "timeout";

/** The state of a run at the moment its budget is spent — what the human decides on. */
export interface CeilingAsk {
	reason: CeilingReason;
	role: string;
	/**
	 * What the child was told to do, whole. Carried for a frontend that wants to show it next to the question;
	 * pi's own dialog title does not print it, because a delegation prompt is a paragraph and the paragraph
	 * would hide the options (`ceiling.ts::ceilingTitle`).
	 */
	task: string;
	turns: number;
	toolCalls: number;
	lastTool?: string;
	elapsedMs: number;
	/** The turn budget that was reached (already the extended one, if this run was extended before). */
	maxTurns: number;
	timeoutMinutes: number;
}

/** More rope, as the human gave it: both figures are added to the budget that ran out. */
export interface CeilingGrant {
	turns: number;
	minutes: number;
}

/** Only `granted` extends the run; every other outcome enforces the ceiling exactly as it always did. */
export type CeilingOutcome = "granted" | "rejected" | "dismissed" | "no_ui";

export interface CeilingAnswer {
	outcome: CeilingOutcome;
	grant?: CeilingGrant;
}

/** What the run did with its single offer, carried out to the card and the model-facing header. */
export interface CeilingReport {
	reason: CeilingReason;
	outcome: CeilingOutcome;
	/** Turns and minutes added by the grant; `0`/`0` when the ceiling was enforced instead. */
	turns: number;
	minutes: number;
}

/**
 * The one question a ceiling may ask: "more rope?". Called at most once per run, before the ceiling is
 * enforced; resolve `no_ui`/`dismissed` to have the ceiling enforced unchanged. See `pi-subagent/ceiling.ts`
 * for who asks and how, and for the bound the answer must respect ({@link CEILING_OFFER_HOLD_MS}).
 */
export type CeilingAskHandler = (ask: CeilingAsk) => Promise<CeilingAnswer>;
