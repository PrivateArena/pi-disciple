/**
 * The one dialog the whole design hangs on (plan step 7).
 *
 * Standard `ctx.ui.select` + `ctx.ui.input` only, so every pi front-end (TUI, RPC/Pendant) renders
 * it. Anything other than an explicit allow choice — Esc, dismiss, timeout, no UI — resolves to
 * `abort`: a timeout never grants permission (FM-11).
 */

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Decision } from "./policy.ts";
import { displaySnippet } from "./match.ts";

export type Choice = "once" | "session" | "project" | "global" | "abort" | "abort_reason";

/** Index-aligned with {@link optionLabels}. */
export const CHOICES: readonly Choice[] = ["once", "session", "project", "global", "abort", "abort_reason"];

export function optionLabels(decision: Decision, cwd: string): string[] {
	const sessionPattern = decision.grant?.pattern ?? "*";
	const persistedPattern = decision.persistedGrant?.pattern ?? sessionPattern;
	return [
		"Allow once",
		`Allow "${sessionPattern}" for this session`,
		`Allow "${persistedPattern}" for this project (${cwd})`,
		`Allow "${persistedPattern}" for all projects`,
		"Abort",
		"Abort with reason…",
	];
}

export function dialogTitle(decision: Decision, sub?: { role: string; task: string }): string {
	const floors = decision.floors.length ? ` [floor: ${decision.floors.join(", ")}]` : "";
	const origin = sub ? `\nfrom subagent(${sub.role}): ${displaySnippet(sub.task, 120)}` : "";
	return `pi-gate: ${decision.facts.toolName} — ${displaySnippet(decision.facts.preview, 240)}${floors}${origin}\n${surfaceSummary(decision)}`;
}

function surfaceSummary(decision: Decision): string {
	return decision.checks
		.filter((check) => check.surface !== decision.facts.toolName)
		.slice(0, 4)
		.map((check) => `${check.surface}: ${displaySnippet(check.value, 120)} = ${check.action}${check.floor ? ` (${check.floor})` : ""}`)
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
