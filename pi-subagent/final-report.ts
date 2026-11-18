/**
 * final-report.ts — the guarantee that a child answers, in the two places the guarantee can break.
 *
 * The report is the artifact a delegation pays for, and both ways of losing it are visible in the wild:
 *
 * 1. **cut off**. The clock's wall came down while the child was mid-turn, and the text the run hands back is
 *    the leading narration of a turn that never finished — "Now I'll write the code. Starting with deps and
 *    lib.rs:". That is not a report; it is the half of a thought, and the parent will read it as one.
 * 2. **written instead of called**. The child put the call on the text channel (`[Tool call: bash]`), the loop
 *    saw no tool call and stopped, so the run "completed" on a sentence about what it was about to do.
 *
 * Both get the same treatment: one final turn, on the same child session, with its tools switched off. No
 * tools means nothing left to narrate — a message is the only move the model has left, so it reports. The turn
 * is bounded by its own grace window and never runs at all when the human stopped the run, when the provider is
 * what failed, or when `subagent.requireFinalReport` is off.
 *
 * What it cannot guarantee is that the report is *complete*: a child cut off at turn 103 knows less than one
 * that finished. That is what `ReportSource` says, and what `composeResult` puts in front of the text.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Exit } from "./run-exit.ts";
import { endsWithCallMarkup } from "./call-text.ts";
import { lastAssistantText } from "./child-messages.ts";
/** Where the text a run hands back came from. */
export type ReportSource =
	/** The child's own last message, on a run that ended the way it meant to. */
	| "final"
	/** Written in the tool-less final turn after the run could not produce one. */
	| "rescued"
	/** Not a report: the fragment the run ended on, or nothing at all. Said so, never presented as a report. */
	| "salvaged";

/** Why a final turn is being asked for, which is what the prompt has to explain. */
export type ReportReason = "ceiling" | "malformed";

export interface ReportPlan {
	rescue: boolean;
	reason?: ReportReason;
	/** Why no turn was asked for, for the log: the run is fine, or the human said so. */
	skip?: "reported" | "aborted" | "error" | "disabled";
}

/** How long the final turn may take. A report is short by construction; the wall is for the slow provider. */
export const FINAL_REPORT_GRACE_MS = 3 * 60_000;

const REPORT_TAIL =
	"Write your final report now, in this message, as plain text: what you did (file paths, the commands that actually ran and what they returned), what you verified, what is still unfinished, and what blocked you. A message that describes a next step is not a report — this message is the only thing your caller reads.";

/** The child ran out of budget (or of turns) and never summarised. */
export const FINAL_REPORT_CEILING_PROMPT = `Your budget for this run is spent and your tools are now switched off, so no further work is possible. ${REPORT_TAIL}`;

/** The child's last message wrote a call as text, so nothing ran and the run stopped there. */
export const FINAL_REPORT_MALFORMED_PROMPT = `Your tools are now switched off, and the last message you sent wrote a tool call as text, which executed nothing. Do not write another call. ${REPORT_TAIL}`;

/** The words for one reason. */
export function finalReportPrompt(reason: ReportReason): string {
	return reason === "malformed" ? FINAL_REPORT_MALFORMED_PROMPT : FINAL_REPORT_CEILING_PROMPT;
}

/**
 * What the freshest text of a run actually is, read off the message it came from. The classification, not the
 * exit, decides whether a final turn is owed: a child that answered after its budget was spent has answered.
 */
export type ReportShape =
	| "report"
	| /** the message was cut off, or ended on a tool call — narration about work, not the result of it */ "partial"
	| /** the message wrote a tool call as text, so nothing ran */ "markup"
	| /** the child said nothing at all */ "none";

/**
 * Stop reasons that mean the text stopped before the thought did. `pending` is what a message carries while it
 * is still streaming, and `deferred` that it will not finish now (pi's own vocabulary,
 * `@earendil-works/pi-ai::StopReason`); a message with **no** stop reason was finalised by a harness that wrote
 * none, which is not a claim that it is unfinished, so absent is treated as finished.
 */
const CUT_OFF_STOPS: ReadonlySet<string> = new Set(["aborted", "error", "length", "pending", "deferred"]);

export function classifyReport(input: { text: string; stopReason?: string; hasToolCall?: boolean }): ReportShape {
	if (!input.text.trim()) return "none";
	// Written as a call, and stopped there: the emission shape. A report that merely *names* the
	// markup in a sentence is still a report (`call-text.ts`).
	if (endsWithCallMarkup(input.text)) return "markup";
	if (input.hasToolCall) return "partial";
	if (input.stopReason !== undefined && CUT_OFF_STOPS.has(input.stopReason)) return "partial";
	return "report";
}

