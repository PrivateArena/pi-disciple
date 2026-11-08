/**
 * run-exit.ts — the run outcome vocabulary: what a child can end as, and which of two endings is the one
 * worth reporting.
 *
 * A run can spend two budgets at once — the parent can abort a child that already hit its turn limit, a call
 * limit can be reached while the clock is deferring — so an exit is combined, never overwritten. `pickEarlier`
 * is the one rule that decides which of two endings a finished run reports, and it is the reason every write
 * in `child.ts` and `budget/ceiling-clock.ts` goes through it instead of assigning.
 *
 * Split out of `child.ts`, which keeps re-exporting `Exit` as its facade: that type was public. The
 * precedence list and the combiner were module-private there and stay private to this leaf.
 */

export type Exit = "done" | "aborted" | "timeout" | "maxTurns" | "callLimit" | "overflow" | "error";

/** `aborted > timeout > callLimit > overflow > maxTurns > error > done` (red-team §7). */
const EXIT_PRECEDENCE: readonly Exit[] = ["aborted", "timeout", "callLimit", "overflow", "maxTurns", "error", "done"];

export function pickEarlier(a: Exit, b: Exit): Exit {
	return EXIT_PRECEDENCE.indexOf(a) <= EXIT_PRECEDENCE.indexOf(b) ? a : b;
}
