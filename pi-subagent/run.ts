/**
 * Run guard and result composition (plan steps 15 and 16), kept out of `index.ts` so both are unit
 * testable without a live provider.
 */

import { truncateHead, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { ChildResult, Exit, RunProgress } from "./child.ts";
import type { RoleId } from "./roles.ts";

/**
 * One child at a time, stored on `globalThis` under a well-known symbol so a `/reload` — which
 * replaces the module registry but not the process — cannot start a second one (FM-14).
 */
export const RUN_GUARD_KEY = Symbol.for("pi-subagent.run");

export interface RunGuard {
	callId: string;
	role: RoleId;
	/** The role came from `subagent.defaultRole`, not from the model. Only the UI cares. */
	defaulted?: boolean;
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

/**
 * The run status a frontend understands.
 *
 * `@gotgenes/pi-subagents` put this vocabulary into the session JSONL first, so a frontend that draws a
 * subagent card at all keys its branches off these strings — a status it has never seen matches no
 * branch, and the card keeps showing the activity list instead of the result. Our own, finer exit
 * stays in `details.exit`; `uiStatus` is the bridge.
 */
export type SubagentUiStatus = "queued" | "running" | "completed" | "stopped" | "aborted" | "error";

/** Map our exit onto the frontend status vocabulary. */
export function uiStatus(exit: Exit): SubagentUiStatus {
	switch (exit) {
		case "done":
			return "completed";
		case "aborted":
		case "timeout":
			return "stopped";
		case "maxTurns":
		case "callLimit":
		case "overflow":
			return "aborted";
		case "error":
			return "error";
	}
}

/** Clip for a card row: a card gets a summary, never a whole field. */
export function clip(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/** `4.2k token`, or "" when the run reported no usage — never a guessed count. */
export function formatTokens(usage: Usage | undefined): string {
	const total = usage?.totalTokens ?? 0;
	if (total <= 0) return "";
	if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M token`;
	if (total >= 1000) return `${(total / 1000).toFixed(1)}k token`;
	return `${total} token`;
}

/** First non-empty line of a report, stripped of heading marks and clipped. */
export function previewOf(report: string, maxChars = 200): string {
	const line = report.split("\n").map((candidate) => candidate.trim()).find(Boolean) ?? "";
	return clip(line.replace(/^#+\s*/, ""), maxChars);
}

/**
 * The fields a subagent card is drawn from, named the way `@gotgenes/pi-subagents` names them
 * (`AgentDetails`, `GetResultDetails`) — that is the shape a frontend already knows how to read. They
 * sit beside our own fields; our renderer keeps reading `exit`, `elapsedMs`, `toolCalls`.
 */
export interface SubagentCardFields {
	/** Human-readable role, e.g. `Explore`. */
	displayName: string;
	/** The role id, e.g. `explore`. */
	subagentType: RoleId;
	/** What was asked of the child, clipped. */
	description: string;
	toolUses: number;
	durationMs: number;
	/** Pre-formatted token total; "" when the run reported none. */
	tokens: string;
	agentId?: string;
	modelName?: string;
	/** First line of the report, clipped — never the report itself, which `content` already carries. */
	preview?: string;
}

/** The card fields for one state of a run. */
export function cardFields(
	host: { role: RoleId; task: string; model?: string },
	run: { toolCalls: number; elapsedMs: number; agentId?: string; usage?: Usage; report?: string },
): SubagentCardFields {
	return {
		displayName: host.role ? `${host.role[0].toUpperCase()}${host.role.slice(1)}` : "Subagent",
		subagentType: host.role,
		description: clip(host.task, 160),
		toolUses: run.toolCalls,
		durationMs: run.elapsedMs,
		tokens: formatTokens(run.usage),
		agentId: run.agentId,
		modelName: host.model,
		...(run.report ? { preview: previewOf(run.report) } : {}),
	};
}

export interface SubagentDetails extends SubagentCardFields {
	/** Frontend status vocabulary (see `uiStatus`); our own exit is in `exit`. */
	status: SubagentUiStatus;
	role: RoleId;
	/**
	 * The model did not name a role, so `subagent.defaultRole` decided. Carried so the card can say the
	 * child ran on a role the human configured rather than one the model asked for.
	 */
	roleDefaulted?: boolean;
	/** The settled exit; absent while the child is still running. Drives our renderer's wording. */
	exit?: ChildResult["exit"];
	turns: number;
	toolCalls: number;
	childSessionFile?: string;
	childSessionId?: string;
	truncated: boolean;
	elapsedMs: number;
	removedTranscripts?: number;
	nestedCalls?: number;
	shimTools?: string[];
	/** Which model the child actually ran on, e.g. `local/qwen3.8-flash-next (inherited)`. */
	model?: string;
	error?: string;
	/** The task, so a running card can say what the child is doing. */
	task?: string;
	/** What the child was last seen doing (`bash`, `read`, …) — only while running. */
	activity?: string;
	/**
	 * The child's report on its own, without the model-facing header. The tool card renders this
	 * (`render.ts`); the model gets the same text inside `content`.
	 */
	report?: string;
}

export function formatProgress(progress: RunProgress, toolCount: number): string {
	return (
		`subagent running · turn ${progress.turns} · ${progress.toolCalls} calls · ` +
		`${progress.lastTool ?? "thinking"} · ${Math.round(progress.elapsedMs / 1000)}s · ${toolCount} tools`
	);
}

/** The parts of a run that do not change between progress updates. */
export interface ProgressContext {
	role: RoleId;
	roleDefaulted?: boolean;
	task: string;
	model?: string;
	shimTools: string[];
	nestedCalls: number;
}

/**
 * A complete `details` for a progress update. An update that carries an empty object is not a
 * status the UI can draw — that is what left the tool card on its "no activity" placeholder.
 */
export function progressDetails(progress: RunProgress, host: ProgressContext): SubagentDetails {
	return {
		status: "running",
		role: host.role,
		roleDefaulted: host.roleDefaulted,
		turns: progress.turns,
		toolCalls: progress.toolCalls,
		truncated: false,
		elapsedMs: progress.elapsedMs,
		activity: progress.lastTool ?? "thinking",
		task: host.task,
		model: host.model,
		shimTools: host.shimTools,
		nestedCalls: host.nestedCalls,
		...cardFields(host, { toolCalls: progress.toolCalls, elapsedMs: progress.elapsedMs }),
	};
}

/**
 * Status header first, then the answer head (A12: `truncateHead` keeps the *first* bytes, so the
 * child's leading conclusion survives), then the pointer to the full transcript.
 */
export function composeResult(
	result: ChildResult,
	role: RoleId,
	maxResultBytes: number,
	elapsedMs: number,
	extra: Partial<SubagentDetails> = {},
): AgentToolResult<SubagentDetails> {
	// `truncateHead` never returns a partial line, so a one-line answer needs a plain slice.
	const truncated = truncateHead(result.text, { maxBytes: maxResultBytes });
	const body = (truncated.firstLineExceedsLimit ? result.text.slice(0, maxResultBytes) : truncated.content).trim();
	const sessionFile = result.childSessionFile ?? extra.childSessionFile;
	const childSessionId = result.childSessionId ?? extra.childSessionId;
	const status = result.exit === "done" ? "DONE" : `INCOMPLETE (${result.exit})`;
	const header =
		`[subagent ${role} · ${status} · ${result.turns} turns · ${result.toolCalls} tool calls · ${(elapsedMs / 1000).toFixed(1)}s]` +
		(extra.model ? `\nmodel: ${extra.model}` : "") +
		(sessionFile ? `\ntranscript: ${sessionFile}` : "") +
		(result.error ? `\nerror: ${result.error}` : "");
	const answer = body || "(the subagent returned no text)";
	const footer = truncated.truncated
		? `\n\n[… output truncated: ${Math.min(maxResultBytes, truncated.totalBytes)}/${truncated.totalBytes} bytes shown; the full result is in the transcript above.]`
		: "";
	return {
		content: [{ type: "text", text: `${header}\n\n${answer}${footer}` }],
		details: {
			status: uiStatus(result.exit),
			role,
			exit: result.exit,
			turns: result.turns,
			toolCalls: result.toolCalls,
			childSessionFile: sessionFile,
			childSessionId,
			truncated: truncated.truncated,
			elapsedMs,
			task: extra.task,
			report: body,
			...cardFields(
				{ role, task: extra.task ?? "", model: extra.model },
				{ toolCalls: result.toolCalls, elapsedMs, agentId: childSessionId, usage: result.usage, report: body },
			),
			...extra,
		},
		usage: result.usage,
		isError: result.exit === "error",
	};
}
