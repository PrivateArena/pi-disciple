/**
 * labels.ts — the one-line strings a card is titled with. Pinned here rather than in render.test.ts
 * because both the TUI renderer and the frontend `details` read these, and they must agree.
 */
import { describe, expect, it } from "vitest";
import { CARD_SUMMARY_CHARS, clip, roleDisplayName, taskSummary } from "../labels.ts";

describe("roleDisplayName", () => {
	it("turns a role id into a title", () => {
		expect(roleDisplayName("explore")).toBe("Explore");
		expect(roleDisplayName("review")).toBe("Review");
		// Separator-joined ids read as words in a title, not as identifiers.
		expect(roleDisplayName("general-purpose")).toBe("General Purpose");
		expect(roleDisplayName("senior_reviewer")).toBe("Senior Reviewer");
	});

	it("names no role when there is none", () => {
		expect(roleDisplayName(undefined)).toBe("Subagent");
		expect(roleDisplayName("")).toBe("Subagent");
	});
});

describe("taskSummary", () => {
	it("puts the task on one line", () => {
		expect(taskSummary("Survey the gate\n\n  and list\tthe rule layers")).toBe("Survey the gate and list the rule layers");
		expect(taskSummary("# Findings\nrest")).toBe("Findings rest");
		expect(taskSummary("")).toBe("");
		expect(taskSummary(undefined)).toBe("");
	});

	it("clips to the card's budget", () => {
		const long = "x".repeat(CARD_SUMMARY_CHARS + 40);
		expect(taskSummary(long)).toBe(`${"x".repeat(CARD_SUMMARY_CHARS - 1)}…`);
		expect(taskSummary("short task", 160)).toBe("short task");
	});
});

describe("clip", () => {
	it("only marks what it shortened", () => {
		expect(clip("abcdefghij", 11)).toBe("abcdefghij");
		expect(clip("abcdefghij", 5)).toBe("abcd…");
	});
});
