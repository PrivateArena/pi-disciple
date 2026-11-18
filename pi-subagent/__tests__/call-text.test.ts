/**
 * `call-text.ts` — the one question: is this text a tool call the model wrote out by hand?
 *
 * The positive half is the shapes a budget-starved child really leaves behind, the first of them copied from
 * the transcript that motivated this whole path (`tool_calls.txt`, 2026-11-17: thinking, then
 * "Now I'll write the code. Starting with deps and lib.rs:" + `[Tool call: bash]`, `stopReason: "stop"`).
 *
 * The negative half is what a *report* says about calls: a report is the text this check runs on most, and a
 * false positive costs a turn the child did not intend to spend.
 *
 * The last block is the parity claim: every dialect the child's mirror knows is one `pi-gate`'s guard also
 * catches, so the subset stays a subset while the two files evolve apart.
 */

import { describe, expect, it } from "vitest";
import { callTextEvidence, callTextRuleIds, callTextShapeIds, endsWithCallMarkup, looksLikeToolCallText, stripCode } from "../call-text.ts";
import { detectMalformedCall } from "../../pi-gate/guard.ts";
import { DEFAULT_GUARD_CONFIG } from "../../pi-gate/schema.ts";

describe("call-text", () => {
	it("catches the emission that motivated it: narration plus a call named in brackets", () => {
		const leaked = "Now I'll write the code. Starting with deps and lib.rs:\n[Tool call: bash]";
		expect(looksLikeToolCallText(leaked)).toBe(true);
		expect(callTextEvidence(leaked)?.id).toBe("special-token");
		expect(callTextEvidence(leaked)?.evidence).toContain("[Tool call: bash]");
	});

	it("catches the tag dialects", () => {
		for (const text of [
			"writing it now.\n<tool_call>\n<invoke name=\"bash\">",
			"<invoke name=\"read\">\n<parameter name=\"path\">a.ts</parameter>",
			"next:\n<tool_call>read a.ts</tool_call>",
			"<function_calls> and then the closer </function>",
			"<antml:invoke name=\"bash\">",
		]) {
			expect(looksLikeToolCallText(text), text).toBe(true);
		}
	});

	it("catches the protocol tokens and the call-shaped JSON", () => {
		for (const text of [
			"about to run: <|tool_call|>bash",
			"[tool_call]",
			"[TOOL USE: grep]",
			'{"name": "bash", "arguments": {"command": "cargo check"}}',
			'{"tool_calls": [{"name": "read"}]}',
		]) {
			expect(looksLikeToolCallText(text), text).toBe(true);
		}
	});

	it("says every dialect that fired, for the log", () => {
		expect(callTextRuleIds("[Tool call: bash]\n<tool_call>")).toEqual(expect.arrayContaining(["special-token", "call-tags"]));
		expect(callTextRuleIds("")).toEqual([]);
	});

	it("leaves a report alone", () => {
		for (const text of [
			"Findings: the gate lives in pi-gate/policy.ts and evaluates rules in order.",
			"I used the bash tool three times; the tool call limit was never reached.",
			"The read tool takes a path parameter, and arguments are validated before execution.",
			"The response ended with a stop reason, so no call was pending.",
			'{"path": "a.ts", "offset": 10} — the shape a parameter takes',
			"",
			"   ",
		]) {
			expect(looksLikeToolCallText(text), text).toBe(false);
		}
	});

	it("does not fire on code the report quotes", () => {
		expect(looksLikeToolCallText("The dialect is `<invoke name=\"read\">`, and it goes unrewarded.")).toBe(false);
		expect(looksLikeToolCallText("Example:\n```\n<invoke name=\"read\">\n  <parameter name=\"path\">a.ts</parameter>\n```\nThat is what the guard rejects.")).toBe(false);
		expect(stripCode("a `b` c")).toBe("a   c");
	});

	it("mirrors the gate's dialects where it must, and only there", () => {
		expect(callTextShapeIds().sort()).toEqual(["call-tags", "chat-template-token", "json-call", "special-token"]);
		const positives = [
			"[Tool call: bash]",
			// The name with its arguments written out too: the same emission, one line further.
			'[Tool call: bash({"command":"cargo check"})]',
			"<tool_call><invoke name=\"bash\">",
			"<|tool_call|>bash",
			'{"name": "bash", "arguments": {"command": "ls"}}',
		];
		for (const text of positives) {
			expect(looksLikeToolCallText(text), text).toBe(true);
			const hit = detectMalformedCall({
				text,
				thinking: "",
				toolNames: new Set(["bash", "read", "edit", "write", "grep"]),
				config: DEFAULT_GUARD_CONFIG,
			});
			expect(hit, `pi-gate's guard does not catch ${text}`).toBeDefined();
		}
	});

	it("judges the tag and JSON dialects on the tail, the tokens everywhere", () => {
		// Past the window, a tag named in passing is not an emission. Within it, the reminder path is deliberately
		// the wider of the two: an over-eager reminder costs one steer, while an over-eager "markup" verdict on a
		// finished report costs the caller a re-run — which is what `endsWithCallMarkup` is for, below.
		const discussion = `The guard rejects a stray <tool_call> tag written into a template, so the fix moved the parser, ` +
			`renamed the element in the docs, added a regression test, and left the exported renderer alone. ` +
			`Nothing else in the crate reads the tag, and the changelog notes the rename for downstream users. ` +
			`The remaining question is whether a template that ships with one should be rejected at load or at render, ` +
			`and the answer this change takes is at render, because a load-time refusal would break an export that is ` +
			`otherwise correct and never touches the tag.`;
		expect(discussion.length).toBeGreaterThan(400);
		expect(looksLikeToolCallText(discussion)).toBe(false);
		expect(endsWithCallMarkup(discussion)).toBe(false);
		expect(looksLikeToolCallText(`${discussion}\n<tool_call>`)).toBe(true);
		// A protocol token is never prose, however early it appears.
		expect(looksLikeToolCallText("<|tool_call|> then a long explanation of the parser, the tests and the changelog")).toBe(true);
	});

	it("separates the emission from the report about an emission", () => {
		expect(endsWithCallMarkup("Now I'll write the code:\n[Tool call: bash]")).toBe(true);
		expect(endsWithCallMarkup("Now I'll write the code:\n[Tool call: bash].")).toBe(true);
		expect(endsWithCallMarkup('[Tool call: bash({"command":"ls"})]')).toBe(true);
		// Named inside a sentence, then the actual answer: a report, and the classification the parent's banner depends on.
		expect(endsWithCallMarkup("The leak was `[Tool call: bash]` written as text; the fix catches it in the tail rule.")).toBe(false);
		expect(endsWithCallMarkup("Findings: three rules, in order.")).toBe(false);
	});

	it("only blanks a closed fence, so a truncated emission stays visible", () => {
		// The same judgement as the gate: a cut-off message stops *inside* a fence, and blanking the rest of the
		// buffer there would hide the fragment this module exists to catch.
		expect(stripCode("a ```b``` c")).toBe("a   c");
		expect(stripCode("a ```b c")).toContain("```b c");
		expect(looksLikeToolCallText("Plan:\n```\n[Tool call: bash]\ncargo check\n")).toBe(true);
	});
});
