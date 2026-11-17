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
 * - The title stays short enough that the options are on screen (`ceilingTitle`). A delegation prompt is a
 *   paragraph; a dialog that scrolls its own buttons off the screen asks nothing — it just blocks the run.
 *
 * While the dialog is open the child keeps running: the SDK has no pause, and a human who takes a minute to
 * answer should not be billed for a stalled run — and a run the human means to extend is a run whose work is
 * worth continuing. The dialog's own timeout bounds that wait, and it must stay inside
 * `child.ts::CEILING_OFFER_HOLD_MS`, the window the hard ceiling is held for; a test asserts the relation.
 *
 * The rungs are the human's to write: `subagent.extendOptions` adds rungs and re-tunes the shipped ones, and
 * `subagent.disableExtendTurns` drops them (`resolveExtensionSteps`). What is not configurable is what a rung
 * means — turns and minutes, handed out together — and the fact that only an explicit choice grants anything.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExtendOption } from "../pi-gate/schema.ts";
import { MAX_EXTEND_OPTIONS } from "./config-contract/extend-options.ts";
import { formatDuration, roleDisplayName } from "./labels.ts";
import type { CeilingAnswer, CeilingAsk, CeilingAskHandler, CeilingReason } from "./budget/ceiling-vocabulary.ts";

/** One rung of the ladder the human is offered: turns and minutes, always handed out together. */
export interface ExtensionStep {
	turns: number;
	minutes: number;
}

/**
 * The shipped extension ladder. The rungs are absolute additions, not multipliers of the role's budget, so the
 * same dialog means the same thing for a 10-turn `review` and a 200-turn custom role. No rung — shipped one, or one
 * `subagent.extendOptions` writes — may name more than a role budget may be configured to name
 * (`ROLE_TURNS_CEILING` / `ROLE_TIMEOUT_CEILING_MINUTES`, `config-contract/role-names.ts`), so one click is always something the
 * config itself could have said; what a run ends up with grows only by the extensions a human actually accepted.
 *
 * The list is what a config merges over, never what a dialog is limited to: {@link resolveExtensionSteps}
 * settles what the config says, and {@link offeredSteps} is what the run asks about.
 */
export const EXTENSION_STEPS: readonly ExtensionStep[] = [
	{ turns: 20, minutes: 5 },
	{ turns: 40, minutes: 10 },
	{ turns: 60, minutes: 15 },
	{ turns: 100, minutes: 25 },
];

/**
 * The rungs a dialog may actually show. The question is pi's `select`, and a rung scrolled off the screen cannot
 * be chosen, so a ladder longer than {@link MAX_EXTEND_OPTIONS} keeps its largest rungs and the rest are never
 * offered — which is also why {@link ceilingAnswerFor} resolves against this list and not the config's: a rung
 * that was not shown must never be grantable by name. The config reader reports the surplus
 * (`config-file.ts::settleLadder`); this is the enforcement, so no caller can ask a question the cap exists to
 * prevent, whatever limits it was handed.
 */
export function offeredSteps(steps: readonly ExtensionStep[]): ExtensionStep[] {
	return steps.length <= MAX_EXTEND_OPTIONS ? [...steps] : [...steps].slice(-MAX_EXTEND_OPTIONS);
}

/**
 * Merge written rungs onto the ladder they extend, keyed by `turns`: a rung naming the `turns` of an existing one
 * replaces that rung's minutes, an unseen `turns` adds a rung. Written rungs are the shape
 * `subagent.extendOptions` parses to, which is structurally one {@link ExtensionStep}.
 */
export function mergeExtensionSteps(base: readonly ExtensionStep[], options: readonly ExtendOption[]): ExtensionStep[] {
	const merged = base.map((step) => ({ ...step }));
	for (const option of options) {
		const existing = merged.find((step) => step.turns === option.turns);
		if (existing) existing.minutes = option.minutes;
		else merged.push({ turns: option.turns, minutes: option.minutes });
	}
	return merged;
}

