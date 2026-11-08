/**
 * ceiling-clock.ts — the two budgets a child run lives inside, and the machine that decides when it is over.
 *
 * At the role's minutes the child is steered to conclude; `HARD_SETTLE_MS` later the hard ceiling fires. The
 * soft deadline only ever asks (of the child, or of the human), so the hard ceiling is what guarantees we settle
 * (FM-2) — and at the ceiling it defers to the work, because killing a run while it writes its report, while a
 * tool is still executing, or while the human is answering the extension question, destroys or outranks the
 * result we paid for. Every deferral is bounded — by `reportWallAt`, or by `offerHoldUntil` — so the guarantee
 * survives being polite. A granted extension restarts both budgets from the moment of the answer, and a run is
 * held open for an answer for at most `CEILING_OFFER_HOLD_MS`.
 *
 * Split out of `runChild`, which keeps what the clock does not own: the counters, the streaming and running-tool
 * sets, the cap on "conclude now" asks (`MAX_STEERS`, with the extension steer deliberately outside it) and the
 * exit itself, which is combined by `pickEarlier` and not assigned. Every piece of budget state lives in this
 * one closure — no field is written on one side of the boundary and read on the other — and nothing under
 * `budget/` imports `../child.ts`.
 *
 * The dialog that asks the question is `pi-subagent/ceiling.ts`, and stays separate on purpose: this file is the
 * mechanism, that one is the question, and only one of them knows what a TTY is.
 */

import type { Role } from "../roles.ts";
import type { Exit } from "../run-exit.ts";
import type {
	CeilingAnswer,
	CeilingAsk,
	CeilingAskHandler,
	CeilingGrant,
	CeilingReason,
	CeilingReport,
} from "./ceiling-vocabulary.ts";

/** Grace period after the soft timeout before the run is abandoned (FM-2). */
export const HARD_SETTLE_MS = 60_000;

/**
 * How long past the hard ceiling a child may still take, reserved for the report. The ceiling asks for a
 * conclusion; this is the wall that lets a conclusion finish instead of being cut mid-sentence.
 */
export const REPORT_GRACE_MS = 3 * 60_000;

/**
 * How long the hard ceiling is held while the human answers the extension question. The dialog is the one
 * that decides (see `ceiling.ts::CEILING_DIALOG_TIMEOUT_MS`, which must stay inside this window); this is the
 * backstop that keeps a run bounded if a broker never answers at all.
 */
export const CEILING_OFFER_HOLD_MS = 6 * 60_000;

/** What the child has spent, read at the moment the question is asked — the run does not stop to be asked. */
export interface CeilingCounters {
	turns: number;
	toolCalls: number;
	lastTool: string | undefined;
	elapsedMs: number;
}

/** The clock as the run needs it: the budget to measure against, the two race operands, and three calls. */
export interface CeilingClock {
	/** The turn budget as it stands — the raised one after a granted extension. */
	maxTurns(): number;
	/** Resolves when the hard ceiling stops deferring: the race operand that ends a run on the clock. */
	deadline: Promise<"timeout">;
	/** The parent's abort as the race's other operand: immediate, unconditional, never deferred. */
	abortWait: Promise<"aborted">;
	/** Arm both budgets. Called on the way into `session.prompt`, never again. */
	arm(): void;
	/** A budget ran out: ask once, then enforce what the answer did not extend. */
	reach(reason: CeilingReason): Promise<void>;
	/** The run is over: no answer can change it, and nothing of the clock's may still be running. */
	teardown(): void;
}

/**
 * What the clock genuinely needs from the run: the role and task the question is about, the live counters as a
 * getter (they mutate while the clock is asking), the two deferral questions, the two kinds of steer, the two
 * recorders, and the three test seams.
 */
