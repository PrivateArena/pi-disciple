/**
 * What the model and the human actually see from `pi.registerTool`, and the config that steers it.
 *
 * `index.ts` is otherwise wiring, but three of its values *are* the product: the parameter schema (a call
 * that fails validation is a call the model remembers as "this tool breaks"), the `prepareArguments` shim
 * (pi's own hook, run before validation), and the description/guidelines text (the whole reason a model
 * reaches for delegation instead of reading forty files itself). None of that is exercised by the run
 * tests, which start after the call is already valid. So it is asserted here against a stub `pi`.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piSubagent, { applyDelegationSection, prepareRoleArgs } from "../index.ts";
import { buildDelegationSection, DELEGATION_SECTION, delegationSectionWords, DELEGATION_WORD_BUDGET } from "../delegation.ts";
import { ROLE_ORDER, applyRoleConfig } from "../roles.ts";
import { loadSubagentLimits, DEFAULT_LIMITS } from "../config-file.ts";

interface RegisteredTool {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: TSchema;
	prepareArguments?: (args: unknown) => Record<string, unknown>;
	executionMode?: string;
}

function register(): { tool: RegisteredTool; handlers: Map<string, Array<(event: any, ctx: any) => Promise<unknown>>> } {
	let tool: RegisteredTool | undefined;	const { stub, handlers } = registerStub({
		registerTool: (definition: RegisteredTool) => (tool = definition),
	});
	piSubagent(stub as unknown as ExtensionAPI);
	if (!tool) throw new Error("pi-subagent registered no tool");
	return { tool, handlers };
}

/** The pieces of `ExtensionAPI` the extension touches, plus a capture of its event handlers. */
function registerStub(over: Record<string, unknown> = {}) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<unknown>>>();
	const stub = {
		registerTool: () => undefined,
		registerCommand: () => undefined,
		on: (event: string, handler: (event: any, ctx: any) => Promise<unknown>) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		getActiveTools: () => ["read", "bash", "subagent"],
		getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "subagent" }],
		setActiveTools: () => undefined,
		...over,
	};
	return { stub, handlers };
}

/**
 * One temp agent dir per fixture, with the `subagent` section written into it.
 *
 * Each fixture gets its own directory on purpose: `loadSubagentLimits` caches by "paths + mtimes", and two
 * fixtures written in the same millisecond in the *same* file would share a stamp, so a test would read the
 * previous test's limits. Distinct paths cannot collide, which is what makes this suite deterministic.
 */
const agentDirs: string[] = [];
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

function configDir(config: Record<string, unknown>): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-sub-reg-"));
	mkdirSync(join(agentDir, "extensions", "pi-gate"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "pi-gate", "config.json"), JSON.stringify(config), "utf8");
	agentDirs.push(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir; // the handler calls loadSubagentLimits() without an explicit dir
	return agentDir;
}

function withLimits(config: Record<string, unknown>): () => ReturnType<typeof loadSubagentLimits> {
	const agentDir = configDir(config);
	return () => loadSubagentLimits(join(agentDir, "repo"), false, agentDir);
}

