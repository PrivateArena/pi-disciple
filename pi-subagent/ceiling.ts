/**
 * ceiling.ts — the one-time "more rope?" dialog a spent budget can ask (the `maxTurns` / timeout ceiling).
 *
 * A child that runs out of turns used to have exactly one outcome: it got steered to conclude and the run came
 * back `INCOMPLETE (maxTurns)`. The budgets are per-role guesses, and a delegation that turns out bigger than
 * the role guessed is the normal case rather than the exception, so reaching a ceiling is now also a question for
 * the human who is watching: hand the run more turns and more minutes, or let it end as it always did.
 *
 * The rules are the gate's rules, because the risk is the same one:
 * - Only an explicit "Extend" choice extends. Esc, a dismissed or timed-out dialog, or no UI at all enforces the
 *   ceiling unchanged — a dialog nobody answered grants nothing (FM-11).
 * - One offer per run, whatever it answered (`child.ts` owns that rule). The extension is a favour, not a
 *   contract; a second dialog would be the same question the human has already answered, and a run that needs
 *   more than one is a run that was delegated the wrong size.
 * - Nothing is truncated: the task is printed whole, above the counters the decision is actually made on.
 *
 * While the dialog is open the child keeps running: the SDK has no pause, and a human who takes a minute to
 * answer should not be billed for a stalled run — and a run the human means to extend is a run whose work is
 * worth continuing. The dialog's own timeout bounds that wait, and it must stay inside
 * `child.ts::CEILING_OFFER_HOLD_MS`, the window the hard ceiling is held for; a test asserts the relation.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { CeilingAnswer, CeilingAskHandler, CeilingReason } from "./child.ts";
import { formatDuration, roleDisplayName, taskBody } from "./labels.ts";
import type { CeilingAsk } from "./child.ts";

/** One rung of the ladder the human is offered: turns and minutes, always handed out together. */
export interface ExtensionStep {
	turns: number;
	minutes: number;
}

/**
 * The extension ladder. The rungs are absolute additions, not multipliers of the role's budget, so the same
 * dialog means the same thing for a 10-turn `review` and a 200-turn custom role. The top rung is well under the
 * built-in role ceiling (`roles.ts`), so one click can never produce a budget no human would have written.
 */
export const EXTENSION_STEPS: readonly ExtensionStep[] = [
	{ turns: 20, minutes: 5 },
	{ turns: 40, minutes: 10 },
	{ turns: 60, minutes: 15 },
	{ turns: 100, minutes: 25 },
];

/** First choice, so a stray Enter on an open dialog ends the run rather than paying for more of it. */
export const CEILING_REJECT_LABEL = "Reject — end the run and have it report now";

/** How long the question waits before it counts as unanswered. Never an extension (FM-11). */
export const CEILING_DIALOG_TIMEOUT_MS = 5 * 60_000;

export function extensionLabel(step: ExtensionStep): string {
	return `Extend by ${step.turns} turns / ${step.minutes} min`;
}

/** Index-aligned with what {@link ceilingAnswerFor} reads back. */
export function ceilingLabels(): string[] {
	return [CEILING_REJECT_LABEL, ...EXTENSION_STEPS.map(extensionLabel)];
}

/** Which budget ran out, in the words the run itself uses. */
function ceilingFact(ask: CeilingAsk): string {
	return ask.reason === "maxTurns" ? `reached its limit of ${ask.maxTurns} turns` : `passed its ${ask.timeoutMinutes} minute budget`;
}

/**
 * The question, with everything it is answered on above the options: which role, which budget, what the child
 * has done so far, and what the task was. The task whole and verbatim — the human is deciding whether this
 * delegation deserves more of the bill, and an ellipsis hides exactly that.
 */
export function ceilingTitle(ask: CeilingAsk): string {
	const counters = [
		`turns: ${ask.turns}/${ask.maxTurns}`,
		`tool calls: ${ask.toolCalls}`,
		`elapsed: ${formatDuration(ask.elapsedMs)}`,
		ask.lastTool ? `last: ${ask.lastTool}` : "",
	]
		.filter(Boolean)
		.join("  ·  ");
	return (
		`pi-subagent: ${roleDisplayName(ask.role)} — ${ceilingFact(ask)}\n` +
		`task: ${taskBody(ask.task)}\n` +
		counters +
		`\none extension per run: "Reject" ends it now and the child reports what it has`
	);
}

/** Read a label back as a decision. Anything unrecognised — including the reject label — rejects. */
export function ceilingAnswerFor(picked: string | undefined): CeilingAnswer {
	if (!picked) return { outcome: "dismissed" };
	const step = EXTENSION_STEPS.find((candidate) => extensionLabel(candidate) === picked);
	if (!step) return { outcome: "rejected" };
	return { outcome: "granted", grant: { turns: step.turns, minutes: step.minutes } };
}

/** Injectable, so tests never need a TTY (mirrors `pi-gate/prompt.ts::AskIO`). */
export interface CeilingIO {
	select: ExtensionUIContext["select"];
	notify: ExtensionUIContext["notify"];
}

export interface CeilingBrokerHost {
	/** False with no front-end (`pi -p`): the question cannot be asked, so the ceiling is enforced as before. */
	hasUI: boolean;
	ui: CeilingIO;
	signal?: AbortSignal;
	/** `0` means wait for a human, like the gate's `promptTimeoutMs: 0`; anything else is that many ms. */
	timeoutMs?: number;
	/** So the caller can put the answer on the live card before the run itself reports it. */
	onOutcome?: (reason: CeilingReason, answer: CeilingAnswer) => void;
}

/**
 * The handler `runChild` asks through. Never throws and never blocks past {@link CEILING_DIALOG_TIMEOUT_MS}:
 * a broker that cannot answer is a refusal, never a way to make a run unbounded.
 */
export function createCeilingBroker(host: CeilingBrokerHost): CeilingAskHandler {
	return async (ask) => {
		if (!host.hasUI) {
			const answer = { outcome: "no_ui" } as const;
			host.onOutcome?.(ask.reason, answer);
			return answer;
		}
		const timeout = host.timeoutMs === undefined ? CEILING_DIALOG_TIMEOUT_MS : host.timeoutMs > 0 ? host.timeoutMs : undefined;
		const picked = await host.ui.select(ceilingTitle(ask), ceilingLabels(), { signal: host.signal, timeout });
		const answer = ceilingAnswerFor(picked);
		// The run is still going while this dialog is open, so say out loud what the child is now authorised to
		// keep spending. The child itself gets the same words as a steer (`child.ts::applyCeilingGrant`).
		if (answer.outcome === "granted" && answer.grant) {
			host.ui.notify(
				`[subagent] extended by ${answer.grant.turns} turns / ${answer.grant.minutes} min — now ${ask.maxTurns + answer.grant.turns} turns, ${ask.timeoutMinutes + answer.grant.minutes} min`,
				"info",
			);
		}
		host.onOutcome?.(ask.reason, answer);
		return answer;
	};
}
