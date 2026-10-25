/**
 * Run guard and result composition (plan steps 15 and 16), kept out of `index.ts` so both are unit
 * testable without a live provider.
 */

import { truncateHead, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ChildResult, RunProgress } from "./child.ts";
import type { RoleName } from "./roles.ts";

/**
 * One child at a time, stored on `globalThis` under a well-known symbol so a `/reload` — which
 * replaces the module registry but not the process — cannot start a second one (FM-14).
 */
export const RUN_GUARD_KEY = Symbol.for("pi-subagent.run");

export interface RunGuard {
	callId: string;
	role: RoleName;
	startedAt: number;
	abort: () => void;
}

type GuardStore = typeof globalThis & { [RUN_GUARD_KEY]?: RunGuard };

export function currentGuard(): RunGuard | undefined {
	return (globalThis as GuardStore)[RUN_GUARD_KEY];
}

/** Throws when another child holds the guard; the message tells the model what to do instead. */
export function claimGuard(guard: RunGuard): never | void {
	const running = currentGuard();
	if (running) {
		throw new Error(
			`pi-subagent: one subagent at a time — ${running.role} (call ${running.callId}) has been running for ` +
				`${Math.round((Date.now() - running.startedAt) / 1000)}s. Wait for it to finish or press Esc.`,
		);
	}
	(globalThis as GuardStore)[RUN_GUARD_KEY] = guard;
}

export function releaseGuard(callId: string): void {
	if (currentGuard()?.callId === callId) delete (globalThis as GuardStore)[RUN_GUARD_KEY];
}

export interface SubagentDetails {
	role: RoleName;
	exit: ChildResult["exit"];
	turns: number;
	toolCalls: number;
	childSessionFile?: string;
	childSessionId?: string;
	truncated: boolean;
	elapsedMs: number;
	removedTranscripts?: number;
	nestedCalls?: number;
	shimTools?: string[];
	error?: string;
}

export function formatProgress(progress: RunProgress, toolCount: number): string {
	return (
		`subagent running · turn ${progress.turns} · ${progress.toolCalls} calls · ` +
		`${progress.lastTool ?? "thinking"} · ${Math.round(progress.elapsedMs / 1000)}s · ${toolCount} tools`
	);
}

/**
 * Status header first, then the answer head (A12: `truncateHead` keeps the *first* bytes, so the
 * child's leading conclusion survives), then the pointer to the full transcript.
 */
export function composeResult(
	result: ChildResult,
	role: RoleName,
	maxResultBytes: number,
	elapsedMs: number,
	extra: Partial<SubagentDetails> = {},
): AgentToolResult<SubagentDetails> {
	// `truncateHead` never returns a partial line, so a one-line answer needs a plain slice.
	const truncated = truncateHead(result.text, { maxBytes: maxResultBytes });
	const body = (truncated.firstLineExceedsLimit ? result.text.slice(0, maxResultBytes) : truncated.content).trim();
	const sessionFile = result.childSessionFile ?? extra.childSessionFile;
	const status = result.exit === "done" ? "DONE" : `INCOMPLETE (${result.exit})`;
	const header =
		`[subagent ${role} · ${status} · ${result.turns} turns · ${result.toolCalls} tool calls · ${(elapsedMs / 1000).toFixed(1)}s]` +
		(sessionFile ? `\ntranscript: ${sessionFile}` : "") +
		(result.error ? `\nerror: ${result.error}` : "");
	const answer = body || "(the subagent returned no text)";
	const footer = truncated.truncated
		? `\n\n[… output truncated: ${Math.min(maxResultBytes, truncated.totalBytes)}/${truncated.totalBytes} bytes shown; the full result is in the transcript above.]`
		: "";
	return {
		content: [{ type: "text", text: `${header}\n\n${answer}${footer}` }],
		details: {
			role,
			exit: result.exit,
			turns: result.turns,
			toolCalls: result.toolCalls,
			childSessionFile: sessionFile,
			childSessionId: result.childSessionId,
			truncated: truncated.truncated,
			elapsedMs,
			...extra,
		},
		usage: result.usage,
		isError: result.exit === "error",
	};
}
