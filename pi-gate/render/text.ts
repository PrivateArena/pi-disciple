/**
 * Text rendering for the human readout: code spans, clipping, one-line snippets
 * (plan step 3, split out of `match.ts`).
 */

/**
 * Markdown inline code. Front-ends render dialog text as markdown, so `*`, `_` and `[]` in a shell
 * command would be eaten as formatting; a code span is rendered verbatim. The fence grows past any
 * run of backticks in the value, so a command cannot close its own span early.
 */
export function codeSpan(value: string): string {
	const text = value.trim();
	if (!text) return "";
	let fence = "`";
	while (text.includes(fence)) fence = `${fence}\``;
	const pad = /^[`\s]|[`\s]$/.test(text) ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

/** Visibly truncated single-line text with a hard character budget (dialog labels). */
export function shorten(value: string, maxChars: number): string {
	if (maxChars <= 1 || value.length <= maxChars) return value;
	return `${value.slice(0, maxChars - 1)}…`;
}

/**
 * Redacted, control-character-free, single-line text.
 *
 * Uncapped by default: the human would rather scroll through a whole command than approve a snippet of
 * one (`[…truncated]` hid exactly the argument a decision turned on). Pass `maxChars` only where a
 * fixed budget really matters — the review log line.
 */
export function displaySnippet(value: string, maxChars = Number.POSITIVE_INFINITY): string {
	const clean = value
		.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (clean.length <= maxChars) return clean;
	return `${clean.slice(0, maxChars)} […truncated]`;
}
