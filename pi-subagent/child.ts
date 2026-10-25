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
	/** The only test seam in this file: replaces `createAgentSession`. */
	sessionFactory?: (options: CreateAgentSessionOptions) => Promise<{ session: AgentSession }>;
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
	let summariseSteers = 0;

	const emit = () => input.onProgress({ turns, toolCalls, lastTool, elapsedMs: Date.now() - startedAt });
	const contextWindow = input.model?.contextWindow ?? 0;
	const steerForEnd = (why: string) => {
		if (summariseSteers++ > 0) return;
		void session.steer(`${why}. Summarise your findings now, in the final message, with no more tool calls.`).catch(() => undefined);
	};

	const unsubscribe = session.subscribe((event) => {
		switch (event.type) {
			case "message_end": {
				if (event.message.role === "assistant") {
					turns++;
					if (turns >= input.role.maxTurns) {
						exit = pickEarlier(exit, "maxTurns");
						steerForEnd(`The ${input.role.name} role reached its limit of ${input.role.maxTurns} turns`);
					} else if (contextWindow > 0 && contextTokens(event.message) > contextWindow * OVERFLOW_RATIO) {
						exit = pickEarlier(exit, "overflow");
						steerForEnd("The context window is nearly full");
					}
				}
				emit();
				break;
			}
			case "tool_execution_start": {
				toolCalls++;
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

	let softTimer: ReturnType<typeof setTimeout> | undefined;
	let hardTimer: ReturnType<typeof setTimeout> | undefined;
	const softMs = input.role.timeoutMinutes * 60_000;
	const hardMs = softMs + (input.hardSlackMs ?? HARD_SETTLE_MS);
	const abortWait = new Promise<"aborted">((resolve) => {
		if (input.signal.aborted) resolve("aborted");
		else input.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
	});
	// The soft budget only asks for a conclusion; the hard ceiling is what guarantees we settle (FM-2).
	const deadline = new Promise<"timeout">((resolve) => {
		hardTimer = setTimeout(() => resolve("timeout"), hardMs);
		hardTimer.unref?.();
	});
	softTimer = setTimeout(() => {
		steerForEnd(`The ${input.role.name} role passed its ${input.role.timeoutMinutes} minute budget`);
		emit();
	}, softMs);
	softTimer.unref?.();

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

/** Keep the newest `keep` transcripts and delete the rest (FM-15). */
export async function pruneTranscripts(dir: string, keep: number): Promise<number> {
	if (!existsSync(dir)) return 0;
	let files: string[];
	try {
		files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return 0;
	}
	const stamped = files
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
	const victims = stamped.slice(Math.max(0, keep));
	let removed = 0;
	for (const victim of victims) {
		try {
			await rm(victim.path, { force: true });
			removed++;
		} catch {
			/* best effort */
		}
	}
	return removed;
}