export interface CeilingClockHost {
	/** Its budgets are the starting figures; its `name` is what the steers and the question call it. */
	role: Role;
	/** What the child was told to do, whole — the question carries it for a frontend that shows it. */
	task: string;
	/** The parent's signal: `aborted` is a fact about the run, not a budget, and is never held. */
	signal: AbortSignal;
	counters(): CeilingCounters;
	/** The report is the artifact the run exists to produce; a turn asking for a tool is not. */
	isWritingReport(): boolean;
	isExecutingTool(): boolean;
	/** One of the child's two "conclude now" asks — capped and deduplicated by the run, never here. */
	steerToConclude(why: string): void;
	/** A steer the run does not count: what a granted extension says is the opposite ask. */
	steer(text: string): void;
	/** How the run ended, combined with whatever already happened (`pickEarlier`), never overwritten. */
	recordExit(exit: Exit): void;
	/** What the human did with the offer, for the card and the model-facing header. */
	recordCeiling(report: CeilingReport): void;
	/** The soft ask is a state change worth a card update. */
	emit(): void;
	/** The ask, when the run has someone to ask; absent means a spent budget is a spent budget. */
	onCeiling?: CeilingAskHandler;
	/** Seconds between the soft budget and the hard ceiling; a test seam (FM-2). */
	hardSlackMs?: number;
	/** How long past the hard ceiling a run may still take to finish writing its report; a test seam. */
	reportGraceMs?: number;
	/** How long the hard ceiling waits for an answer to the extension question; a test seam. */
	ceilingHoldMs?: number;
}

