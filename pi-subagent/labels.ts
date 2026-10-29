/**
 * labels.ts — the one-line strings a subagent card is titled with.
 *
 * Shared by `render.ts` (pi's TUI and the HTML export) and `run.ts` (the `details` a non-TUI frontend
 * reads), so the two surfaces cannot drift into naming the same role two different ways. Pure string
 * functions, no pi-tui, no config: the card's title is decided from what the call already carries.
 */

import type { RoleId } from "./roles.ts";

/** How much of the task fits in a card title before it becomes a paragraph. */
export const CARD_SUMMARY_CHARS = 72;

/** Clip for a card row: a card gets a summary, never a whole field. */
export function clip(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/**
 * The role's name as a title, not as an identifier: `explore` → `Explore`, `general-purpose` →
 * `General Purpose`, `senior_reviewer` → `Senior Reviewer`.
 *
 * The role table's `description` is deliberately NOT used here: it describes the role *to the model*
 * ("Read-only survey of a code base or system"), while a card title has to say what *this call* asked
 * for. A `display_name` field would be the place for a hand-authored title, if roles ever want one.
 */
export function roleDisplayName(role: RoleId | string | undefined): string {
	if (!role) return "Subagent";
	return role
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

/**
 * The task as one title-safe line: whitespace collapsed, leading markdown stripped, clipped to the
 * card's budget with an ellipsis. Frontends put this in a single-line header, where a newline from the
 * task would break the row and a 500-character task would push everything else off screen.
 */
export function taskSummary(task: string | undefined, maxChars = CARD_SUMMARY_CHARS): string {
	if (!task) return "";
	const oneLine = task
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.replace(/^#+\s*/, "")
		.trim();
	return clip(oneLine, maxChars);
}
