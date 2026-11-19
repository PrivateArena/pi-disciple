/**
 * Child session lifecycle (plan steps 13 and 14).
 *
 * The child is an in-process `AgentSession` with zero extensions, compaction off, a bounded retry, its
 * own transcript under `<parent session dir>/subagent/`, and only the shim tools it was given — so it
 * cannot reach a real built-in tool and cannot spawn a sub-subagent.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createAgentSession,
	createExtensionRuntime,
	type AgentSession,
	type CreateAgentSessionOptions,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Role } from "./roles.ts";
import { buildChildSystemPrompt, CHILD_TASK_WRAPPER } from "./prompt.ts";
import { NESTED_CALL_CEILING } from "./shims.ts";
import { childSessionDir } from "./transcript/paths.ts";
import { debugLogDir, logSlice, openTurnLog } from "./transcript/turn-log.ts";
import { pickEarlier, type Exit } from "./run-exit.ts";
import {
	assistantText,
	assistantThinking,
	contentShape,
	contextTokens,
	lastAssistantError,
	lastAssistantMessage,
	lastAssistantText,
	totalUsage,
} from "./child-messages.ts";
import { callTextEvidence } from "./call-text.ts";
import { createReasoningTrail, type ReasoningTrail } from "./reasoning.ts";
import { classifyReport, planFinalReport, finalReportPrompt, requestFinalReport, salvageSource, type ReportReason, type ReportShape, type ReportSource } from "./final-report.ts";
import type { CeilingAskHandler, CeilingReport } from "./budget/ceiling-vocabulary.ts";
import { createCeilingClock } from "./budget/ceiling-clock.ts";

/**
 * The facade over the `transcript/` package: `childSessionDir`, `reportFileFor` and `pruneTranscripts` are
 * still reachable from here, while the two concerns each live in their own module — `transcript/paths.ts`
 * (where a child's artifacts go and how they are named) and `transcript/retention.ts` (which old ones get
 * deleted). Nothing under `transcript/` imports this file.
 */
export { childSessionDir, reportFileFor } from "./transcript/paths.ts";
export { pruneTranscripts } from "./transcript/retention.ts";

/**
 * The facade over the leaves this file is assembled from, in the same shape: `run-exit.ts` (the outcome
 * vocabulary — `Exit` was public and stays reachable, while its precedence list and combiner were module-private
 * and stay private to that file), `child-messages.ts` (the transcript readers — only `totalUsage` was public),
 * `budget/ceiling-vocabulary.ts` (the whole ceiling vocabulary, all of it public) and `budget/ceiling-clock.ts`
 * (the budget machine, of which only the three durations were public). Nothing under `budget/` imports this file.
 */
export type { Exit } from "./run-exit.ts";
export { totalUsage } from "./child-messages.ts";
export type { ReportSource, ReportReason } from "./final-report.ts";
export type {
	CeilingAnswer,
	CeilingAsk,
	CeilingAskHandler,
	CeilingGrant,
	CeilingOutcome,
	CeilingReason,
	CeilingReport,
} from "./budget/ceiling-vocabulary.ts";
export { CEILING_OFFER_HOLD_MS, HARD_SETTLE_MS, REPORT_GRACE_MS } from "./budget/ceiling-clock.ts";

/**
 * What the child is doing right now, as far as the run's own state can tell. The card needs the distinction
 * `activity` cannot make: that a child is writing its answer rather than still working on the problem.
 */
export type RunPhase = "thinking" | "writing" | "calling" | "finalReport";

export interface RunProgress {
	turns: number;
	toolCalls: number;
	lastTool?: string;
	elapsedMs: number;
	/** Live, not the phase of the last completed event — see `runChild`'s `refreshPhase`. */
	phase: RunPhase;
	/** Absent while the child has thought nothing (`reasoning.ts`); the transcript holds the whole record. */
	reasoning?: ReasoningTrail;
	/** The child's transcript, once pi has written one; absent while the file does not exist yet. */
	childSessionFile?: string;
	/** The harness's run log, when `subagent.debugLog` is on; absent exactly as in the settled result. */
	turnLogFile?: string;
}