/** The budget machine for one run. Created before the child is prompted, torn down after it ends. */
export function createCeilingClock(host: CeilingClockHost): CeilingClock {
	// --------------------------------------------------------------------------- the two budgets
	// Mutable, because the human can hand out more of both mid-run (`pi-subagent/ceiling.ts`).
	const budget = { maxTurns: host.role.maxTurns, timeoutMinutes: host.role.timeoutMinutes };

	let softTimer: ReturnType<typeof setTimeout> | undefined;
	let hardTimer: ReturnType<typeof setTimeout> | undefined;
	const slackMs = host.hardSlackMs ?? HARD_SETTLE_MS;
	const reportGraceMs = host.reportGraceMs ?? REPORT_GRACE_MS;
	// Absolute timestamps: a deferral re-arms the ceiling, and so does a granted extension, so durations
	// would drift with every grant.
	let softAt = Date.now() + budget.timeoutMinutes * 60_000;
	let hardAt = softAt + slackMs;
	// The absolute wall: the hard ceiling plus a window reserved for the report. Past this, the clock wins
	// whatever the child is doing, so a delegation cannot become unbounded.
	let reportWallAt = hardAt + reportGraceMs;
	let grantedToolGrace = false;
	/** The run gets one offer, whatever it answered: a second dialog would be the same question twice. */
	let offerSettled = false;
	let offerPending: Promise<void> | undefined;
	/** Until when the hard ceiling waits for an answer, bounded so no run can outlive its own dialog. */
	let offerHoldUntil = 0;
	const offerHoldMs = host.ceilingHoldMs ?? CEILING_OFFER_HOLD_MS;
	/** The race is over: an answer arriving now can no longer change what the run did. */
	let settled = false;
	const abortWait = new Promise<"aborted">((resolve) => {
		if (host.signal.aborted) resolve("aborted");
		else host.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
	});
	// The soft budget only asks for a conclusion (or asks the human); the hard ceiling is what guarantees we
	// settle (FM-2). At the ceiling, though, the clock defers to the work: killing a run while it writes its
	// report, while a tool is still executing (so the steer never reached the model), or while the human is
	// answering an extension question, destroys or outranks the result we paid for. Every deferral is bounded
	// — by `reportWallAt`, or by `offerHoldUntil` — so the guarantee survives.
	let resolveTimeout!: () => void;
	const deadline = new Promise<"timeout">((resolve) => {
		resolveTimeout = () => resolve("timeout");
	});

	/** Arm the hard ceiling for `target`, replacing whatever deferral was pending. */
	function armHardAt(target: number): void {
		clearTimeout(hardTimer);
		hardTimer = setTimeout(fireHard, Math.max(0, target - Date.now()));
		hardTimer.unref?.();
	}

	/** Re-decide when the ceiling next fires: the ceiling itself, or the hold for a pending answer. */
	function armHard(): void {
		armHardAt(Math.max(hardAt, offerHoldUntil));
	}

	function fireHard(): void {
		if (offerHoldUntil > Date.now()) return void armHardAt(offerHoldUntil);
		const remaining = reportWallAt - Date.now();
		if (remaining <= 0) return void resolveTimeout();
		if (host.isWritingReport()) return void armHardAt(reportWallAt);
		if (!grantedToolGrace && host.isExecutingTool()) {
			grantedToolGrace = true;
			return void armHardAt(Math.min(hardAt + slackMs, reportWallAt));
		}
		// An answer that arrived after the ceiling, or an extension that moved it: re-decide, do not kill.
		if (hardAt > Date.now()) return void armHard();
		resolveTimeout();
	}

	function armSoft(): void {
		clearTimeout(softTimer);
		softTimer = setTimeout(() => {
			void reachCeiling("timeout");
			host.emit();
		}, Math.max(0, softAt - Date.now()));
		softTimer.unref?.();
	}

	// ------------------------------------------------------------------------ the ceiling question

	/** The child is told to conclude, and a spent turn budget is what the exit will say. */
	function enforceCeiling(reason: CeilingReason): void {
		if (reason === "maxTurns") {
			host.recordExit("maxTurns");
			host.steerToConclude(`The ${host.role.name} role reached its limit of ${budget.maxTurns} turns`);
			return;
		}
		host.steerToConclude(`The ${host.role.name} role passed its ${budget.timeoutMinutes} minute budget`);
	}

	function applyCeilingGrant(reason: CeilingReason, grant: CeilingGrant): void {
		budget.maxTurns += grant.turns;
		budget.timeoutMinutes += grant.minutes;
		host.recordCeiling({ reason, outcome: "granted", turns: grant.turns, minutes: grant.minutes });
		// The new clock starts at the answer, not at the budget that just expired: "+5 minutes" means five
		// more from now, and the tool grace is a fresh run's privilege, not this one's leftover.
		softAt = Date.now() + grant.minutes * 60_000;
		hardAt = softAt + slackMs;
		reportWallAt = hardAt + reportGraceMs;
		grantedToolGrace = false;
		armSoft();
		armHard();
		// Not a `steerForEnd`: this is the opposite ask, and it must not spend the child's two "conclude now".
		host.steer(
			`The user extended this run by ${grant.turns} turns and ${grant.minutes} minutes — it now has ${budget.maxTurns} turns and ${budget.timeoutMinutes} minutes. Continue the task, and report before the new limit.`,
		);
	}

	async function askCeiling(reason: CeilingReason): Promise<CeilingAnswer> {
		// Hold the ceiling first: an answer two minutes late must not arrive to a killed run. The dialog is
		// expected to time out inside this window (`CEILING_DIALOG_TIMEOUT_MS`); this is the backstop.
		offerHoldUntil = Date.now() + offerHoldMs;
		armHard();
		try {
			// `counters()` is spread, not written out, so the ask cannot drift from what the run actually tracks;
			// the two budget figures follow it and win, because the clock owns the budget and the counters do not.
			const ask: CeilingAsk = {
				reason,
				role: host.role.name,
				task: host.task,
				...host.counters(),
				maxTurns: budget.maxTurns,
				timeoutMinutes: budget.timeoutMinutes,
			};
			return (await host.onCeiling?.(ask)) ?? { outcome: "no_ui" };
		} catch {
			// A broker that cannot ask is a broker that said no: the ceiling is enforced, never skipped.
			return { outcome: "rejected" };
		} finally {
			offerHoldUntil = 0;
			armHard();
		}
	}

	/** A budget ran out: ask once, then enforce what the answer did not extend. */
	function reachCeiling(reason: CeilingReason): Promise<void> {
		if (offerPending) return offerPending;
		if (offerSettled || !host.onCeiling) {
			if (!settled) enforceCeiling(reason);
			return Promise.resolve();
		}
		let done!: () => void;
		offerPending = new Promise<void>((resolve) => {
			done = resolve;
		});
		void askCeiling(reason).then((answer) => {
			offerSettled = true;
			offerPending = undefined;
			if (settled) return void done();
			if (answer.outcome === "granted" && answer.grant) applyCeilingGrant(reason, answer.grant);
			else {
				host.recordCeiling({ reason, outcome: answer.outcome, turns: 0, minutes: 0 });
				enforceCeiling(reason);
			}
			done();
		});
		return offerPending;
	}

	/** Arm both budgets; the run calls this on its way into `session.prompt`. */
	function arm(): void {
		armHardAt(hardAt);
		armSoft();
	}

	/** The run is over — no answer after this point can change it. */
	function teardown(): void {
		// No answer after this point can change the run: the offer, if one is still open, has nothing left to
		// extend, and enforcing the ceiling would stamp an exit onto a run that already ended.
		settled = true;
		offerHoldUntil = 0;
		clearTimeout(softTimer);
		clearTimeout(hardTimer);
	}

	return { maxTurns: () => budget.maxTurns, deadline, abortWait, arm, reach: reachCeiling, teardown };
}
