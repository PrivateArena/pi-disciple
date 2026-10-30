import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import {
	COLLAPSED_REPORT_LINES,
	formatCallBlock,
	formatDuration,
	formatIdentityLine,
	formatReportBody,
	formatResultBlock,
	formatRunStats,
	formatStatusLine,
	formatTokenCount,
	renderSubagentCall,
	renderSubagentResult,
} from "../render.ts";
import { composeResult, progressDetails, uiStatus, cardFields, formatTokens, previewOf, clip, type SubagentDetails } from "../run.ts";
import type { ChildResult } from "../child.ts";

/** Plain-text theme: these tests assert the words, not the colours. */
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const usage = (totalTokens: number) => ({ totalTokens } as Usage);

const details = (overrides: Partial<SubagentDetails> = {}): SubagentDetails => ({
	...cardFields(
		{ role: "explore", task: "survey the gate", model: "local/qwen3.8-flash-next (inherited)" },
		{ toolCalls: 3, elapsedMs: 21_000, agentId: "01abc", report: "Findings: the gate lives in pi-gate/policy.ts." },
	),
	status: "completed",
	role: "explore",
	exit: "done",
	turns: 2,
	toolCalls: 3,
	truncated: false,
	elapsedMs: 21_000,
	childSessionId: "01abc",
	childSessionFile: "/tmp/child.jsonl",
	model: "local/qwen3.8-flash-next (inherited)",
	report: "Findings: the gate lives in pi-gate/policy.ts.",
	...overrides,
});

const child = (overrides: Partial<ChildResult> = {}): ChildResult => ({
	text: "Findings: the gate lives in pi-gate/policy.ts.",
	exit: "done",
	turns: 2,
	toolCalls: 3,
	...overrides,
});

describe("duration and token formatting", () => {
	it("formats sub-minute, minute and hour runs", () => {
		expect(formatDuration(21_000)).toBe("21.0s");
		expect(formatDuration(813_000)).toBe("13m 33s");
		expect(formatDuration(7_380_000)).toBe("2h 3m");
	});

	it("omits a token count the child never reported", () => {
		expect(formatTokenCount(undefined)).toBe("");
		expect(formatTokenCount(usage(0))).toBe("");
		expect(formatTokenCount(usage(4200))).toBe("4.2k token");
		expect(formatTokenCount(usage(420))).toBe("420 token");
	});

	it("builds the parenthetical only from what the run did", () => {
		expect(formatRunStats({ turns: 2, toolCalls: 1 }, usage(4200))).toBe(" (2 turns, 1 tool use, 4.2k token)");
		expect(formatRunStats({ turns: 0, toolCalls: 0 }, undefined)).toBe("");
	});

	it("falls back to the details' own token total, since pi hands a renderer only content and details", () => {
		expect(formatStatusLine(details(), undefined, theme)).toBe("Agent completed in 21.0s (2 turns, 3 tool uses).");
		const counted = { ...details(), tokens: formatTokens(usage(4200)) };
		expect(formatStatusLine(counted, undefined, theme)).toBe("Agent completed in 21.0s (2 turns, 3 tool uses, 4.2k token).");
	});
});

describe("the status sentence", () => {
	it("reads as a sentence when the child finished", () => {
		expect(formatStatusLine(details(), usage(4200), theme)).toBe("Agent completed in 21.0s (2 turns, 3 tool uses, 4.2k token).");
	});

	it("says what is running, and why a run stopped", () => {
		expect(formatStatusLine(details({ status: "running", exit: undefined, elapsedMs: 5000 }), undefined, theme)).toBe(
			"Agent running for 5.0s (2 turns, 3 tool uses)",
		);
		expect(formatStatusLine(details({ status: "stopped", exit: "timeout" }), undefined, theme)).toContain("Agent stopped after 21.0s (timeout)");
		expect(formatStatusLine(details({ status: "error", exit: "error", error: "429 rate limited" }), undefined, theme)).toContain(
			"Agent failed after 21.0s (2 turns, 3 tool uses): 429 rate limited",
		);
	});

	it("names the role, model, agent id and transcript", () => {
		const line = formatIdentityLine(details(), theme);
		expect(line).toContain("role: explore");
		expect(line).toContain("model: local/qwen3.8-flash-next (inherited)");
		expect(line).toContain("Agent ID: 01abc");
		expect(line).toContain("transcript: /tmp/child.jsonl");
	});
});

describe("the report body", () => {
	const longReport = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");

	it("shows the head collapsed and the whole report expanded, and says how much is left",
		() => {
			const collapsed = formatReportBody(details(), longReport, false, theme).split("\n");
			expect(collapsed[0]).toBe("line 1");
			expect(collapsed[COLLAPSED_REPORT_LINES - 1]).toBe("line 10");
			expect(collapsed).toHaveLength(COLLAPSED_REPORT_LINES + 1);
			expect(collapsed.at(-1)).toContain("50 more lines");

			// Expanded is the human asking for the rest, so the card prints all of it: no second clip.
			const expanded = formatReportBody(details(), longReport, true, theme).split("\n");
			expect(expanded).toHaveLength(60);
			expect(expanded.at(-1)).toBe("line 60");
			expect(expanded.join("\n")).toBe(longReport);
		},
	);

	it("adds no hint when the whole report fits", () => {
		expect(formatReportBody(details(), "one\ntwo", false, theme)).toBe("one\ntwo");
	});

	it("says so when the child returned no text", () => {
		expect(formatReportBody(details(), "   ", false, theme)).toContain("returned no text");
	});
});

