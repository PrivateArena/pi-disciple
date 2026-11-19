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
 * - One offer per run, whatever it answered (`budget/ceiling-clock.ts` owns that rule). The extension is a favour, not a
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
 * Two menus, one question. The run menu is the original: a rung for this run only. The session menu
 * (`CEILING_SESSION_MENU_LABEL`) writes the rung into `budget/session-budget.ts` instead, and a session with a
 * remembered rung is never asked again — the broker answers the offer with the remembered figures, without a second
 * question, for every later run (and says out loud what it did). That is the same trade the gate makes with session grants, and it is still an explicit human
 * choice; what it removes is the repeating of an answer already given. Only a rung the dialog could still have
 * offered is applied that way — a config edit mid-session that retired the rung puts the question back on screen.
 *
 * The rungs are the human's to write: `subagent.extendOptions` **replaces** the shipped ladder outright, and
 * `subagent.disableExtendTurns` drops rungs from whatever list results (`resolveExtensionSteps`). What is not
 * configurable is what a rung means — turns and minutes, handed out together — and the fact that only an explicit
 * choice grants anything.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExtendOption } from "../pi-gate/schema.ts";
import { MAX_EXTEND_OPTIONS } from "./config-contract/extend-options.ts";
import { formatDuration, roleDisplayName } from "./labels.ts";
import type { CeilingAnswer, CeilingAsk, CeilingAskHandler, CeilingGrant, CeilingReason } from "./budget/ceiling-vocabulary.ts";
import type { SessionBudget } from "./budget/session-budget.ts";

/** One rung of the ladder the human is offered: turns and minutes, always handed out together. */
export interface ExtensionStep {
	turns: number;
	minutes: number;
}

/**
 * The shipped extension ladder, used only when the config writes no `subagent.extendOptions` at all — a written
 * ladder replaces it ({@link resolveExtensionSteps}). The rungs are absolute additions, not multipliers of the
 * role's budget, so the same dialog means the same thing for a 10-turn `review` and a 200-turn custom role. Every
 * rung — a shipped one, or one the human wrote — stays inside the bounds `config-contract/extend-options.ts` names
 * (`EXTEND_TURNS_CEILING` turns, `ROLE_TIMEOUT_CEILING_MINUTES` minutes); what a run ends up with grows only by the
 * extensions a human actually accepted.
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
 * offered — which is also why {@link ceilingPickFor} resolves against this list and not the config's: a rung
 * that was not shown must never be grantable by name. The config reader reports the surplus
 * (`config-file.ts::settleLadder`); this is the enforcement, so no caller can ask a question the cap exists to
 * prevent, whatever limits it was handed.
 */
export function offeredSteps(steps: readonly ExtensionStep[]): ExtensionStep[] {
	return steps.length <= MAX_EXTEND_OPTIONS ? [...steps] : [...steps].slice(-MAX_EXTEND_OPTIONS);
}

/** Copy of the shipped ladder, so no caller can write through into the exported constant. */
function shippedSteps(): ExtensionStep[] {
	return EXTENSION_STEPS.map((step) => ({ ...step }));
}

/**
 * The ladder this config offers: `subagent.extendOptions` **when it is written** — replacing the shipped rungs
 * outright, so what a human wrote is what the dialog shows, one rung per entry, nothing silently merged in — the
 * shipped ladder when it is not, then the turn counts named by `subagent.disableExtendTurns` dropped, and the
 * result sorted smallest-first so the dialog reads as a ladder. It is what the config says, before
 * {@link offeredSteps} trims it to what a dialog may show, and it may come back empty — a config that drops every
 * rung does — which is a mistake the config reader reports (`pi-subagent/config-file.ts::settleLadder`), not
 * something this function hides.
 */
export function resolveExtensionSteps(options?: readonly ExtendOption[], disabledTurns?: readonly number[]): ExtensionStep[] {
	const written = new Map<number, number>();
	for (const step of options?.length ? options : shippedSteps()) written.set(step.turns, step.minutes);
	// Two rungs of one `turns` count would be the same choice printed twice, and only the first could ever be
	// picked: last written wins, the way the rest of this file resolves a repeated key.
	const ladder = [...written].map(([turns, minutes]) => ({ turns, minutes }));
	const dropped = new Set(disabledTurns ?? []);
	return (dropped.size ? ladder.filter((step) => !dropped.has(step.turns)) : ladder).sort((a, b) => a.turns - b.turns);
}

/** First choice, so a stray Enter on an open dialog ends the run rather than paying for more of it. */
export const CEILING_REJECT_LABEL = "Reject — end the run and have it report now";

/** Which of the two menus the question is showing. */
export type CeilingMenu = "run" | "session";