/**
 * The ladder this config offers: the shipped rungs with `subagent.extendOptions` merged over them, the turn
 * counts named by `subagent.disableExtendTurns` dropped, and what is left sorted smallest-first so the dialog
 * reads as a ladder. It is what the config says, before {@link offeredSteps} trims it to what a dialog may show,
 * and it may come back empty — a config that drops every rung does — which is a mistake the config reader
 * reports (`pi-subagent/config-file.ts::settleLadder`), not something this function hides.
 */
export function resolveExtensionSteps(options?: readonly ExtendOption[], disabledTurns?: readonly number[]): ExtensionStep[] {
	const merged = mergeExtensionSteps(EXTENSION_STEPS, options ?? []);
	const dropped = new Set(disabledTurns ?? []);
	return (dropped.size ? merged.filter((step) => !dropped.has(step.turns)) : merged).sort((a, b) => a.turns - b.turns);
}

/** First choice, so a stray Enter on an open dialog ends the run rather than paying for more of it. */
export const CEILING_REJECT_LABEL = "Reject — end the run and have it report now";

/** How long the question waits before it counts as unanswered. Never an extension (FM-11). */
export const CEILING_DIALOG_TIMEOUT_MS = 5 * 60_000;

export function extensionLabel(step: ExtensionStep): string {
	return `Extend by ${step.turns} turns / ${step.minutes} min`;
}

/** Index-aligned with what {@link ceilingAnswerFor} reads back, for the same ladder (both see the offered part of it). */
export function ceilingLabels(steps: readonly ExtensionStep[] = EXTENSION_STEPS): string[] {
	return [CEILING_REJECT_LABEL, ...offeredSteps(steps).map(extensionLabel)];
}

/** Which budget ran out, in the words the run itself uses. */
function ceilingFact(ask: CeilingAsk): string {
	return ask.reason === "maxTurns" ? `reached its limit of ${ask.maxTurns} turns` : `passed its ${ask.timeoutMinutes} minute budget`;
}

/**
 * The question, and nothing else: which role, which budget ran out, what the child has spent so far, and what
 * refusing costs. Deliberately **not** the task — a delegation prompt is the paragraph the human wrote, it is
 * on the tool card above and in the transcript, and only one child can run at a time (`run.ts`'s guard), so
 * the dialog can never be about an unnamed run. Printed here it would push `Reject` and the rungs off the
 * screen, which is the failure this dialog must not have: an unanswered question grants nothing (FM-11), so a
 * dialog whose options are invisible refuses its own run. Frontends that want the task can render it from
 * `ask.task`, which still carries it whole.
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
		counters +
		`\none extension per run: "Reject" ends it now and the child reports what it has`
	);
}

/**
 * Read a label back as a decision, against the ladder this run actually showed. Anything unrecognised —
 * including the reject label, and including a rung of some other ladder — rejects: the answer must name a rung
 * that was offered, never a number a frontend invented.
 */
export function ceilingAnswerFor(picked: string | undefined, steps: readonly ExtensionStep[] = EXTENSION_STEPS): CeilingAnswer {
	if (!picked) return { outcome: "dismissed" };
	const step = offeredSteps(steps).find((candidate) => extensionLabel(candidate) === picked);
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
	/**
	 * The rungs to offer, as this config settled them (`resolveExtensionSteps`). Absent means the shipped ladder,
	 * which is what a config that never mentions `subagent.extendOptions` gets. A longer ladder is trimmed here,
	 * exactly as {@link ceilingLabels} trims it, so the answer can only name a rung that was on screen.
	 */
	steps?: readonly ExtensionStep[];
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
		// A ladder with no rungs is a config mistake the reader already reported (`settleLadder`); a dialog that
		// can only refuse is the ceiling enforced, so the shipped rungs are what a broker asks about.
		const steps = host.steps?.length ? host.steps : EXTENSION_STEPS;
		const timeout = host.timeoutMs === undefined ? CEILING_DIALOG_TIMEOUT_MS : host.timeoutMs > 0 ? host.timeoutMs : undefined;
		const picked = await host.ui.select(ceilingTitle(ask), ceilingLabels(steps), { signal: host.signal, timeout });
		const answer = ceilingAnswerFor(picked, steps);
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