describe("the result block", () => {
	it("leads with the status sentence, then identity, then the child's report", () => {
		const result = composeResult(child(), "explore", 20_000, 21_000, { task: "survey the gate", childSessionId: "01abc" });
		const rendered = formatResultBlock(result.details, result, false, theme);
		expect(rendered).toContain("Agent completed in 21.0s");
		expect(rendered).toContain("role: explore");
		expect(rendered).toContain("Agent ID: 01abc");
		expect(rendered).toContain("Findings:");
	});

	it("renders the report, not the model-facing header, in the card", () => {
		const result = composeResult(child({ text: "Answer." }), "review", 20_000, 1000);
		const rendered = formatResultBlock(result.details, result, true, theme);
		expect(rendered).not.toContain("[subagent review");
		expect(rendered).toContain("Answer.");
	});

	it("says what a running child is doing", () => {
		const running = progressDetails(
			{ turns: 1, toolCalls: 2, lastTool: "bash", elapsedMs: 8000 },
			{ role: "explore", task: "survey the gate", shimTools: ["read"], nestedCalls: 2 },
		);
		const rendered = formatResultBlock(running, { content: [{ type: "text", text: "subagent running" }], details: running }, false, theme);
		expect(rendered).toContain("Agent running for 8.0s");
		expect(rendered).toContain("last call: bash");
		// The task belongs to the call block above the card, not to the status block: a running child
		// would otherwise print it twice. Frontends still get `details.task`.
		expect(rendered).not.toContain("survey the gate");
	});

	it("titles the call with the role, and admits when the role is not the model's",
		() => {
			// The role leads the title: it is the one part a narrow card must not lose to truncation. The
			// prompt goes under it, whole, from the first render of the call.
			expect(formatCallBlock({ role: "explore", task: "survey the gate" }, theme)).toBe("Explore\nsurvey the gate");
			expect(formatCallBlock({ role: "general-purpose", task: "fix the flaky test" }, theme)).toBe("General Purpose\nfix the flaky test");
			// pi renders this while the arguments stream in: a role that has not arrived may still arrive.
			expect(formatCallBlock({}, theme, { argsComplete: false })).toBe("Launch subagent");
			expect(formatCallBlock({ task: "survey the gate" }, theme, { argsComplete: false })).toBe("Launch subagent\nsurvey the gate");
			// Complete arguments and no role: name the role that will actually run, as the human's choice.
			expect(formatCallBlock({}, theme, { argsComplete: true, defaultRole: "explore" })).toBe("Explore (default)");
			expect(formatCallBlock({}, theme, { argsComplete: true })).toContain("(default)");
			// A frontend that renders without a context is a settled call, not a streaming one.
			expect(formatCallBlock({}, theme)).toContain("(default)");
			expect(formatCallBlock({ role: "review" }, theme)).not.toContain("default");
		});

	it("prints the whole prompt under the role, clipped never", () => {
		const long = `Read every file in pi-gate/ and describe\nhow the policy layer resolves a grant,\nthen list ${"the ones that can loop; ".repeat(60)}and say why.`;
		const block = formatCallBlock({ role: "explore", task: long }, theme);
		expect(block.startsWith("Explore\n")).toBe(true);
		expect(block).toBe(`Explore\n${long}`);
		expect(block).not.toContain("…");
		// The card's collapse is the scrollable affordance; the text itself is not cut to fit the title.
		expect(formatCallBlock({ role: "explore", task: "  short task  \n\n" }, theme)).toBe("Explore\nshort task");
	});

	it("marks a defaulted role on the identity line", () => {
		expect(formatIdentityLine(details({ roleDefaulted: true }), theme)).toContain("role: explore (default)");
		expect(formatIdentityLine(details(), theme)).not.toContain("(default)");
	});

	it("the component renders the block", () => {
		const result = composeResult(child(), "explore", 20_000, 21_000);
		const lines = renderSubagentResult(result, { expanded: false, isPartial: false }, theme).render(200).join("\n");
		expect(lines).toContain("Agent completed in 21.0s");
		expect(renderSubagentCall({ role: "explore", task: "survey" }, theme).render(200).join("\n")).toContain("Explore");
	});

	it("falls back to the raw text when there are no details", () => {
		const rendered = renderSubagentResult({ content: [{ type: "text", text: "raw" }], details: undefined }, { expanded: false, isPartial: false }, theme);
		expect(rendered.render(200).join("\n")).toContain("raw");
	});
});

