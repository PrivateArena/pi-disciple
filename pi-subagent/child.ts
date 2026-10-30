/**
 * Child session lifecycle (plan steps 13 and 14).
 *
 * The child is an in-process `AgentSession` with zero extensions, compaction off, a bounded retry, its
 * own transcript under `<parent session dir>/subagent/`, and only the shim tools it was given — so it
 * cannot reach a real built-in tool and cannot spawn a sub-subagent.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
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

export interface RunProgress {
	turns: number;
	toolCalls: number;
	lastTool?: string;
	elapsedMs: number;
}

export type Exit = "done" | "aborted" | "timeout" | "maxTurns" | "callLimit" | "overflow" | "error";

/** Which budget ran out. */
export type CeilingReason = "maxTurns" | "timeout";

/** The state of a run at the moment its budget is spent — what the human decides on. */
export interface CeilingAsk {
	reason: CeilingReason;
	role: string;
	/** What the child was told to do, whole — the human decides on this, not on a summary. */
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

/** `aborted > timeout > callLimit > overflow > maxTurns > error > done` (red-team §7). */
const EXIT_PRECEDENCE: readonly Exit[] = ["aborted", "timeout", "callLimit", "overflow", "maxTurns", "error", "done"];

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

export function childSessionDir(parentSessionDir: string): string {
	return join(parentSessionDir, "subagent");
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
					if (turns >= budget.maxTurns) {
						// A spent turn budget is a question before it is a verdict (`reachCeiling`): with a broker the
						// human decides, without one this is exactly the steer this run always got.
						void reachCeiling("maxTurns");
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
	// Mutable, because the human can hand out more of both mid-run (`pi-subagent/ceiling.ts`).
	const budget = { maxTurns: input.role.maxTurns, timeoutMinutes: input.role.timeoutMinutes };

	let softTimer: ReturnType<typeof setTimeout> | undefined;
	let hardTimer: ReturnType<typeof setTimeout> | undefined;
	const slackMs = input.hardSlackMs ?? HARD_SETTLE_MS;
	const reportGraceMs = input.reportGraceMs ?? REPORT_GRACE_MS;
	// Absolute timestamps: a deferral re-arms the ceiling, and so does a granted extension, so durations
	// would drift with every grant.
	let softAt = Date.now() + budget.timeoutMinutes * 60_000;
	let hardAt = softAt + slackMs;
	// The absolute wall: the hard ceiling plus a window reserved for the report. Past this, the clock wins
	// whatever the child is doing, so a delegation cannot become unbounded.
	let reportWallAt = hardAt + reportGraceMs;
	let grantedToolGrace = false;
	let ceiling: CeilingReport | undefined;
	/** The run gets one offer, whatever it answered: a second dialog would be the same question twice. */
	let offerSettled = false;
	let offerPending: Promise<void> | undefined;
	/** Until when the hard ceiling waits for an answer, bounded so no run can outlive its own dialog. */
	let offerHoldUntil = 0;
	const offerHoldMs = input.ceilingHoldMs ?? CEILING_OFFER_HOLD_MS;
	/** The race is over: an answer arriving now can no longer change what the run did. */
	let settled = false;
	const abortWait = new Promise<"aborted">((resolve) => {
		if (input.signal.aborted) resolve("aborted");
		else input.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
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
		if (isWritingReport()) return void armHardAt(reportWallAt);
		if (!grantedToolGrace && isExecutingTool()) {
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
			emit();
		}, Math.max(0, softAt - Date.now()));
		softTimer.unref?.();
	}

	armHardAt(hardAt);
	armSoft();

	// ------------------------------------------------------------------------ the ceiling question

	/** The child is told to conclude, and a spent turn budget is what the exit will say. */
	function enforceCeiling(reason: CeilingReason): void {
		if (reason === "maxTurns") {
			exit = pickEarlier(exit, "maxTurns");
			steerForEnd(`The ${input.role.name} role reached its limit of ${budget.maxTurns} turns`);
			return;
		}
		steerForEnd(`The ${input.role.name} role passed its ${budget.timeoutMinutes} minute budget`);
	}

	function applyCeilingGrant(reason: CeilingReason, grant: CeilingGrant): void {
		budget.maxTurns += grant.turns;
		budget.timeoutMinutes += grant.minutes;
		ceiling = { reason, outcome: "granted", turns: grant.turns, minutes: grant.minutes };
		// The new clock starts at the answer, not at the budget that just expired: "+5 minutes" means five
		// more from now, and the tool grace is a fresh run's privilege, not this one's leftover.
		softAt = Date.now() + grant.minutes * 60_000;
		hardAt = softAt + slackMs;
		reportWallAt = hardAt + reportGraceMs;
		grantedToolGrace = false;
		armSoft();
		armHard();
		// Not a `steerForEnd`: this is the opposite ask, and it must not spend the child's two "conclude now".
		void session
			.steer(
				`The user extended this run by ${grant.turns} turns and ${grant.minutes} minutes — it now has ${budget.maxTurns} turns and ${budget.timeoutMinutes} minutes. Continue the task, and report before the new limit.`,
			)
			.catch(() => undefined);
	}

	async function askCeiling(reason: CeilingReason): Promise<CeilingAnswer> {
		// Hold the ceiling first: an answer two minutes late must not arrive to a killed run. The dialog is
		// expected to time out inside this window (`CEILING_DIALOG_TIMEOUT_MS`); this is the backstop.
		offerHoldUntil = Date.now() + offerHoldMs;
		armHard();
		try {
			const ask: CeilingAsk = {
				reason,
				role: input.role.name,
				task: input.task,
				turns,
				toolCalls,
				lastTool,
				elapsedMs: Date.now() - startedAt,
				maxTurns: budget.maxTurns,
				timeoutMinutes: budget.timeoutMinutes,
			};
			return (await input.onCeiling?.(ask)) ?? { outcome: "no_ui" };
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
		if (offerSettled || !input.onCeiling) {
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
				ceiling = { reason, outcome: answer.outcome, turns: 0, minutes: 0 };
				enforceCeiling(reason);
			}
			done();
		});
		return offerPending;
	}

	try {
		const raced = await Promise.race([
			session.prompt(`${CHILD_TASK_WRAPPER}${input.task}`, { expandPromptTemplates: false }).then(() => "done" as const),
			abortWait,
			deadline,
		]);
		if (raced === "aborted") exit = pickEarlier(exit, "aborted");
		else if (raced === "timeout") exit = pickEarlier(exit, "timeout");
		else if (exit === "done") exit = "done";
	} catch (error) {
		exit = pickEarlier(exit, "error");
		errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	} finally {
		// No answer after this point can change the run: the offer, if one is still open, has nothing left to
		// extend, and enforcing the ceiling would stamp an exit onto a run that already ended.
		settled = true;
		offerHoldUntil = 0;
		unsubscribe();
		clearTimeout(softTimer);
		clearTimeout(hardTimer);
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

/** The last assistant message carries the provider failure (`stopReason: "error"`) when a run dies quietly. */
function lastAssistantError(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "assistant") continue;
		const stop = (message as { stopReason?: string; errorMessage?: string }).stopReason;
		if (stop === "error") return (message as { errorMessage?: string }).errorMessage ?? "the model returned an error response";
		return undefined;
	}
	return undefined;
}

/** A timed-out or aborted run must not leave the child's tools executing (FM-2, FM-3). */
async function settleAbort(session: AgentSession, signal: AbortSignal): Promise<void> {
	if (!session.isStreaming && !signal.aborted) return;
	await Promise.race([session.abort().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())]);
}

