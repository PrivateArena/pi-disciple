/**
 * labels.ts — the one-line strings a card is titled with. Pinned here rather than in render.test.ts
 * because both the TUI renderer and the frontend `details` read these, and they must agree.
 */
import { describe, expect, it } from "vitest";
import { clip, roleDisplayName, taskBody, taskLabel } from "../labels.ts";

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

describe("taskLabel", () => {
	it("puts the task on one line", () => {
		expect(taskLabel("Survey the gate\n\n  and list\tthe rule layers")).toBe("Survey the gate and list the rule layers");
		expect(taskLabel("# Findings\nrest")).toBe("Findings rest");
		expect(taskLabel("")).toBe("");
		expect(taskLabel(undefined)).toBe("");
	});

	it("never shortens the prompt a human has to audit", () => {
		const long = `read every rule layer, cite file:line, and name the exact pattern.\n\n${"x".repeat(4000)}`;
		expect(taskLabel(long)).toBe(long.replace(/\s+/g, " ").trim());
		expect(taskLabel(long)).not.toContain("…");
		expect(taskLabel(long).length).toBeGreaterThan(4000);
	});
});

describe("taskBody", () => {
	it("keeps the task as written", () => {
		const task = "Survey the gate.\n\n- list the rule layers\n  with their order";
		expect(taskBody(task)).toBe(task);
		expect(taskBody(`  ${task}\n\n`)).toBe(task);
		expect(taskBody(undefined)).toBe("");
	});
});

describe("clip", () => {
	it("only marks what it shortened", () => {
		expect(clip("abcdefghij", 11)).toBe("abcdefghij");
		expect(clip("abcdefghij", 5)).toBe("abcd…");
	});
});