afterEach(() => {
	for (const dir of agentDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

describe("the subagent tool declaration", () => {
	const registration = register();
	const tool = registration.tool;

	it("names the tool and blocks sequentially", () => {
		expect(tool.name).toBe("subagent");
		expect(tool.executionMode).toBe("sequential");
	});

	it("does not require a role, so an unnamed call is a default and not a schema error", () => {
		// Mirrors pi's validateToolArguments: an ajv check over `parameters`.
		const check = Compile(tool.parameters);
		expect(check.Check({ task: "survey the gate" })).toBe(true);
		expect((tool.parameters as { required?: string[] }).required).toEqual(["task"]);
	});

	it("accepts any role word at the schema, because the table comes from the config", () => {
		// A registered schema is fixed for the process while `subagent.roles` is re-read per call, so an enum
		// would refuse a role the human had just added. `execute` refuses an unknown name and lists the real ones.
		const check = Compile(tool.parameters);
		expect(check.Check({ role: "browse", task: "x" })).toBe(true);
		expect(check.Check({ role: 7, task: "x" })).toBe(false);
		const description = JSON.stringify(tool.parameters);
		for (const name of ROLE_ORDER) expect(description).toContain(name);
		expect(description).toContain("subagent.roles");
	});

	it("canonicalizes the role spellings a model produces before validation", () => {
		// Without this shim every one of these was a validation error, which is how a tool earns a
		// reputation for being broken and stops being called.
		expect(prepareRoleArgs({ role: "Explore", task: "x" }).role).toBe("explore");
		expect(prepareRoleArgs({ role: "General Purpose", task: "x" }).role).toBe("general-purpose");
		expect(prepareRoleArgs({ role: "gp", task: "x" }).role).toBe("general-purpose");
		expect(prepareRoleArgs({ role: "survey", task: "x" }).role).toBe("explore");
	});

	it("leaves what it does not recognize, and survives junk arguments", () => {
		expect(prepareRoleArgs({ role: "browse", task: "x" }).role).toBe("browse");
		expect(prepareRoleArgs({ role: null, task: "x" })).toEqual({ role: null, task: "x" });
		expect(prepareRoleArgs({ task: "x" })).toEqual({ task: "x" });
		expect(() => prepareRoleArgs(undefined)).not.toThrow();
		expect(() => prepareRoleArgs("nope")).not.toThrow();
	});

	it("says why to delegate, not only what the tool is", () => {
		// The description is the field a model weighs when it chooses a tool, so it has to carry the
		// payoff (context stays clean) and the triggers, not just the mechanics.
		expect(tool.description).toMatch(/context/i);
		expect(tool.description).toMatch(/never enters your context|never enter your context/i);
		expect(tool.description).toMatch(/more than about three reads/i);
		expect(tool.description).toMatch(/not for a single read|not for a single read or edit/i);
		expect(tool.description).toMatch(/permission/i);
		expect(tool.promptSnippet ?? "").toMatch(/context/i);
	});

	it("states the roles and their default in the rules bullets", () => {
		const guidelines = tool.promptGuidelines ?? [];
		expect(guidelines.length).toBeLessThanOrEqual(4);
		for (const name of ROLE_ORDER) expect(guidelines.join(" ")).toContain(name);
		expect(guidelines.join(" ")).toMatch(/unnamed|omit/i);
		for (const rule of guidelines) expect(rule.length).toBeLessThanOrEqual(160);
	});
});

describe("the delegation system prompt section", () => {
	const limits = { enabled: true, delegationPrompt: true, defaultRole: "general-purpose" as const };

	it("is added to the run's prompt sections", () => {
		const options = { sections: {} as Record<string, string> };
		expect(applyDelegationSection(options, limits)).toContain("Delegate");
		expect(options.sections[DELEGATION_SECTION]).toContain("subagent");
	});

	it("survives a custom prompt package, and yields to a forced prompt", () => {
		const run = (limitsOver: Partial<typeof limits>, optionsOver: Record<string, unknown> = {}) => {
			const options = { sections: { [DELEGATION_SECTION]: "stale" }, ...optionsOver };
			const text = applyDelegationSection(options, { ...limits, ...limitsOver });
			return { text, section: options.sections[DELEGATION_SECTION] };
		};
		expect(run({}).section).not.toBe("stale"); // enabled: replaced, not left stale
		expect(run({ delegationPrompt: false }).section).toBeUndefined();
		expect(run({ enabled: false }).section).toBeUndefined();
		// pi renders a custom prompt as the preamble and still appends every other section, so a prompt
		// package is not a request for silence. Measured: this machine's `pi-system-prompt` package sets one.
		expect(run({}, { customPrompt: "my prompt" }).section).toContain("Delegate");
		// A forced prompt is a handler's exact text for the turn; arguing with it is not our place.
		expect(run({}, { forceSystemPrompt: "forced" }).section).toBeUndefined();
	});

	it("says what to delegate, what not to, and what a child needs", () => {
		const text = buildDelegationSection({ defaultRole: "review" });
		expect(text).toMatch(/Reach for `subagent` when/);
		expect(text).toMatch(/Do not delegate/);
		expect(text).toMatch(/sees none of this conversation/);
		expect(text).toMatch(/review:.*\) — what an unnamed call gets/);
		for (const name of ROLE_ORDER) expect(text).toContain(name);
		expect(delegationSectionWords(text)).toBeLessThanOrEqual(DELEGATION_WORD_BUDGET);
		expect(text).not.toMatch(/\/home\/|~\/\.pi|C:\\\\/);
	});

	it("keeps a section name pi accepts", () => {
		expect(DELEGATION_SECTION).toMatch(/^[a-z][a-z0-9_-]*$/);
		expect(DELEGATION_SECTION).not.toBe("preamble");
	});
});

describe("config for the new keys", () => {
	it("reads the default role and the prompt switch, with their origin", () => {
		const loaded = withLimits({ subagent: { defaultRole: "Explore", delegationPrompt: false } })();
		expect(loaded.errors).toEqual([]);
		expect(loaded.limits.defaultRole).toBe("explore");
		expect(loaded.limits.delegationPrompt).toBe(false);
		expect(loaded.origins.defaultRole).toContain("config.json");
		expect(loaded.origins.delegationPrompt).toContain("config.json");
	});

	it("refuses a default role that names no role instead of guessing one", () => {
		const loaded = withLimits({ subagent: { defaultRole: "browse" } })();
		expect(loaded.limits.defaultRole).toBe(DEFAULT_LIMITS.defaultRole);
		expect(loaded.errors.join(" ")).toContain("defaultRole");
	});

	it("takes a default role and the prompt's role list from subagent.roles", () => {
		const loaded = withLimits({ subagent: { defaultRole: "auditor", roles: { auditor: { tools: ["read", "grep"], description: "Compliance read-through" } } } })();
		expect(loaded.errors).toEqual([]);
		expect(loaded.limits.defaultRole).toBe("auditor");
		const text = buildDelegationSection({ defaultRole: loaded.limits.defaultRole, roles: loaded.effectiveRoles });
		expect(text).toContain("auditor: compliance read-through (reads only) — what an unnamed call gets");
		// The budget bounds the shipped section; a role the human added costs one line, which is bounded here.
		const builtIn = delegationSectionWords(buildDelegationSection({ defaultRole: "general-purpose" }));
		expect(builtIn).toBeLessThanOrEqual(DELEGATION_WORD_BUDGET);
		expect(delegationSectionWords(text) - builtIn).toBeLessThanOrEqual(15);
	});

	it("does not let the config list run past the section's word budget", () => {
		const config = Object.fromEntries(Array.from({ length: 24 }, (_unused, i) => [`role_${i}`, { tools: ["read"], description: `A role number ${i} for the budget test` }]));
		const roles = applyRoleConfig(config).roles;
		const text = buildDelegationSection({ defaultRole: "general-purpose", roles });
		expect(text).toContain("role_4");
		expect(text).not.toContain("- role_20:");
		expect(text).toContain("more role(s) defined by the config");
		expect(delegationSectionWords(text)).toBeLessThanOrEqual(DELEGATION_WORD_BUDGET + 90);
	});

	it("keeps the shipped config and the built-in defaults in step", () => {
		expect(withLimits({})().limits).toEqual(DEFAULT_LIMITS);
	});

	it("reaches the run's system prompt through before_agent_start", async () => {
		configDir({ subagent: { defaultRole: "review" } });
		const { handlers } = register();
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		const ctx = { cwd: "/work/repo", isProjectTrusted: () => false, ui: { notify: () => undefined } };
		for (const handler of handlers.get("before_agent_start") ?? []) await handler(event, ctx);
		const section = event.systemPromptOptions.sections[DELEGATION_SECTION] ?? "";
		expect(section).toContain("review: critique of existing code, plans or diffs (reads only) — what an unnamed call gets");
	});

	it("adds nothing to the prompt when the human turned the section off", async () => {
		configDir({ subagent: { delegationPrompt: false } });
		const { handlers } = register();
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		const ctx = { cwd: "/work/repo", isProjectTrusted: () => false, ui: { notify: () => undefined } };
		for (const handler of handlers.get("before_agent_start") ?? []) await handler(event, ctx);
		expect(event.systemPromptOptions.sections[DELEGATION_SECTION]).toBeUndefined();
	});
});
