import { describe, expect, it } from "vitest";
import { canonicalRole, DEFAULT_ROLE_NAME, resolveCallRole, resolveRole, ROLES, ROLE_ORDER } from "../roles.ts";
import { buildChildSystemPrompt, CHILD_TASK_WRAPPER } from "../prompt.ts";
import { DEFAULT_SUBAGENT_LIMITS, parseSubagentConfig } from "../../pi-gate/schema.ts";

describe("roles", () => {
	it("resolves case and separator variants", () => {
		expect(resolveRole("Explore")?.name).toBe("explore");
		expect(resolveRole(" GENERAL-PURPOSE ")?.name).toBe("general-purpose");
		expect(resolveRole("general purpose")?.name).toBe("general-purpose");
		expect(resolveRole("nope")).toBeUndefined();
	});

	it("canonicalizes the words that name a role and nothing else", () => {
		expect(canonicalRole("Explore")).toBe("explore");
		expect(canonicalRole("general_purpose")).toBe("general-purpose");
		expect(canonicalRole("gp")).toBe("general-purpose");
		expect(canonicalRole("survey")).toBe("explore");
		expect(canonicalRole("critique")).toBe("review");
		// Not role words: they must stay untouched so the schema names the allowed values to the model.
		expect(canonicalRole("browse")).toBeUndefined();
		expect(canonicalRole("")).toBeUndefined();
		expect(canonicalRole("   ")).toBeUndefined();
		expect(canonicalRole(undefined)).toBeUndefined();
		expect(canonicalRole(null)).toBeUndefined();
		expect(canonicalRole(7)).toBeUndefined();
		// "code" reads as "write code", which is general-purpose; mapping it to review would silently
		// hand back a read-only child for a task that asked for edits.
		expect(canonicalRole("code")).toBeUndefined();
	});

	it("gives an unnamed call the configured default role and says it did", () => {
		expect(DEFAULT_ROLE_NAME).toBe("general-purpose");
		expect(DEFAULT_SUBAGENT_LIMITS.defaultRole).toBe(DEFAULT_ROLE_NAME);
		expect(resolveCallRole("explore", "general-purpose")).toEqual({ role: ROLES.explore, roleDefaulted: false });
		expect(resolveCallRole(undefined, "explore")).toEqual({ role: ROLES.explore, roleDefaulted: true });
		expect(resolveCallRole("  ", "review").role.name).toBe("review");
		// The default is a role that exists, or every unnamed call would die inside runChild.
		for (const name of ROLE_ORDER) expect(resolveCallRole(undefined, name).role.name).toBe(name);
	});

	it("keeps the gate's config vocabulary in step with the roles that exist", () => {
		// The union lives in pi-gate/schema.ts and the roles live here; a name added to one and not the
		// other would make `subagent.defaultRole` unspellable, so both directions are pinned.
		for (const name of ROLE_ORDER) expect(parseSubagentConfig({ defaultRole: name }, "test").limits.defaultRole).toBe(name);
		expect(Object.keys(ROLES).sort()).toEqual([...ROLE_ORDER].sort());
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
