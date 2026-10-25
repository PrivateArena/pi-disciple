/**
 * The one dialog the whole design hangs on (plan step 7).
 *
 * Standard `ctx.ui.select` + `ctx.ui.input` only, so every pi front-end (TUI, RPC/Pendant) renders
 * it. Text is shown in full — the human chooses on what they can see, and the option list scrolls.
 * Anything other than an explicit allow choice — Esc, dismiss, timeout, no UI — resolves to
 * `abort`: a timeout never grants permission (FM-11).
 */

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Decision } from "./policy.ts";
import { ALLOW_ALL_WINDOW_MS } from "./policy.ts";
import { codeSpan, displaySnippet, shorten } from "./match.ts";

export type Choice = "once" | "session" | "project" | "global" | "abort" | "abort_reason" | "all_session" | "all_timed";

/** Index-aligned with {@link optionLabels}. */
export const CHOICES: readonly Choice[] = ["once", "session", "project", "global", "abort", "abort_reason", "all_session", "all_timed"];

const ALLOW_ALL_WINDOW_MINUTES = Math.round(ALLOW_ALL_WINDOW_MS / 60_000);

/**
 * Option labels stay single-line (displaySnippet) and long enough to identify the rule; the whole rule
 * is repeated verbatim in the title (`rule:` line), so nothing is only ever available in cut form.
 */
const LABEL_PATTERN_CHARS = 200;

/** The rule a choice would write, as the human reads it: single line, code-wrapped, full text in {@link ruleLine}. */
function grantSummary(offer: Decision["grant"]): string {
	return codeSpan(shorten(displaySnippet(offer?.label ?? "*"), LABEL_PATTERN_CHARS));
}

/** Every pattern of the offer, verbatim and uncapped — what the grant scopes really write. */
function ruleLine(decision: Decision): string {
	const patterns = decision.grant?.patterns;
	if (!patterns?.length) return "";
	return `\nrule: ${patterns.map((pattern) => codeSpan(displaySnippet(pattern))).join("  ")}`;
}

export function optionLabels(decision: Decision, cwd: string): string[] {
	const grant = grantSummary(decision.grant);
	return [
		"Allow once",
		`Allow ${grant} for this session`,
		`Allow ${grant} for this project (${cwd})`,
		`Allow ${grant} for all projects`,
		"Abort",
		"Abort with reason…",
		"Allow everything for this session",
		`Allow everything for ${ALLOW_ALL_WINDOW_MINUTES} minutes`,
	];
}

export function dialogTitle(decision: Decision, sub?: { role: string; task: string }, note?: string): string {
	const floors = decision.floors.length ? ` [floor: ${decision.floors.join(", ")}]` : "";
	const origin = sub ? `\nfrom subagent(${sub.role}): ${displaySnippet(sub.task)}` : "";
	const banner = note ? `\n${note}` : "";
	return `pi-gate: ${decision.facts.toolName} — ${codeSpan(displaySnippet(decision.facts.preview))}${floors}${origin}${banner}${ruleLine(decision)}\n${surfaceSummary(decision)}`;
}

function surfaceSummary(decision: Decision): string {
	return decision.checks
		.filter((check) => check.surface !== decision.facts.toolName)
		.map((check) => `${check.surface}: ${codeSpan(displaySnippet(check.value))} = ${check.action}${check.floor ? ` (${check.floor})` : ""}`)
		.join("\n");
}

export interface AskResult {
	choice: Choice;
	/** Verbatim human instruction when `choice === "abort_reason"`. */
	reason?: string;
}

/** Injectable so tests never need a TTY. */
export interface AskIO {
	select: ExtensionUIContext["select"];
	input: ExtensionUIContext["input"];
}

export async function ask(
	ctx: Pick<ExtensionContext, "ui">,
	decision: Decision,
	options: { cwd: string; signal?: AbortSignal; timeoutMs?: number; sub?: { role: string; task: string }; io?: AskIO; note?: string },
): Promise<AskResult> {
	const ui = options.io ?? { select: ctx.ui.select.bind(ctx.ui), input: ctx.ui.input.bind(ctx.ui) };
	const labels = optionLabels(decision, options.cwd);
	const picked = await ui.select(dialogTitle(decision, options.sub, options.note), [...labels], {
		signal: options.signal,
		timeout: options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined,
	});
	const index = picked === undefined ? -1 : labels.indexOf(picked);
	if (index < 0) return { choice: "abort" };
	const choice = CHOICES[index]!;
	if (choice !== "abort_reason") return { choice };

	const typed = await ui.input("What should the agent do instead?", undefined, { signal: options.signal });
	const reason = typed?.trim();
	if (!reason) return { choice: "abort" };
	return { choice: "abort_reason", reason };
}