export interface ChildResult {
	text: string;
	exit: Exit;
	turns: number;
	toolCalls: number;
	childSessionFile?: string;
	childSessionId?: string;
	usage?: Usage;
	error?: string;
	/** Absent when no budget was spent; present whenever the ceiling was reached, extended or not. */
	ceiling?: CeilingReport;
	/**
	 * Whether `text` is the child's report (`final`), the report of a tool-less final turn it was made to write
	 * (`rescued`), or the fragment it was cut off on (`salvaged`). The card and the model-facing header say so.
	 */
	reportSource: ReportSource;
	/** Why that final turn was asked for, when it was: `ceiling` ran out of budget, `malformed` wrote a call. */
	reportReason?: ReportReason;
	/** Times the child was told that a tool call written as text runs nothing. */
	reminders: number;
	/** Where this run's harness log went, when `subagent.debugLog` is on. */
	turnLogFile?: string;
	/**
	 * The child's thinking, bounded to what a progress event may carry (`reasoning.ts`), so a card that stays open
	 * after the run can still show what it was thinking. Absent when it thought nothing.
	 */
	reasoning?: ReasoningTrail;
}

export interface ChildRunInput {
	role: Role;
	task: string;
	cwd: string;
	agentDir: string;
	model: CreateAgentSessionOptions["model"];
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	/** Shim tools, already filtered by role and gate policy. */
	tools: ToolDefinition[];
	/** Parent session directory; the child writes to `<sessionDir>/subagent/`. */
	sessionDir: string;
	signal: AbortSignal;
	onProgress: (progress: RunProgress) => void;
	/** Seconds between the soft budget and the hard ceiling; a test seam (FM-2). */
	hardSlackMs?: number;
	/** How long past the hard ceiling a run may still take to finish writing its report; a test seam. */
	reportGraceMs?: number;
	/**
	 * How long the hard ceiling waits for an answer to the extension question; a test seam. The real window is
	 * the backstop behind the dialog's own timeout, so it must not shrink without the dialog's shrinking too.
	 */
	ceilingHoldMs?: number;
	/**
	 * Write the tool-less final report turn even when the child could not produce a report itself
	 * (`subagent.requireFinalReport`). Absent means yes: the guarantee is the point of the run.
	 */
	requireFinalReport?: boolean;
	/** How long that final turn may take; a test seam. */
	finalReportGraceMs?: number;
	/** One JSONL line per harness event, in `debugLogDir` (`subagent.debugLog`). */
	debugLog?: boolean;
	/** Resolved directory for that log (`subagent.debugLogDir`). */
	debugLogDir?: string;
	/** The parent's `subagent` tool call id, which names the debug log file. */
	callId?: string;
	/** The only test seam in this file: replaces `createAgentSession`. */
	sessionFactory?: (options: CreateAgentSessionOptions) => Promise<{ session: AgentSession }>;
	/**
	 * Ask the human for an extension when a budget runs out (`pi-subagent/ceiling.ts`). Absent means a spent
	 * budget is a spent budget: the child is steered to conclude, which is what always happened.
	 */
	onCeiling?: CeilingAskHandler;
}

/** Stub loader shaped exactly like `P/examples/sdk/12-full-control.ts`: no extensions, no skills. */
export function makeNullLoader(systemPrompt: string, contextFiles: Array<{ path: string; content: string }> = []): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: contextFiles }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