/** Is the run over in a way that owes the caller a report it did not write? */
export function planFinalReport(input: { exit: Exit; shape: ReportShape; allowed: boolean }): ReportPlan {
	if (!input.allowed) return { rescue: false, skip: "disabled" };
	// A run a human stopped is an answer, not a question; a run that died on the provider cannot answer either.
	if (input.exit === "aborted") return { rescue: false, skip: "aborted" };
	if (input.exit === "error") return { rescue: false, skip: "error" };
	if (input.shape === "report") return { rescue: false, skip: "reported" };
	return { rescue: true, reason: input.shape === "markup" ? "malformed" : "ceiling" };
}

/**
 * What the salvaged text of a finished run is worth, with no final turn involved.
 */
export function salvageSource(shape: ReportShape): ReportSource {
	return shape === "report" ? "final" : "salvaged";
}

/** What the final turn produced. */
export interface FinalReportOutcome {
	status: "reported" | "empty" | "timed-out" | "aborted" | "failed";
	text: string;
	/** What went wrong, when the turn itself did. */
	error?: string;
	elapsedMs: number;
}

/** How long the rescue will wait for a stuck session to go idle, before giving up on the turn. */
const RESCUE_SETTLE_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * One tool-less turn, bounded. Never rejects: a rescue that fails leaves the run's own text standing, and a
 * report is not worth a thrown error on top of a run that already ended badly.
 *
 * The grace window is the wall for the *whole* rescue — waiting out an interrupted generation, switching the
 * tools off, the request itself. Arming the timer only after the wait would leave the one path the ceiling exists
 * to bound (FM-2, "we always settle") hanging on a child session that never goes idle: `settleAbort` in `child.ts`
 * races the very same `abort()` for exactly that reason.
 */
export async function requestFinalReport(
	session: AgentSession,
	input: { prompt: string; graceMs?: number; signal: AbortSignal },
): Promise<FinalReportOutcome> {
	const startedAt = Date.now();
	const graceMs = input.graceMs ?? FINAL_REPORT_GRACE_MS;
	if (input.signal.aborted) return { status: "aborted", text: "", elapsedMs: 0 };

	type Over = "timed-out" | "aborted";
	let resolveOver!: (why: Over) => void;
	const over = new Promise<Over>((resolve) => {
		resolveOver = resolve;
	});
	const timer = setTimeout(() => resolveOver("timed-out"), Math.max(0, graceMs));
	timer.unref?.();
	if (input.signal.aborted) resolveOver("aborted");
	else input.signal.addEventListener("abort", () => resolveOver("aborted"), { once: true });

	// Whatever is still running is stopped inside the window, never in front of it. `stop` is idempotent, so the
	// timeout and the main flow cannot abort twice or leave a generation streaming into `dispose`.
	let stopping: Promise<void> | undefined;
	const stop = () => (stopping ??= Promise.race([session.abort().then(() => undefined).catch(() => undefined), sleep(RESCUE_SETTLE_MS)]));
	void over.then(() => {
		void stop();
	});

	const opened = (async () => {
		// The turn may not start while another one is still running, and the whole point of the rescue is that it
		// arrives on a run that was cut off mid-generation. `abort()` waits for the session to go idle.
		try {
			if (session.isStreaming) await session.abort();
			else if (typeof session.waitForIdle === "function") await session.waitForIdle();
		} catch {
			/* an idle session that will not say so is still a session we can ask */
		}
		try {
			// No tools: a message is the only move left.
			session.setActiveToolsByName([]);
			// A reminder the run queued would be delivered *into* this turn, and it asks for the opposite.
			session.clearQueue();
		} catch {
			/* a session that will not give its tools up still gets asked: the prompt says no calls are wanted */
		}
	})();

	if ((await Promise.race([opened.then(() => "ready" as const), over])) !== "ready") {
		clearTimeout(timer);
		return { status: "timed-out", text: "", elapsedMs: Date.now() - startedAt };
	}

	// Only what the final turn itself wrote counts as its report: `messages` still carries the fragment the run was
	// cut off on, and reading it back here would record the narration as the answer that was meant to replace it.
	const before = session.messages.length;
	const asked = session
		.prompt(input.prompt, { expandPromptTemplates: false })
		.then(() => "reported" as const)
		.catch((error: unknown) => ({ failed: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }));
	const raced = await Promise.race([asked, over]);
	if (raced !== "reported" && raced !== "timed-out" && raced !== "aborted") {
		await stop();
		clearTimeout(timer);
		return {
			status: "failed",
			text: lastAssistantText(session.messages.slice(before)),
			error: raced.failed,
			elapsedMs: Date.now() - startedAt,
		};
	}
	if (raced !== "reported") await stop();
	clearTimeout(timer);
	const text = lastAssistantText(session.messages.slice(before));
	const elapsedMs = Date.now() - startedAt;
	if (raced === "timed-out") return { status: "timed-out", text, elapsedMs };
	if (raced === "aborted") return { status: "aborted", text, elapsedMs };
	return { status: text.trim() ? "reported" : "empty", text, elapsedMs };
}
