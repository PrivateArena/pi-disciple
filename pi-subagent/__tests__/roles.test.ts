import { describe, expect, it } from "vitest";
import { resolveRole, ROLES, ROLE_ORDER } from "../roles.ts";
import { buildChildSystemPrompt, CHILD_TASK_WRAPPER } from "../prompt.ts";
import { DEFAULT_SUBAGENT_LIMITS } from "../../pi-gate/schema.ts";

describe("roles", () => {
	it("resolves case and separator variants", () => {
		expect(resolveRole("Explore")?.name).toBe("explore");
		expect(resolveRole(" GENERAL-PURPOSE ")?.name).toBe("general-purpose");
		expect(resolveRole("general purpose")?.name).toBe("general-purpose");
		expect(resolveRole("nope")).toBeUndefined();
	});

	it("has the budgets the plan specifies", () => {
		expect(ROLES.explore.allowTools).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(ROLES.explore.maxTurns).toBe(20);
		expect(ROLES.explore.timeoutMinutes).toBe(10);
		expect(ROLES.review.maxTurns).toBe(15);
		expect(ROLES["general-purpose"].allowTools).toEqual(["*"]);
		expect(ROLES["general-purpose"].maxTurns).toBe(40);
		expect(ROLE_ORDER).toEqual(["explore", "general-purpose", "review"]);
	});

	it("stays under the nested-call ceiling (FM-13)", () => {
		for (const role of ROLE_ORDER.map((name) => ROLES[name])) {
			// maxTurns x max parallel calls per turn must stay clear of 256.
			expect(role.maxTurns * 5).toBeLessThanOrEqual(256);
			expect(role.maxTurns).toBeLessThanOrEqual(DEFAULT_SUBAGENT_LIMITS.maxTurns * 2);
		}
	});
});

describe("child system prompt", () => {
	const prompt = buildChildSystemPrompt(ROLES.explore, "/work/repo");

	it("states the role, the cwd and the one-shot contract", () => {
		expect(prompt).toContain("explore subagent working in /work/repo");
		expect(prompt).toMatch(/no conversation history/);
		expect(prompt).toMatch(/do not delegate/i);
	});

	it("is short and carries no tool list or config paths (step 11)", () => {
		expect(prompt.split(/\s+/).length).toBeLessThanOrEqual(120);
		expect(prompt.split(/\s+/).length * 1.4).toBeLessThanOrEqual(220);
		expect(prompt).not.toContain("~/.pi");
		expect(prompt.toLowerCase()).not.toMatch(/\n?(available tools|you can use the following tools)/);
	});

	it("wraps the task with a self-contained reminder", () => {
		expect(CHILD_TASK_WRAPPER).toMatch("self-contained");
	});
});
