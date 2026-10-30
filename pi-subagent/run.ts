/**
 * Run guard and result composition (plan steps 15 and 16), kept out of `index.ts` so both are unit
 * testable without a live provider.
 */

import { formatSize, truncateHead, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import type { Usage } from "@earendil-works/pi-ai";
import { reportFileFor, type CeilingReport, type ChildResult, type Exit, type RunProgress } from "./child.ts";
import { clip, formatCeiling, roleDisplayName, taskLabel } from "./labels.ts";
import type { RoleId } from "./roles.ts";

export { clip } from "./labels.ts";

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
	/** The role id again, under the key the frontend vocabulary uses for a step's agent name. */
	agent: RoleId;
	/** What was asked of the child, whole, flattened onto one line (a header slot is one line, a hover is not). */
	description: string;
	toolUses: number;
	durationMs: number;
	/** Pre-formatted token total; "" when the run reported none. */
	tokens: string;
	agentId?: string;
	modelName?: string;
	/** First line of the report, clipped — never the report itself, which `content` already carries. */
	preview?: string;
	/**
	 * Header labels for the Pendant frontend, which draws its own subagent card and never calls our
	 * renderers. It reads this object when the call finishes; pi's terminal ignores it. An empty string
	 * counts as missing there, so a label that is not available is left out rather than sent blank. The
	 * subtitle carries the entire task: Pendant puts a label that does not fit the header behind a hover
	 * tooltip, and that tooltip is where a human reads what the child was actually told to do.
	 */
	pendant: { title: string; subtitle?: string };
}

/** The card fields for one state of a run. */
export function cardFields(
	host: { role: RoleId; task: string; model?: string },
	run: { toolCalls: number; elapsedMs: number; agentId?: string; usage?: Usage; report?: string },
): SubagentCardFields {
	return {
		displayName: roleDisplayName(host.role),
		subagentType: host.role,
		agent: host.role,
		description: taskLabel(host.task),
		toolUses: run.toolCalls,
		durationMs: run.elapsedMs,
		tokens: formatTokens(run.usage),
		agentId: run.agentId,
		modelName: host.model,
		...(run.report ? { preview: previewOf(run.report) } : {}),
		...pendantHeader(host),
	};
}

/** The Pendant header: the role names the card, the whole task subtitles it. */
function pendantHeader(host: { role: RoleId; task: string }): { pendant: SubagentCardFields["pendant"] } {
	const subtitle = taskLabel(host.task);
	return { pendant: { title: roleDisplayName(host.role), ...(subtitle ? { subtitle } : {}) } };
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
	 * The one budget-extension offer this run got, if a budget was ever spent: what the human was asked, and
	 * what they answered. Absent means no ceiling was reached, which is the ordinary run.
	 */
	ceiling?: CeilingReport;
	/**
	 * The child's report on its own, without the model-facing header, and always the *whole* thing: the
	 * `maxResultBytes` cap bounds what the *model* is sent, never what the human is shown (see
	 * `composeResult`, which writes the omitted part to `reportFile`).
	 */
	report?: string;
	/** Where the complete report was written, when the model-facing copy had to be cut. */
	reportFile?: string;
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
	/** A granted extension, so a card that stays open for minutes says the run has more rope than it started with. */
	ceiling?: CeilingReport;
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
		ceiling: host.ceiling,
		task: host.task,
		model: host.model,
		shimTools: host.shimTools,
		nestedCalls: host.nestedCalls,
		...cardFields(host, { toolCalls: progress.toolCalls, elapsedMs: progress.elapsedMs }),
	};
}

/**
 * Where the complete report goes when it does not fit the model-facing budget: `reportFileFor` beside the
 * child's transcript. A file holding *only* the report is the cheap recovery path — reading the JSONL
 * transcript instead would cost the parent the whole exchange it delegated to avoid.
 */
function writeReport(transcriptFile: string | undefined, report: string): string | undefined {
	if (!transcriptFile) return undefined;
	const file = reportFileFor(transcriptFile);
	try {
		writeFileSync(file, report, "utf8");
		return file;
	} catch {
		return undefined;
	}
}

