/**
 * render.ts — how a subagent call and its report are drawn, by pi's TUI and by any frontend that
 * reuses pi's tool renderers (Pendant, the HTML export).
 *
 * Without these hooks the tool card only ever shows pi's generic fallback, which key-frames the
 * *result text*: while the child runs there is no result text at all, so a frontend shows its
 * "no activity" placeholder and, at the end, a blob that repeats the status header. So the tool
 * renders itself: a title line naming the call, and a result block that leads with one readable
 * sentence about the run and then shows the child's report.
 *
 * Every function here is pure (strings in, strings out) except the two `render*` wrappers, which
 * only wrap a string in a `Text` component — so the formatting is unit-testable without a terminal.
 */

import { keyHint, type AgentToolResult, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { Exit } from "./child.ts";
import { roleDisplayName, taskBody } from "./labels.ts";
import { configuredDefaultRole, type RoleId } from "./roles.ts";
import type { SubagentDetails } from "./run.ts";

/** Glyph for the call title. pi's own tools have one per tool; this is ours. */
export const SUBAGENT_GLYPH = "🤖";

/**
 * Report lines shown while the card is collapsed. Beyond the cap: a "more lines" hint. Expanded, the card
 * prints the report whole — expanding is the human asking for the rest, and truncating it there would send
 * them to a file for text this process already holds.
 */
export const COLLAPSED_REPORT_LINES = 10;

/** `21.0s` below a minute, then `13m 33s`, then `2h 3m`. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const totalMinutes = Math.floor(seconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${Math.round(seconds % 60)}s`;
	return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

/** `4.2k token`, or "" when the run reported no usage — the count is never guessed at. */
export function formatTokenCount(usage: Usage | undefined): string {
	const total = usage?.totalTokens ?? 0;
	if (total <= 0) return "";
	return total < 1000 ? `${total} token` : `${(total / 1000).toFixed(1)}k token`;
}

/**
 * `(4 turns, 7 tool uses, 4.2k token)` — the parenthetical of the status sentence, "" when empty.
 *
 * The token total comes from `result.usage` when the caller passes one, else from `details.tokens`:
 * pi's `ToolExecutionComponent` hands a renderer only `{ content, details }`, so `usage` is there for
 * the model and absent for the card.
 */
export function formatRunStats(
	details: { turns: number; toolCalls: number; tokens?: string },
	usage: Usage | undefined,
): string {
	const parts: string[] = [];
	if (details.turns > 0) parts.push(`${details.turns} turn${details.turns === 1 ? "" : "s"}`);
	if (details.toolCalls > 0) parts.push(`${details.toolCalls} tool use${details.toolCalls === 1 ? "" : "s"}`);
	const tokens = formatTokenCount(usage) || details.tokens || "";
	if (tokens) parts.push(tokens);
	return parts.length ? ` (${parts.join(", ")})` : "";
}

/**
 * The one sentence that says what happened, in the run's own colour:
 * `Agent completed in 21.0s (4 turns, 7 tool uses, 4.2k token).`
 */
export function formatStatusLine(details: SubagentDetails, usage: Usage | undefined, theme: Theme): string {
	const stats = formatRunStats(details, usage);
	const color = (exit: Exit) => (exit === "done" ? "success" : exit === "error" ? "error" : "warning");
	if (!details.exit) {
		const elapsed = details.elapsedMs > 0 ? ` for ${formatDuration(details.elapsedMs)}` : "";
		return theme.fg("accent", `Agent running${elapsed}${stats}`);
	}
	if (details.exit === "done") return theme.fg(color("done"), `Agent completed in ${formatDuration(details.elapsedMs)}${stats}.`);
	if (details.exit === "error") {
		return theme.fg(color("error"), `Agent failed after ${formatDuration(details.elapsedMs)}${stats}: ${details.error ?? "the child returned an error"}`);
	}
	return theme.fg(color(details.exit), `Agent stopped after ${formatDuration(details.elapsedMs)} (${details.exit})${stats}.`);
}

/** The identity line: what ran, on which model, and where to read the whole exchange. */
export function formatIdentityLine(details: SubagentDetails, theme: Theme): string {
	const parts = [`role: ${details.role}${details.roleDefaulted ? " (default)" : ""}`];
	if (details.model) parts.push(`model: ${details.model}`);
	if (details.childSessionId) parts.push(`Agent ID: ${details.childSessionId}`);
	if (details.nestedCalls) parts.push(`${details.nestedCalls} nested calls`);
	const head = theme.fg("muted", parts.join(" · "));
	return details.childSessionFile ? `${head}\n${theme.fg("muted", `transcript: ${details.childSessionFile}`)}` : head;
}

/**
 * The hint that says how to read the rest. pi's own expand keybinding when a theme is loaded; in a
 * test, or a frontend that renders the block itself, a plain phrase — the key is user-configurable,
 * so it is never hardcoded.
 */
function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return "expand to read the rest";
	}
}

