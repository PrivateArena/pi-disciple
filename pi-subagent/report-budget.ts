/**
 * The byte budget a report gets before it goes to the model: how to cut text at a byte cap without cutting a
 * character, and which head of the report is the one worth sending.
 *
 * Split out of `run.ts`, which imports both functions and does *not* re-export them — neither was ever part
 * of its public surface. Pure functions of `(string, number)`: no files, no config, no `details`.
 */

import { truncateHead } from "@earendil-works/pi-coding-agent";

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
export function reportHead(report: string, maxBytes: number): { head: string; truncated: boolean; totalBytes: number } {
	const totalBytes = Buffer.byteLength(report, "utf8");
	const cut = truncateHead(report, { maxBytes, maxLines: Number.MAX_SAFE_INTEGER });
	if (!cut.truncated) return { head: report, truncated: false, totalBytes };
	const wholeLines = cut.firstLineExceedsLimit ? "" : cut.content;
	const head = Buffer.byteLength(wholeLines) * 2 >= maxBytes ? wholeLines : sliceBytes(report, maxBytes);
	return { head, truncated: true, totalBytes };
}
