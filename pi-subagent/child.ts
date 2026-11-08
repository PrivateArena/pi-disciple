/**
 * Child session lifecycle (plan steps 13 and 14).
 *
 * The child is an in-process `AgentSession` with zero extensions, compaction off, a bounded retry, its
 * own transcript under `<parent session dir>/subagent/`, and only the shim tools it was given — so it
 * cannot reach a real built-in tool and cannot spawn a sub-subagent.
 */

import type { Usage } from "@earendil-works/pi-ai";
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
import { pickEarlier, type Exit } from "./run-exit.ts";
import { contentShape, contextTokens, lastAssistantError, lastAssistantText, totalUsage } from "./child-messages.ts";
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

export interface RunProgress {
	turns: number;
	toolCalls: number;
	lastTool?: string;
	elapsedMs: number;
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

	let turns = 0;
	let toolCalls = 0;
	let lastTool: string | undefined;
	let exit: Exit = "done";
	let errorText: string | undefined;
	let ceiling: CeilingReport | undefined;
	const steeredOn = new Set<string>();
	/** Content kinds seen so far in the assistant message that is streaming right now. */
	let streaming: { text: boolean; toolCall: boolean } = { text: false, toolCall: false };
	const runningTools = new Set<string>();

	const emit = () => input.onProgress({ turns, toolCalls, lastTool, elapsedMs: Date.now() - startedAt });
	const contextWindow = input.model?.contextWindow ?? 0;
	// Each reason asks once — an earlier "conclude now" can be swallowed by the queue, and the timeout ask
	// is the one that must land. Two asks is the most a child gets before the ceiling is enforced.
	const steerForEnd = (why: string) => {
		if (steeredOn.size >= MAX_STEERS || steeredOn.has(why)) return;
		steeredOn.add(why);
		void session.steer(`${why}. Summarise your findings now, in the final message, with no more tool calls.`).catch(() => undefined);
	};

	/** The report is the artifact the run exists to produce; a turn asking for a tool is not. */
	const isWritingReport = () => streaming.text && !streaming.toolCall;
	const isExecutingTool = () => runningTools.size > 0 || (session.state?.pendingToolCalls?.size ?? 0) > 0;

	const unsubscribe = session.subscribe((event) => {
		switch (event.type) {
			case "message_start":
			case "message_update": {
				if (event.message.role === "assistant") streaming = contentShape(event.message);
				break;
			}
			case "message_end": {
				if (event.message.role === "assistant") {
					streaming = { text: false, toolCall: false };
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
				break;
			}
			case "tool_execution_start": {
				toolCalls++;
				runningTools.add(event.toolCallId);
				lastTool = event.toolName;
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
			void session.steer(text).catch(() => undefined);
		},
		recordExit: (next) => {
			exit = pickEarlier(exit, next);
		},
		recordCeiling: (report) => {
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
	try {
		const raced = await Promise.race([
			session.prompt(`${CHILD_TASK_WRAPPER}${input.task}`, { expandPromptTemplates: false }).then(() => "done" as const),
			clock.abortWait,
			clock.deadline,
		]);
		if (raced === "aborted") exit = pickEarlier(exit, "aborted");
		else if (raced === "timeout") exit = pickEarlier(exit, "timeout");
		else if (exit === "done") exit = "done";
	} catch (error) {
		exit = pickEarlier(exit, "error");
		errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	} finally {
		clock.teardown();
		unsubscribe();
		await settleAbort(session, input.signal);
		session.dispose();
	}

	emit();
	const providerError = lastAssistantError(session.messages);
	// A failed provider call is an error result, never a silent "DONE" with no text.
	const finalExit: Exit = exit === "done" && providerError ? "error" : exit;
	return {
		text: lastAssistantText(session.messages),
		exit: finalExit,
		turns,
		toolCalls,
		childSessionFile: session.sessionFile,
		childSessionId: session.sessionManager.getSessionId(),
		usage: totalUsage(session.messages),
		error: errorText ?? (finalExit === "error" ? providerError : undefined),
		...(ceiling ? { ceiling } : {}),
	};
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

/** Provider retries inside a child: enough to ride out a transient 503; the ceiling still bounds the run. */
export const CHILD_RETRIES = 2;
export const CHILD_RETRY_MAX_DELAY_MS = 5_000;