describe("progress details", () => {
	it("carry a full status, not an empty object", () => {
		const update = progressDetails(
			{ turns: 4, toolCalls: 7, lastTool: "bash", elapsedMs: 9000 },
			{ role: "explore", task: "survey the gate", model: "local/qwen3.8-flash-next (inherited)", shimTools: ["read", "bash"], nestedCalls: 7 },
		);
		expect(update.status).toBe("running");
		expect(update.exit).toBeUndefined();
		expect(update.role).toBe("explore");
		expect(update.activity).toBe("bash");
		expect(update.task).toBe("survey the gate");
		expect(update.model).toContain("inherited");
		expect(update.toolCalls).toBe(7);
	});

	it("say the child is thinking before its first tool call", () => {
		const update = progressDetails({ turns: 0, toolCalls: 0, elapsedMs: 0 }, { role: "explore", task: "t", shimTools: [], nestedCalls: 0 });
		expect(update.activity).toBe("thinking");
	});
});

describe("the frontend card contract", () => {
	it("maps every exit onto a status a frontend has a branch for", () => {
		expect(uiStatus("done")).toBe("completed");
		expect(uiStatus("aborted")).toBe("stopped");
		expect(uiStatus("timeout")).toBe("stopped");
		expect(uiStatus("maxTurns")).toBe("aborted");
		expect(uiStatus("callLimit")).toBe("aborted");
		expect(uiStatus("overflow")).toBe("aborted");
		expect(uiStatus("error")).toBe("error");
	});

	it("settles a result with the fields a card is drawn from", () => {
		const result = composeResult(child(), "explore", 20_000, 21_000, {
			task: "survey the gate",
			model: "local/qwen3.8-flash-next (inherited)",
			childSessionId: "01abc",
		});
		const card = result.details;
		expect(card.status).toBe("completed");
		expect(card.exit).toBe("done");
		expect(card.displayName).toBe("Explore");
		expect(card.subagentType).toBe("explore");
		expect(card.description).toBe("survey the gate");
		expect(card.toolUses).toBe(3);
		expect(card.durationMs).toBe(21_000);
		expect(card.agentId).toBe("01abc");
		expect(card.modelName).toContain("inherited");
		expect(card.preview).toBe("Findings: the gate lives in pi-gate/policy.ts.");
	});

	it("claims no field the run did not earn", () => {
		const running = progressDetails(
			{ turns: 0, toolCalls: 0, elapsedMs: 0 },
			{ role: "review", task: "critique", shimTools: [], nestedCalls: 0 },
		);
		expect(running.status).toBe("running");
		expect(running.displayName).toBe("Review");
		expect(running.tokens).toBe("");
		expect(running.agentId).toBeUndefined();
		expect(running.preview).toBeUndefined();
		expect(cardFields({ role: "explore", task: "t" }, { toolCalls: 1, elapsedMs: 1, usage: { totalTokens: 4200 } as Usage }).tokens).toBe("4.2k token");
	});

	it("formats and clips card rows without inflating them", () => {
		expect(formatTokens(undefined)).toBe("");
		expect(formatTokens({ totalTokens: 4200 } as Usage)).toBe("4.2k token");
		expect(formatTokens({ totalTokens: 1_500_000 } as Usage)).toBe("1.5M token");
		expect(previewOf("## Headline\nbody text", 40)).toBe("Headline");
		expect(clip("abcdefghij", 5)).toBe("abcd…");
	});
});

describe("the budget extension on the card", () => {
	it("appends what the human decided, and moves the period to the end", () => {
		const granted = details({ ceiling: { reason: "maxTurns", outcome: "granted", turns: 40, minutes: 10 } });
		expect(formatStatusLine(granted, undefined, theme)).toBe(
			"Agent completed in 21.0s (2 turns, 3 tool uses) — budget extended by the user at the turn limit: +40 turns / +10 min.",
		);
		const refused = details({ status: "aborted", exit: "maxTurns", ceiling: { reason: "maxTurns", outcome: "rejected", turns: 0, minutes: 0 } });
		expect(formatStatusLine(refused, undefined, theme)).toBe(
			"Agent stopped after 21.0s (maxTurns) (2 turns, 3 tool uses) — extension declined by the user at the turn limit.",
		);
	});

	it("says a running child is running on borrowed time", () => {
		const running = details({
			status: "running",
			exit: undefined,
			elapsedMs: 5_000,
			ceiling: { reason: "timeout", outcome: "granted", turns: 20, minutes: 5 },
		});
		expect(formatStatusLine(running, undefined, theme)).toBe(
			"Agent running for 5.0s (2 turns, 3 tool uses) — budget extended by the user at the time budget: +20 turns / +5 min",
		);
	});

	it("stays silent about budgets for an ordinary run", () => {
		expect(formatStatusLine(details(), undefined, theme)).toBe("Agent completed in 21.0s (2 turns, 3 tool uses).");
		expect(formatResultBlock(details(), { content: [{ type: "text", text: "x" }], details: details() }, true, theme)).not.toContain("budget");
	});
});