export async function runChild(input: ChildRunInput): Promise<ChildResult> {
	const startedAt = Date.now();
	const sessionDir = childSessionDir(input.sessionDir);
	const options: CreateAgentSessionOptions = {
		cwd: input.cwd,
		agentDir: input.agentDir,
		model: input.model,
		thinkingLevel: input.thinkingLevel ?? "off",
		// A5: the allowlist filters customTools too, so every shim name must be listed here.
		tools: input.tools.map((tool) => tool.name),
		customTools: input.tools,
		resourceLoader: makeNullLoader(buildChildSystemPrompt(input.role, input.cwd)),
		sessionManager: SessionManager.create(input.cwd, sessionDir),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			// Bounded retry: free/upstream providers 503 routinely, and the hard ceiling already bounds the run.
			retry: { enabled: true, maxRetries: CHILD_RETRIES, maxAgentDelayMs: CHILD_RETRY_MAX_DELAY_MS },
		}),
	};

	const { session } = await (input.sessionFactory ?? ((o) => createAgentSession(o)))(options);

	// One JSONL per run: what the child thought, what the ceiling did, and what the final turn said, none of
	// which the transcript records (`transcript/turn-log.ts`). It cannot change the run, so nothing reads it back.
	const log = openTurnLog({
		enabled: input.debugLog === true,
		dir: input.debugLog === true ? debugLogDir(input.debugLogDir) : undefined,
		role: input.role.name,
		id: input.callId ?? safeSessionId(session),
		startedAt,
	});
	log.line("run_start", {
		task: input.task,
		cwd: input.cwd,
		role: input.role.name,
		model: input.model ? { provider: input.model.provider, id: input.model.id } : undefined,
		thinkingLevel: input.thinkingLevel ?? "off",
		maxTurns: input.role.maxTurns,
		timeoutMinutes: input.role.timeoutMinutes,
		tools: input.tools.map((tool) => tool.name),
		requireFinalReport: input.requireFinalReport !== false,
	});

	let turns = 0;
	let toolCalls = 0;
	let lastTool: string | undefined;
	let exit: Exit = "done";
	let errorText: string | undefined;
	let ceiling: CeilingReport | undefined;
	const steeredOn = new Set<string>();
	/** Content kinds seen so far in the assistant message that is streaming right now. */
	let streaming: { text: boolean; toolCall: boolean; callText: boolean } = { text: false, toolCall: false, callText: false };
	const runningTools = new Set<string>();
	/** Times the child was told that a call written as text ran nothing. */
	let reminders = 0;
	/** While the tool-less final turn runs there is no call to remind about, only a report to ask for. */
	let inFinalTurn = false;
	/** The child's thinking, kept for the card and clipped to what one may carry (`reasoning.ts`). */
	const trail = createReasoningTrail();
	/** The phase the card was last told about — the heartbeat re-uses it, so a change must be emitted (`refreshPhase`). */
	let phase: RunPhase = "thinking";

	// `emit` reads `phaseOf` and the trail declared below it: every call site of `emit` is a callback (the event
	// subscriber, the ceiling clock, the end of the run), so all of them execute after those declarations — legal
	// today, but not locally obvious, which is why the order is spelled out here rather than changed.
	const emit = () => {
		phase = phaseOf();
		input.onProgress({
			turns,
			toolCalls,
			lastTool,
			elapsedMs: Date.now() - startedAt,
			phase,
			reasoning: trail.snapshot(),
			// pi's own fields, both assigned only once the file exists — undefined before that is the truth.
			childSessionFile: session.sessionFile,
			turnLogFile: log.file,
		});
	};
	const contextWindow = input.model?.contextWindow ?? 0;
	// Each reason asks once — an earlier "conclude now" can be swallowed by the queue, and the timeout ask
	// is the one that must land. Two asks is the most a child gets before the ceiling is enforced.
	const steerForEnd = (why: string) => {
		if (steeredOn.size >= MAX_STEERS || steeredOn.has(why)) return;
		steeredOn.add(why);
		log.line("steer", { why });
		void session.steer(`${why}. Summarise your findings now, in the final message, with no more tool calls.`).catch(() => undefined);
	};

	/**
	 * A call written on the text channel ends the run: pi sees no tool call, so the loop stops on the sentence.
	 * Say so in place — the same recovery `pi-gate`'s output guard does for the parent, which a child has no
	 * extension to run for it (`call-text.ts`).
	 */
	const remindAboutCallText = (message: AgentMessage) => {
		const text = assistantText(message);
		const hit = callTextEvidence(text);
		// A message that also made a real call did call; the markup was prose beside it.
		if (!hit || inFinalTurn || hasToolCall(message)) return;
		if (reminders >= MAX_CALL_REMINDERS) {
			log.line("call_text_ignored", { ...hit, reminders });
			return;
		}
		reminders++;
		log.line("call_text_reminder", { ...hit, reminders });
		void session.steer(callTextReminder(hit)).catch(() => undefined);
	};

	/** The report is the artifact the run exists to produce; a turn asking for a tool is not, and neither is the markup of one. */
	const isWritingReport = () => streaming.text && !streaming.toolCall && !streaming.callText;
	const isExecutingTool = () => runningTools.size > 0 || (session.state?.pendingToolCalls?.size ?? 0) > 0;

	/**
	 * What the child is doing, out of the state the run already keeps. `isWritingReport` is the run's existing
	 * definition of "a report is being written" — it is what the ceiling clock defers a hard stop for — and
	 * `inFinalTurn` is the guaranteed-report turn, so the card says "final report" exactly where the run is really
	 * writing one, and "writing" exactly where the clock would not dare cut the child off.
	 */
	const phaseOf = (): RunPhase =>
		inFinalTurn ? "finalReport" : isWritingReport() ? "writing" : runningTools.size > 0 ? "calling" : "thinking";

	/**
	 * The phase has to be *live*, not merely correct at the next event: `index.ts`'s heartbeat re-emits the last
	 * `RunProgress`, so a phase that only moved at `message_end` would be one turn stale on a silent child — and
	 * the report turn is the one the card is asked about. Called where the streaming shape is already recomputed
	 * (so no per-token cost beyond one comparison) and wherever the final turn starts or ends; it emits only on an
	 * actual change, because a card that is told "still writing" every tick is noise on the wire.
	 */
	const refreshPhase = () => {
		if (phaseOf() === phase) return;
		emit();
	};

	const unsubscribe = session.subscribe((event) => {
		switch (event.type) {
			case "message_start":
			case "message_update": {
				if (event.message.role === "assistant") streaming = contentShape(event.message);
				refreshPhase();
				break;
			}
			case "message_end": {
				log.line("message_end", logMessage(event.message));
				// The final turn is logged, not counted: it is the guarantee, not more work by the child.
				if (inFinalTurn) break;
				if (event.message.role === "assistant") {
					streaming = { text: false, toolCall: false, callText: false };
					remindAboutCallText(event.message);
					// The number the card prints is the turn about to finish: `turns` counts finished turns and is
					// incremented below, so the thought it just had belongs to `turns + 1`.
					trail.add(turns + 1, assistantThinking(event.message));
					turns++;
					if (turns >= clock.maxTurns()) {
						// A spent turn budget is a question before it is a verdict (`budget/ceiling-clock.ts`): with a
						// broker the human decides, without one this is exactly the steer this run always got.
						void clock.reach("maxTurns");
					} else if (contextWindow > 0 && contextTokens(event.message) > contextWindow * OVERFLOW_RATIO) {
						exit = pickEarlier(exit, "overflow");
						steerForEnd("The context window is nearly full");
					}
				}
				emit();
				break;
			}
			case "tool_execution_end": {
				runningTools.delete(event.toolCallId);
				log.line("tool_end", { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
				break;
			}
			case "tool_execution_start": {
				toolCalls++;
				runningTools.add(event.toolCallId);
				lastTool = event.toolName;
				log.line("tool_start", { toolCallId: event.toolCallId, toolName: event.toolName });
				if (toolCalls >= NESTED_CALL_CEILING) {
					exit = pickEarlier(exit, "callLimit");
					steerForEnd("The nested tool-call record limit was reached");
				}
				emit();
				break;
			}
			default:
				break;
		}
	});

	// --------------------------------------------------------------------------- the two budgets
	// The budgets, the ceiling they enforce and the one offer a spent budget may ask are a machine of their own
	// (`budget/ceiling-clock.ts`), and that machine owns all of that state. What stays here is the run's own: the
	// counters, the streaming and running-tool sets, the cap on "conclude now" asks, and the exit — which is
	// combined by `pickEarlier`, never overwritten, including by what the clock decides.
	const clock = createCeilingClock({
		role: input.role,
		task: input.task,
		signal: input.signal,
		counters: () => ({ turns, toolCalls, lastTool, elapsedMs: Date.now() - startedAt }),
		isWritingReport,
		isExecutingTool,
		steerToConclude: steerForEnd,
		steer: (text) => {
			log.line("steer", { why: "extension granted" });
			void session.steer(text).catch(() => undefined);
		},
		recordExit: (next) => {
			log.line("exit", { exit: next });
			exit = pickEarlier(exit, next);
		},
		recordCeiling: (report) => {
			log.line("ceiling", report);
			ceiling = report;
		},
		emit,
		onCeiling: input.onCeiling,
		hardSlackMs: input.hardSlackMs,
		reportGraceMs: input.reportGraceMs,
		ceilingHoldMs: input.ceilingHoldMs,
	});

	// Arm on the way into the prompt: the clock starts running the moment the child does.
	clock.arm();
	log.line("prompt", { text: `${CHILD_TASK_WRAPPER}${input.task}` });
	try {
		const raced = await Promise.race([
			session.prompt(`${CHILD_TASK_WRAPPER}${input.task}`, { expandPromptTemplates: false }).then(() => "done" as const),
			clock.abortWait,
			clock.deadline,
		]);
		log.line("race", { raced, exit });
		if (raced === "aborted") exit = pickEarlier(exit, "aborted");
		else if (raced === "timeout") exit = pickEarlier(exit, "timeout");
		else if (exit === "done") exit = "done";
	} catch (error) {
		exit = pickEarlier(exit, "error");
		errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	} finally {
		clock.teardown();
		await settleAbort(session, input.signal);
	}

	const providerError = lastAssistantError(session.messages);
	// A failed provider call is an error result, never a silent "DONE" with no text.
	let finalExit: Exit = exit === "done" && providerError ? "error" : exit;

	// --------------------------------------------------------------------- the report guarantee
	// What the child left behind is only a report if the message that carries it actually finished. Whether the
	// run ended on its own is not the question: a child cut off mid-turn has a "final message" that is the
	// narration of a step it never took, and that text is what a parent will otherwise read as an answer. One
	// tool-less turn on the same session fixes every case except the ones a human or a provider already answered
	// (`final-report.ts`), and the subscription stays open so the turn is logged like any other.
	//
	// All of it sits inside one `finally` with `dispose`: reading the transcript can meet a message shaped
	// differently from the ones expected, and a debug reader must never be handed a leaked subscription, an
	// undisposed child session, or a generation still streaming behind the result.
	let report = "";
	let source: ReportSource = "salvaged";
	let reportReason: ReportReason | undefined;
	try {
		const fresh = reportShapeOf(session);
		// The freshest words, even when the message that carries them said nothing at all: an older sentence is
		// what the parent gets to read, but it is labelled a fragment, which is what it is.
		report = fresh.text || lastAssistantText(session.messages);
		let shape = fresh.shape;
		const plan = planFinalReport({ exit: finalExit, shape, allowed: input.requireFinalReport !== false });
		log.line("report_check", { exit: finalExit, shape, rescue: plan.rescue, skip: plan.skip, reminders });
		source = salvageSource(shape);
		if (plan.rescue && plan.reason) {
			reportReason = plan.reason;
			inFinalTurn = true;
			// The card is told before the turn starts, which is the whole point: "final report" while it is being
			// written, not after it is over.
			refreshPhase();
			log.line("final_report_start", { reason: plan.reason });
			const outcome = await requestFinalReport(session, {
				prompt: finalReportPrompt(plan.reason),
				graceMs: input.finalReportGraceMs,
				signal: input.signal,
			});
			inFinalTurn = false;
			refreshPhase();
			log.line("final_report_end", { ...outcome, text: logSlice(outcome.text) });
			// A stop that arrived during the rescue is the run's ending, whatever the clock said before it.
			if (outcome.status === "aborted") finalExit = pickEarlier(finalExit, "aborted");
			if (outcome.text.trim()) {
				report = outcome.text;
				shape = reportShapeOf(session).shape;
			}
			source = shape === "report" ? "rescued" : "salvaged";
		}
	} finally {
		unsubscribe();
		session.dispose();
	}

	try {
		emit();
	} catch {
		/* the card is about to be replaced by the result; a dead progress hook is not the run's problem */
	}
	log.line("run_end", {
		exit: finalExit,
		turns,
		toolCalls,
		reminders,
		reportSource: source,
		reportChars: report.length,
		elapsedMs: Date.now() - startedAt,
		error: errorText,
	});
	// Whoever reads this file next is the human debugging a run that just ended, so the queued lines land
	// before the result is handed back (`transcript/turn-log.ts::close`).
	await log.close();
	return {
		text: report,
		exit: finalExit,
		turns,
		toolCalls,
		childSessionFile: session.sessionFile,
		childSessionId: safeSessionId(session),
		usage: totalUsage(session.messages),
		error: errorText ?? (finalExit === "error" ? providerError : undefined),
		reportSource: source,
		...(reportReason ? { reportReason } : {}),
		reminders,
		...(log.file ? { turnLogFile: log.file } : {}),
		...(ceiling ? { ceiling } : {}),
		// Built while the run was still streaming thoughts (`trail` is read after `dispose`, but it is plain data).
		reasoning: trail.snapshot(),
	};
}

/**
 * The shape of the run's freshest words — text, stop reason and tool calls all read off *one* message, because
 * certifying an older sentence with a newer message's metadata is how a fragment gets called a report.
 */
function reportShapeOf(session: AgentSession): { text: string; shape: ReportShape } {
	const last = lastAssistantMessage(session.messages);
	const text = last ? assistantText(last) : "";
	const stopReason = (last as { stopReason?: string } | undefined)?.stopReason;
	return { text, shape: classifyReport({ text, stopReason, hasToolCall: last ? hasToolCall(last) : false }) };
}

/** Did this message make a real tool call? */
function hasToolCall(message: AgentMessage): boolean {
	const content = (message as unknown as { content?: { type: string }[] }).content;
	return content?.some((part) => part.type === "toolCall") ?? false;
}

/** The child's own id, which the card, the report file name and the debug log all need. */
function safeSessionId(session: AgentSession): string {
	try {
		return session.sessionManager.getSessionId();
	} catch {
		return "unknown";
	}
}

/**
 * One message of the child's exchange, in the shape the log wants: thinking whole (it is the reason people
 * read this file), a tool result cut to `LOG_RESULT_CHARS`, and the transcript path named for anything bigger.
 *
 * Defensive by necessity: this runs inside the event subscriber, so a message shaped differently from the ones
 * expected — a bare string content, a part with no type — must cost a log line at most, never a run.
 */
function logMessage(message: AgentMessage): Record<string, unknown> {
	const raw = message as unknown as { role?: string; stopReason?: string; toolName?: string; content?: unknown };
	const parts = Array.isArray(raw.content) ? raw.content : raw.content === undefined ? [] : [{ type: "text", text: String(raw.content) }];
	return {
		role: typeof raw.role === "string" ? raw.role : "unknown",
		stopReason: raw.stopReason,
		...(raw.toolName ? { toolName: raw.toolName } : {}),
		content: parts.map((part) => logPart(raw.role ?? "", part)),
	};
}

function logPart(role: string, part: unknown): Record<string, unknown> {
	const p = (part ?? {}) as { type?: string; text?: string; thinking?: string; name?: string; args?: unknown; id?: string };
	if (p.type === "thinking") return { type: "thinking", thinking: logSlice(String(p.thinking ?? ""), LOG_THINKING_CHARS) };
	if (p.type === "toolCall") return { type: "toolCall", id: p.id, name: p.name, args: logSlice(logArgs(p.args), LOG_ARGS_CHARS) };
	const text = typeof p.text === "string" ? p.text : p.text === undefined ? "" : String(p.text);
	// The child's own words are the artifact; everything else is evidence, and evidence is cheap to re-read.
	return { type: p.type ?? "unknown", text: role === "assistant" ? text : logSlice(text) };
}

/** How much reasoning is worth a kilobyte per turn on disk. */
export const LOG_THINKING_CHARS = 8_000;

/** How much of a tool call's arguments. A whole file body is in the transcript, which is the child's own dir. */
export const LOG_ARGS_CHARS = 2_000;

/** Tool arguments are arbitrary JSON; the log line must not throw on a circular or exotic value. */
function logArgs(args: unknown): string {
	try {
		return JSON.stringify(args) ?? "";
	} catch {
		return String(args);
	}
}

/** What the child is told when it wrote a call instead of making one. */
export function callTextReminder(hit: { evidence: string }): string {
	return (
		`Malformed tool call: you wrote \`${hit.evidence}\` as text, so nothing ran and your turn ends here. ` +
		"Tool calls go through the tool interface, not through the text of a message. Make the call properly now " +
		"if you meant to make it; otherwise write your final report without any call markup."
	);
}

/** A timed-out or aborted run must not leave the child's tools executing (FM-2, FM-3). */
async function settleAbort(session: AgentSession, signal: AbortSignal): Promise<void> {
	if (!session.isStreaming && !signal.aborted) return;
	await Promise.race([session.abort().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())]);
}

/** FM-16: past 90 % of the window the child is told to conclude. */
export const OVERFLOW_RATIO = 0.9;

/** At most two "conclude now" asks per run: one per reason, and a reason never repeats. */
export const MAX_STEERS = 2;

/**
 * At most two "that call did not run" reminders per run. A model that writes its calls as text after being told
 * twice is a model that will keep doing it, and the final turn is what the caller needs, not a third lecture.
 */
export const MAX_CALL_REMINDERS = 2;

/** Provider retries inside a child: enough to ride out a transient 503; the ceiling still bounds the run. */
export const CHILD_RETRIES = 2;
export const CHILD_RETRY_MAX_DELAY_MS = 5_000;