function pickEarlier(a: Exit, b: Exit): Exit {
	return EXIT_PRECEDENCE.indexOf(a) <= EXIT_PRECEDENCE.indexOf(b) ? a : b;
}

/** FM-16: past 90 % of the window the child is told to conclude. */
export const OVERFLOW_RATIO = 0.9;

/** Grace period after the soft timeout before the run is abandoned (FM-2). */
export const HARD_SETTLE_MS = 60_000;

/**
 * How long past the hard ceiling a child may still take, reserved for the report. The ceiling asks for a
 * conclusion; this is the wall that lets a conclusion finish instead of being cut mid-sentence.
 */
export const REPORT_GRACE_MS = 3 * 60_000;

/** At most two "conclude now" asks per run: one per reason, and a reason never repeats. */
export const MAX_STEERS = 2;

/**
 * How long the hard ceiling is held while the human answers the extension question. The dialog is the one
 * that decides (see `ceiling.ts::CEILING_DIALOG_TIMEOUT_MS`, which must stay inside this window); this is the
 * backstop that keeps a run bounded if a broker never answers at all.
 */
export const CEILING_OFFER_HOLD_MS = 6 * 60_000;

/** Which content kinds an (possibly partial) assistant message carries. */
function contentShape(message: AgentMessage): { text: boolean; toolCall: boolean } {
	const shape = { text: false, toolCall: false };
	if (message.role !== "assistant") return shape;
	for (const part of message.content) {
		if (part.type === "toolCall") shape.toolCall = true;
		else if (part.type === "text" && part.text.trim()) shape.text = true;
	}
	return shape;
}

