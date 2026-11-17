/**
 * stop-dialog.ts — the "may I end this child?" question a stop asks when nobody has answered yet.
 *
 * The budget dialog (`ceiling.ts`) asks for more rope; this one asks to cut it. Same shape, same rules, because
 * the risk is the same one in the other direction: a run that ends early loses work nobody can recover, and
 * losing it is the outcome a careless click produces.
 *
 * The rules, all of them the extension's rather than a caller's:
 * - A stop that arrives with no human answer gets **asked** first (`stop-api.ts`'s `answered` flag). Esc, a
 *   dismissed or timed-out dialog, or no UI at all leaves the child running — an unanswered question is not a yes.
 * - **Keep running is the first choice**, exactly as `Reject` leads the budget dialog: a stray Enter on an open
 *   dialog must not destroy a report that is still being written.
 * - The title is short and the body is a small program — what will happen, and what it costs — because a dialog
 *   that scrolls its own options off the screen asks nothing, it just blocks the run.
 *
 * The child keeps running while this is open, for the SDK's own reason (there is no pause) and the human's: a run
 * worth stopping may still be worth what it has already learned, and an answer that takes a minute should not
 * throw ten minutes of work away by being slow.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { roleDisplayName } from "./labels.ts";
import type { StopQuestion } from "./stop-api.ts";

/** First choice, so a stray Enter on an open dialog keeps the run rather than ending it. */
export const STOP_KEEP_LABEL = "Keep it running";

/** The only answer that stops the child. */
export const STOP_STOP_LABEL = "Stop it — have it report what it has";

/** How long the question waits before it counts as unanswered. Never a stop (the ceiling dialog's rule). */
export const STOP_DIALOG_TIMEOUT_MS = 5 * 60_000;

/** Index-aligned with what {@link stopAnswerIsYes} reads back. */
export function stopLabels(): string[] {
	return [STOP_KEEP_LABEL, STOP_STOP_LABEL];
}

/**
 * The question, in the human's terms and never in the runtime's.
 *
 * Line 1 is the title the option lists hang under: what is being asked, of which role. Line 2 is the answer the
 * human is weighing against their own judgement — "a tool call will be interrupted" is what "stop" mechanically
 * means and tells them nothing about this run, so the line states the consequence they can actually evaluate:
 * the report never arrives, and what is lost is the reasoning rather than the bytes. Line 3 is the cost, in the
 * one unit a running child produces.
 *
 * Deliberately **not** the task, and not the command name: the task is the paragraph the human wrote and is on
 * the card above, one child runs at a time (`run-guard.ts`) so this can never be about an unnamed run, and the
 * current tool call is `details.activity`, which the card is already showing live.
 */
export function stopDialogTitle(question: StopQuestion): string {
	const role = roleDisplayName(question.role);
	const spent = `${question.elapsedSeconds}s of work`;
	return (
		`pi-subagent: stop the ${role} subagent?\n` +
		`it will not finish its report — only what it has already written comes back to the main agent\n` +
		`${spent} so far will be dropped${question.reason ? `\nthe main agent will read: ${question.reason}` : ""}`
	);
}

/** Read a label back as a decision. Anything unrecognised — including nothing picked — keeps it running. */
export function stopAnswerIsYes(picked: string | undefined): boolean {
	return picked === STOP_STOP_LABEL;
}

/** Injectable, so tests never need a TTY (the ceiling broker's shape, mirrored). */
export interface StopAskIO {
	select: ExtensionUIContext["select"];
}

export interface StopAskHost {
	/** False with no front-end (`pi -p`): the question cannot be asked, so a stop cannot happen. */
	hasUI: boolean;
	ui: StopAskIO;
	signal?: AbortSignal;
	/** `0` means wait for a human; anything else is that many ms. */
	timeoutMs?: number;
}

/**
 * The asker a run hands to the stop API. Never throws: a dialog that cannot be drawn is a refusal, and the
 * caller reports "not answered" rather than pretending a stop happened.
 */
export function createStopAsker(host: StopAskHost): (question: StopQuestion) => Promise<boolean> {
	return async (question) => {
		if (!host.hasUI) return false;
		const timeout =
			host.timeoutMs === undefined ? STOP_DIALOG_TIMEOUT_MS : host.timeoutMs > 0 ? host.timeoutMs : undefined;
		const picked = await host.ui.select(stopDialogTitle(question), stopLabels(), {
			signal: host.signal,
			timeout,
		});
		return stopAnswerIsYes(picked);
	};
}