/** Run menu: switch to the ladder whose choices outlive the run. */
export const CEILING_SESSION_MENU_LABEL = "Session budget — remember the choice for this session ▸";

/** Session menu: switch back to rungs for this run only. */
export const CEILING_RUN_MENU_LABEL = "◂ Back to per-run choices";

/** Session menu, only while something is remembered: take the session budget away and ask again each run. */
export const CEILING_SESSION_FORGET_LABEL = "Forget the remembered session budget — ask again each run";

/** How long the question waits before it counts as unanswered. Never an extension (FM-11). */
export const CEILING_DIALOG_TIMEOUT_MS = 5 * 60_000;

export function extensionLabel(step: ExtensionStep): string {
	return `Extend by ${step.turns} turns / ${step.minutes} min`;
}

/** The same rung with what makes it a session choice: it applies again after this run ends. */
export function sessionExtensionLabel(step: ExtensionStep): string {
	return `${extensionLabel(step)} — every run this session`;
}

/** The options of one menu, index-aligned with what {@link ceilingPickFor} reads back for the same ladder. */
export function ceilingLabels(steps: readonly ExtensionStep[] = EXTENSION_STEPS, menu: CeilingMenu = "run", remembered = false): string[] {
	const rungs = offeredSteps(steps);
	if (menu === "session") {
		return [
			CEILING_RUN_MENU_LABEL,
			...(remembered ? [CEILING_SESSION_FORGET_LABEL] : []),
			...rungs.map(sessionExtensionLabel),
		];
	}
	return [CEILING_REJECT_LABEL, ...rungs.map(extensionLabel), CEILING_SESSION_MENU_LABEL];
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
 *
 * Three lines whatever the menu, because the third line is the only thing that differs: the session menu says what
 * its choices do, since "every run this session" is the whole reason that menu exists.
 */
export function ceilingTitle(ask: CeilingAsk, menu: CeilingMenu = "run"): string {
	const counters = [
		`turns: ${ask.turns}/${ask.maxTurns}`,
		`tool calls: ${ask.toolCalls}`,
		`elapsed: ${formatDuration(ask.elapsedMs)}`,
		ask.lastTool ? `last: ${ask.lastTool}` : "",
	]
		.filter(Boolean)
		.join("  ·  ");
	const note =
		menu === "session"
			? `session budget: a choice applies to every later run without asking — /subagentc budget forgets it`
			: `one extension per run: "Reject" ends it now and the child reports what it has`;
	return `pi-subagent: ${roleDisplayName(ask.role)} — ${ceilingFact(ask)}\n` + counters + `\n${note}`;
}

/** What the human's pick on a menu means: a decision, a menu switch, or both (a switch that also forgets). */
export interface CeilingPick {
	/** The decision this label carries, when the label was a decision. */
	answer?: CeilingAnswer;
	/** Show this menu instead — the label was a switch, not an answer. */
	menu?: CeilingMenu;
	/** Write the grant to the session budget (`budget/session-budget.ts`) as well as applying it now. */
	remember?: boolean;
	/** Take the remembered session budget away. */
	forget?: boolean;
}

/**
 * Read a label back as a decision, against the ladder and the menu this run actually showed. Anything
 * unrecognised — including the reject label, and including a rung of some other ladder — rejects: the answer must
 * name a rung that was offered, never a number a frontend invented.
 */
export function ceilingPickFor(picked: string | undefined, steps: readonly ExtensionStep[] = EXTENSION_STEPS, menu: CeilingMenu = "run"): CeilingPick {
	if (!picked) return { answer: { outcome: "dismissed" } };
	if (menu === "session") {
		if (picked === CEILING_RUN_MENU_LABEL) return { menu: "run" };
		// Reachable only when a remembered rung is no longer on the ladder (a config edited mid-session), which is
		// exactly when the human needs a way back to being asked.
		if (picked === CEILING_SESSION_FORGET_LABEL) return { forget: true, menu: "run" };
		const step = offeredSteps(steps).find((candidate) => sessionExtensionLabel(candidate) === picked);
		if (!step) return { answer: { outcome: "rejected" } };
		return { answer: { outcome: "granted", grant: { turns: step.turns, minutes: step.minutes }, remembered: true }, remember: true };
	}
	if (picked === CEILING_SESSION_MENU_LABEL) return { menu: "session" };
	const step = offeredSteps(steps).find((candidate) => extensionLabel(candidate) === picked);
	if (!step) return { answer: { outcome: "rejected" } };
	return { answer: { outcome: "granted", grant: { turns: step.turns, minutes: step.minutes } } };
}

/**
 * Read a run-menu label back as an answer (the shape before the session menu existed, kept for callers that only
 * ever show that menu). A menu switch is not an answer, and grants nothing.
 */
export function ceilingAnswerFor(picked: string | undefined, steps: readonly ExtensionStep[] = EXTENSION_STEPS): CeilingAnswer {
	return ceilingPickFor(picked, steps, "run").answer ?? { outcome: "rejected" };
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
	/**
	 * The session's remembered rung (`budget/session-budget.ts`). While it holds a rung this dialog could still
	 * offer, the offer is answered without asking; the session menu is what writes it and `forget` is what clears
	 * it. Absent means every spent budget is asked about, which is what a run without a UI gets.
	 */
	session?: SessionBudget;
	/** So the caller can put the answer on the live card before the run itself reports it. */
	onOutcome?: (reason: CeilingReason, answer: CeilingAnswer) => void;
}

/** What the run is now authorised to keep spending, said out loud in the words the tests and the human read. */
function grantNotice(ask: CeilingAsk, grant: CeilingGrant, remembered: boolean, asked: boolean): string {
	const figures = `extended by ${grant.turns} turns / ${grant.minutes} min`;
	const now = `now ${ask.maxTurns + grant.turns} turns, ${ask.timeoutMinutes + grant.minutes} min`;
	if (!remembered) return `[subagent] ${figures} — ${now}`;
	return asked
		? `[subagent] ${figures} — ${now} — remembered for this session: later runs extend without asking (/subagentc budget forgets it)`
		: `[subagent] ${figures} by the remembered session budget — ${now} (/subagentc budget forgets it)`;
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
		const rungs = offeredSteps(steps);
		const timeout = host.timeoutMs === undefined ? CEILING_DIALOG_TIMEOUT_MS : host.timeoutMs > 0 ? host.timeoutMs : undefined;
		const remembered = host.session?.get();
		const standing = remembered && rungs.some((step) => step.turns === remembered.turns && step.minutes === remembered.minutes) ? remembered : undefined;
		// A rung the human already chose for the session is an answer, not a question — but only while this dialog
		// could still have offered it. Off the ladder (a config edit mid-session), start on the session menu, which
		// is where that stale figure gets rewritten or forgotten.
		if (standing) {
			const answer: CeilingAnswer = { outcome: "granted", grant: standing, remembered: true };
			host.ui.notify(grantNotice(ask, standing, true, false), "info");
			host.onOutcome?.(ask.reason, answer);
			return answer;
		}
		// Two menus, one question: the answer is whatever is not a switch, and switching menus costs a repaint, not a
		// grant. It must not buy time either — the clock holds the hard ceiling for one dialog's wait
		// (`CEILING_OFFER_HOLD_MS`), so the whole exchange gets that one timeout, spent from the first question.
		const askedAt = Date.now();
		let menu: CeilingMenu = remembered ? "session" : "run";
		// What the session menu must admit to: the store's own state, kept in step with the switches above so the
		// "forget this" choice never offers itself after it has already been taken.
		let rememberedShown = remembered !== undefined;
		let answer: CeilingAnswer = { outcome: "dismissed" };
		for (;;) {
			const left = timeout === undefined ? undefined : timeout - (Date.now() - askedAt);
			if (left !== undefined && left <= 0) {
				// The one question's wait is spent. An unanswered question grants nothing (FM-11).
				answer = { outcome: "dismissed" };
				break;
			}
			const picked = await host.ui.select(ceilingTitle(ask, menu), ceilingLabels(steps, menu, rememberedShown), {
				signal: host.signal,
				timeout: left,
			});
			const pick = ceilingPickFor(picked, steps, menu);
			if (host.signal?.aborted) {
				// The run is over — aborted, or settled with the clock no longer holding. An answer arriving now could
				// extend nothing, so it must not reach the session store either: that would let a question whose own run
				// discarded it authorise every later one.
				answer = { outcome: "dismissed" };
				break;
			}
			if (pick.forget) {
				host.session?.clear();
				rememberedShown = false;
			}
			if (pick.remember && pick.answer?.grant) {
				host.session?.set(pick.answer.grant);
				rememberedShown = true;
			}
			if (pick.menu) {
				menu = pick.menu;
				continue;
			}
			answer = pick.answer ?? { outcome: "rejected" };
			break;
		}
		// The run is still going while this dialog is open, so say out loud what the child is now authorised to
		// keep spending. The child itself gets the same words as a steer (`child.ts::applyCeilingGrant`).
		if (answer.outcome === "granted" && answer.grant) {
			host.ui.notify(grantNotice(ask, answer.grant, answer.remembered === true, true), "info");
		}
		host.onOutcome?.(ask.reason, answer);
		return answer;
	};
}