/**
 * The report, head-truncated to the line budget of the card's state. The head — not the tail —
 * because the child is told to lead with its conclusion (see `composeResult`).
 */
export function formatReportBody(details: SubagentDetails, report: string, expanded: boolean, theme: Theme): string {
	const text = report.trim();
	if (!text) return theme.fg("muted", "(the subagent returned no text)");
	const lines = text.split("\n").map((line) => theme.fg("toolOutput", line));
	if (expanded || lines.length <= COLLAPSED_REPORT_LINES) return lines.join("\n");
	const remaining = lines.length - COLLAPSED_REPORT_LINES;
	return `${lines.slice(0, COLLAPSED_REPORT_LINES).join("\n")}\n${theme.fg("muted", `... (${remaining} more lines, ${expandHint()})`)}`;
}

/** The whole result block: status sentence, identity, then the report. */
export function formatResultBlock(
	details: SubagentDetails,
	result: AgentToolResult<unknown>,
	expanded: boolean,
	theme: Theme,
): string {
	const report = details.report ?? textOf(result);
	const status = formatStatusLine(details, result.usage, theme);
	if (details.exit) return `${status}\n${formatIdentityLine(details, theme)}\n\n${formatReportBody(details, report, expanded, theme)}`;
	// Running: the activity line is the payload — a frontend with no update at all has nothing to say.
	// The task is not repeated here: the call block above the card already prints it whole.
	const activity = details.activity ? `\n${theme.fg("dim", `last call: ${details.activity}`)}` : "";
	return `${status}${activity}`;
}

/** What the call title needs beyond the args, because a title is drawn before the call is settled. */
export interface CallTitleContext {
	/** False while the model still streams the arguments: a role that is not there yet may still arrive. */
	argsComplete?: boolean;
	/** Role an unnamed call gets. Left out, the configured `subagent.defaultRole` is used. */
	defaultRole?: RoleId;
}

/**
 * The tool card's call block: the role on the title line, then the complete task under it.
 *
 * The role *leads* the title, because that is the part a card must never lose: a title is drawn in the
 * width left after the transcript's indent, and a tail is what gets truncated. The prompt is not a
 * summary and not a tooltip — it is the human's instruction to a child they cannot watch, so it is
 * printed whole, from the first render, and stays the same text for the life of the call. Wrapping and
 * scrolling a tall block is pi's job (`ctrl+o`), not ours.
 *
 * pi renders this repeatedly while the call streams in, so an absent role means two different things and
 * says two different things here: *not yet* (arguments still arriving, so name no role the model may still
 * choose — "Launch subagent" with the prompt under it) or *not at all* (arguments complete, so name the
 * default that will actually run, marked as the human's choice rather than the model's).
 */
export function formatCallBlock(args: { role?: string; task?: string }, theme: Theme, context: CallTitleContext = {}): string {
	const role = args.role ?? (context.argsComplete === false ? undefined : (context.defaultRole ?? configuredDefaultRole()));
	const name = role ? `${roleDisplayName(role)}${args.role ? "" : " (default)"}` : "Launch subagent";
	const title = theme.fg("toolTitle", theme.bold(name));
	const task = taskBody(args.task);
	return task ? `${title}\n${theme.fg("muted", task)}` : title;
}

function textOf(result: AgentToolResult<unknown>): string {
	const block = result.content.find((entry) => entry.type === "text");
	return block && block.type === "text" ? block.text : "";
}

export function renderSubagentCall(args: { role?: string; task?: string }, theme: Theme, context: CallTitleContext = {}): Text {
	return new Text(formatCallBlock(args, theme, context), 0, 0);
}

export function renderSubagentResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	const details = result.details as SubagentDetails | undefined;
	if (!details) return new Text(textOf(result), 0, 0);
	return new Text(formatResultBlock(details, result, options.expanded, theme), 0, 0);
}
