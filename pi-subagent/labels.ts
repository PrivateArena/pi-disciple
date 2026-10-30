/**
 * labels.ts — the strings a subagent card is titled with.
 *
 * Shared by `render.ts` (pi's TUI and the HTML export) and `run.ts` (the `details` a non-TUI frontend
 * reads), so the two surfaces cannot drift into naming the same role two different ways. Pure string
 * functions, no pi-tui, no config: the card's title is decided from what the call already carries.
 *
 * Nothing here shortens the task. A delegation prompt is the human's instruction to a child they cannot
 * see, and a card that hides it behind an ellipsis makes the call unauditable — the one thing a gate and
 * a transcript exist to prevent. `taskLabel` only flattens (a card row is one line); `taskBody` is
 * verbatim. `clip` survives for the report preview, which is a summary of something already on screen.
 */

import type { RoleId } from "./roles.ts";

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
 * The whole task as one line: every whitespace run (newline, tab, indent) becomes a single space, so a
 * multi-paragraph delegation still fits a frontend's single-line header slot — and, per Pendant's own
 * rule for a header label that runs out of room, the *whole* label is what its hover tooltip shows.
 * Length is not a reason to cut: a clipped prompt is a prompt the human cannot audit.
 */
export function taskLabel(task: string | undefined): string {
	if (!task) return "";
	return task.replace(/\s+/g, " ").replace(/^#+\s*/, "").trim();
}

/**
 * The whole task as written: only outer whitespace removed, line breaks and indentation kept. This is what
 * pi's terminal prints under the role, and what `ctrl+o`-style collapse is for — the block never clips.
 */
export function taskBody(task: string | undefined): string {
	return task?.trim() ?? "";
}
