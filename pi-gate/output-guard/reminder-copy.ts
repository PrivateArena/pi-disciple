import { codeSpan } from "../render/text.ts";
import { type GuardAction } from "../config-contract/guard-section.ts";

/**
 * The words the guard says: the reminder the model reads and the one-line notice the human gets.
 */

import { type GuardHit } from "./guard-rule.ts";

const CUT_OFF_ADVICE =
	"The response was cut off, so the arguments never arrived. Make the call again through the tool interface with complete arguments, or split the step into smaller ones.";

const LEAK_ADVICE =
	"Tool calls go through the harness's tool interface, not through the text of a message. Make the call properly now if you meant to make it; otherwise answer without the call markup.";

/** The text the model reads: short markdown, one screen, and it names the next action. */
export function reminderText(hit: GuardHit, truncated: boolean): string {
	const advice = hit.advice ?? (truncated || hit.rules.includes("json-call-truncated") ? CUT_OFF_ADVICE : LEAK_ADVICE);
	return [`Malformed tool call: ${hit.label}, so nothing ran and the run would have stopped here.`, `What you wrote: ${codeSpan(hit.evidence)}`, advice].join(" ");
}

/** The one-line version for the human. */
export function guardNotice(hit: GuardHit, action: GuardAction): string {
	return `[gate] ${action === "remind" ? "reminded the agent:" : "noticed"} ${hit.label} (${hit.rules.join(", ")})`;
}