/** Provider retries inside a child: enough to ride out a transient 503; the ceiling still bounds the run. */
export const CHILD_RETRIES = 2;
export const CHILD_RETRY_MAX_DELAY_MS = 5_000;

/** Tokens the last assistant response occupied, from its reported usage. */
function contextTokens(message: AgentMessage): number {
	if (message.role !== "assistant") return 0;
	const usage = message.usage;
	if (!usage) return 0;
	return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

function lastAssistantText(messages: readonly AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();
		if (text) return text;
	}
	return "";
}

export function totalUsage(messages: readonly AgentMessage[]): Usage | undefined {
	const blank: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let seen = false;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = message.usage;
		if (!usage) continue;
		seen = true;
		blank.input += usage.input;
		blank.output += usage.output;
		blank.cacheRead += usage.cacheRead;
		blank.cacheWrite += usage.cacheWrite;
		blank.totalTokens += usage.totalTokens;
		blank.cost.input += usage.cost.input;
		blank.cost.output += usage.cost.output;
		blank.cost.cacheRead += usage.cost.cacheRead;
		blank.cost.cacheWrite += usage.cost.cacheWrite;
		blank.cost.total += usage.cost.total;
	}
	return seen ? blank : undefined;
}

/**
 * The sibling file a run's complete report is spilled to (see `pi-subagent/run.ts::composeResult`): the
 * transcript's own directory and basename, so one child's artifacts are one pair of files and pruning can
 * pair them without a second index.
 */
export function reportFileFor(transcriptFile: string): string {
	return transcriptFile.endsWith(".jsonl") ? `${transcriptFile.slice(0, -".jsonl".length)}.report.md` : `${transcriptFile}.report.md`;
}

/**
 * Keep the newest `keep` transcripts and delete the rest (FM-15). Report spill files are not counted as
 * transcripts — they follow their own: a deleted transcript takes its report with it, and a report left
 * behind by an already-deleted transcript is swept here too.
 */
export async function pruneTranscripts(dir: string, keep: number): Promise<number> {
	if (!existsSync(dir)) return 0;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	const stamped = names
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => {
			const path = join(dir, name);
			let mtimeMs = 0;
			try {
				mtimeMs = statSync(path).mtimeMs;
			} catch {
				/* ignore unreadable entries */
			}
			return { path, mtimeMs };
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const kept = stamped.slice(0, Math.max(0, keep));
	const keptReports = new Set(kept.map((entry) => reportFileFor(entry.path)));
	const victims = stamped.slice(kept.length).map((entry) => entry.path);
	// Every report whose transcript is not in the kept set is stale — deleted this pass or in an earlier one.
	const staleReports = names.filter((name) => name.endsWith(".report.md")).map((name) => join(dir, name)).filter((report) => !keptReports.has(report));
	let removed = 0;
	for (const victim of [...victims, ...staleReports]) {
		try {
			await rm(victim, { force: true });
			removed += victim.endsWith(".jsonl") ? 1 : 0;
		} catch {
			/* best effort */
		}
	}
	return removed;
}
