/**
 * The one dialog the whole design hangs on (plan step 7).
 *
 * Standard `ctx.ui.select` + `ctx.ui.input` only, so every pi front-end (TUI, RPC/Pendant) renders
 * it. Anything other than an explicit allow choice — Esc, dismiss, timeout, no UI — resolves to
 * `abort`: a timeout never grants permission (FM-11).
 */

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Decision, GrantOffer } from "./policy.ts";
import { codeSpan, displaySnippet, shorten } from "./match.ts";

export type Choice = "once" | "session" | "project" | "global" | "abort" | "abort_reason";

/** Index-aligned with {@link optionLabels}. */
export const CHOICES: readonly Choice[] = ["once", "session", "project", "global", "abort", "abort_reason"];

/** Long commands live in the dialog title; a label only has to identify the rule. */
const LABEL_PATTERN_CHARS = 56;

/** The rule a choice would write, as the human reads it: single line, code-wrapped, length-capped. */
function grantSummary(offer: GrantOffer | undefined): string {
	const text = displaySnippet(offer?.label ?? "*", LABEL_PATTERN_CHARS);
	return codeSpan(shorten(text || "*", LABEL_PATTERN_CHARS));
}

export function optionLabels(decision: Decision, cwd: string): string[] {
	const session = grantSummary(decision.grant);
	const persisted = grantSummary(decision.persistedGrant ?? decision.grant);
	return [
		"Allow once",
		`Allow ${session} for this session`,
		`Allow ${persisted} exactly for this project (${cwd})`,
		`Allow ${persisted} exactly for all projects`,
		"Abort",
		"Abort with reason…",
	];
}

export function dialogTitle(decision: Decision, sub?: { role: string; task: string }): string {
	const floors = decision.floors.length ? ` [floor: ${decision.floors.join(", ")}]` : "";
	const origin = sub ? `\nfrom subagent(${sub.role}): ${displaySnippet(sub.task, 120)}` : "";
	return `pi-gate: ${decision.facts.toolName} — ${codeSpan(displaySnippet(decision.facts.preview, 240))}${floors}${origin}\n${surfaceSummary(decision)}`;
}

function surfaceSummary(decision: Decision): string {
	return decision.checks
		.filter((check) => check.surface !== decision.facts.toolName)
		.slice(0, 4)
		.map((check) => `${check.surface}: ${codeSpan(shorten(displaySnippet(check.value, 120), 120))} = ${check.action}${check.floor ? ` (${check.floor})` : ""}`)
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
	options: { cwd: string; signal?: AbortSignal; timeoutMs?: number; sub?: { role: string; task: string }; io?: AskIO },
): Promise<AskResult> {
	const ui = options.io ?? { select: ctx.ui.select.bind(ctx.ui), input: ctx.ui.input.bind(ctx.ui) };
	const labels = optionLabels(decision, options.cwd);
	const picked = await ui.select(dialogTitle(decision, options.sub), [...labels], {
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