/** Cut a string to at most `maxBytes` bytes, never mid-character (continuation bytes are not starts). */
function sliceBytes(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let end = Math.max(0, maxBytes);
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return buf.subarray(0, end).toString("utf8");
}

/**
 * The model-facing head of a report: the whole thing up to `maxBytes`, else the largest whole-line prefix
 * that fits — except when a single enormous line (a pasted blob, a one-line table) would leave the model
 * with a heading and half the budget unused, where cutting mid-line is the better trade.
 *
 * pi's `truncateHead` also enforces a 2000-line budget by default; a report is prose, not tool output, so
 * only the byte cap is meaningful here.
 */
function reportHead(report: string, maxBytes: number): { head: string; truncated: boolean; totalBytes: number } {
	const totalBytes = Buffer.byteLength(report, "utf8");
	const cut = truncateHead(report, { maxBytes, maxLines: Number.MAX_SAFE_INTEGER });
	if (!cut.truncated) return { head: report, truncated: false, totalBytes };
	const wholeLines = cut.firstLineExceedsLimit ? "" : cut.content;
	const head = Buffer.byteLength(wholeLines) * 2 >= maxBytes ? wholeLines : sliceBytes(report, maxBytes);
	return { head, truncated: true, totalBytes };
}

/**
 * The model-facing result: a status header, then the report.
 *
 * The report is the artifact the delegation was paid for, so it goes back whole up to
 * `subagent.maxResultBytes` — the old habit of cutting it and pointing at the transcript was
 * counter-productive: recovering the tail from a session JSONL costs the parent far more than the bytes it
 * was spared. Beyond the cap, the head (the child's conclusion, which is what leads a report) goes to the
 * model and the complete report is written beside the transcript, which the model is told to read. The
 * card always gets the whole report through `details.report`.
 */
export function composeResult(
	result: ChildResult,
	role: RoleId,
	maxResultBytes: number,
	elapsedMs: number,
	extra: Partial<SubagentDetails> = {},
): AgentToolResult<SubagentDetails> {
	const report = result.text ?? "";
	const cut = reportHead(report, maxResultBytes);
	const answer = cut.head.trimEnd() || "(the subagent returned no text)";
	const sessionFile = result.childSessionFile ?? extra.childSessionFile;
	const childSessionId = result.childSessionId ?? extra.childSessionId;
	const spillFile = cut.truncated ? writeReport(sessionFile, report) : undefined;
	const status = result.exit === "done" ? "DONE" : `INCOMPLETE (${result.exit})`;
	const ceilingNote = formatCeiling(result.ceiling);
	const header =
		`[subagent ${role} · ${status} · ${result.turns} turns · ${result.toolCalls} tool calls · ${(elapsedMs / 1000).toFixed(1)}s]` +
		(extra.model ? `\nmodel: ${extra.model}` : "") +
		(ceilingNote ? `\n${ceilingNote}` : "") +
		(sessionFile ? `\ntranscript: ${sessionFile}` : "") +
		(result.error ? `\nerror: ${result.error}` : "");
	const cutNote = `[… the report is ${formatSize(cut.totalBytes)} and only its first ${formatSize(Buffer.byteLength(answer))} is shown here, per subagent.maxResultBytes`;
	const footer = !cut.truncated
		? ""
		: spillFile
			? `\n\n${cutNote}. The COMPLETE report: ${spillFile} — read that file; it holds nothing but the report. Do not re-read the transcript to recover the rest.]`
			: `\n\n${cutNote}; the rest is in the transcript above.]`;
	return {
		content: [{ type: "text", text: `${header}\n\n${answer}${footer}` }],
		details: {
			status: uiStatus(result.exit),
			role,
			exit: result.exit,
			ceiling: result.ceiling,
			turns: result.turns,
			toolCalls: result.toolCalls,
			childSessionFile: sessionFile,
			childSessionId,
			truncated: cut.truncated,
			elapsedMs,
			task: extra.task,
			report,
			...(spillFile ? { reportFile: spillFile } : {}),
			...cardFields(
				{ role, task: extra.task ?? "", model: extra.model },
				{ toolCalls: result.toolCalls, elapsedMs, agentId: childSessionId, usage: result.usage, report },
			),
			...extra,
		},
		usage: result.usage,
		isError: result.exit === "error",
	};
}
