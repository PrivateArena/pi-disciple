/**
 * Result composition (plan step 16), kept out of `index.ts` so it is unit testable without a live provider.
 *
 * Three concerns have since split out, one module per question: the one-child rule and its
 * process-global slot live in `run-guard.ts`; what a card is drawn from — the `@gotgenes/pi-subagents`
 * `details` vocabulary — lives in the `card/` package; the byte budget on a report lives in
 * `report-budget.ts`. This module keeps its name and its whole public surface as the facade over them,
 * and keeps the one thing that was never separable: `composeResult`, the seam that joins a child's report,
 * the byte cap and the card fields into a tool result. Production importers now go to the real module; the
 * tests and `verification/` reach the moved symbols through here.
 */

import { formatSize, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ChildResult } from "./child.ts";
import { formatCeiling } from "./labels.ts";
import type { RoleId } from "./roles.ts";
import { uiStatus } from "./card/ui-status.ts";
import { cardFields, type SubagentDetails } from "./card/details.ts";
import { reportHead } from "./report-budget.ts";
import { writeReport } from "./transcript/report-spill.ts";

export { clip } from "./labels.ts";

/**
 * The facade over the split-out modules: everything this module exported before is still reachable from
 * here, by the same name. The run guard (`run-guard.ts`) — the only process-global state in the extension,
 * and the reason a `/reload` cannot start a second child.
 */
export { RUN_GUARD_KEY, claimGuard, currentGuard, releaseGuard } from "./run-guard.ts";
export type { RunGuard } from "./run-guard.ts";

/**
 * And the frontend `details` contract (`card/`): the status vocabulary the card branches on, the fields the
 * card is drawn from, and the complete `details` a progress update carries.
 */
export type { SubagentUiStatus } from "./card/ui-status.ts";
export { uiStatus } from "./card/ui-status.ts";
export { formatTokens, previewOf, cardFields } from "./card/details.ts";
export type { SubagentCardFields, SubagentDetails } from "./card/details.ts";
export { formatProgress, progressDetails } from "./card/progress.ts";
export type { ProgressContext } from "./card/progress.ts";

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
		(extra.thinking ? `\nthinking: ${extra.thinking}` : "") +
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
