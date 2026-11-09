/**
 * What the model and the human actually see from `pi.registerTool`, and the config that steers it.
 *
 * `index.ts` is otherwise wiring, but three of its values *are* the product: the parameter schema (a call
 * that fails validation is a call the model remembers as "this tool breaks"), the `prepareArguments` shim
 * (pi's own hook, run before validation), and the description/guidelines text (the whole reason a model
 * reaches for delegation instead of reading forty files itself). None of that is exercised by the run
 * tests, which start after the call is already valid. So it is asserted here against a stub `pi`.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { buildToolDeclaration, DEFAULT_TOOL_PROMPT, expandToolTokens } from "../tool-declaration.ts";
import { buildDelegationSection, DELEGATION_SECTION, delegationSectionWords, DELEGATION_WORD_BUDGET } from "../delegation.ts";
import { MAX_LISTED_ROLES, ROLE_ORDER, applyRoleConfig } from "../roles.ts";
import { loadSubagentLimits, DEFAULT_LIMITS } from "../config-file.ts";

/**
 * The declaration is built from the config file now, so the suite may not read the developer's own
 * `~/.pi/agent/extensions/pi-disciple/config.json`: an unrelated edit there would decide what these tests see, and
 * did until this line existed. Pin an empty one *before* the extension module runs its import-time render — the
 * reason `index.ts` is loaded dynamically, being the only module here whose load has a side effect.
 */
const ambientDir = mkdtempSync(join(tmpdir(), "pi-sub-ambient-"));
mkdirSync(join(ambientDir, "extensions", "pi-disciple"), { recursive: true });
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = ambientDir;
const { default: piSubagent, applyDelegationSection, applyToolPromptDeclaration, prepareRoleArgs } = await import("../index.ts");

interface RegisteredTool {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: TSchema;
	prepareArguments?: (args: unknown) => Record<string, unknown>;
	prepareLoadout?: () => { descriptions?: Record<string, string> } | undefined;
	executionMode?: string;
}

function register(over: Record<string, unknown> = {}): { tool: RegisteredTool; handlers: Map<string, Array<(event: any, ctx: any) => Promise<unknown>>> } {
	let tool: RegisteredTool | undefined;	const { stub, handlers } = registerStub({
		registerTool: (definition: RegisteredTool) => (tool = definition),
		...over,
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

function configDir(config: Record<string, unknown>): string {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-sub-reg-"));
	mkdirSync(join(agentDir, "extensions", "pi-disciple"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "pi-disciple", "config.json"), JSON.stringify(config), "utf8");
	agentDirs.push(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir; // the handler calls loadSubagentLimits() without an explicit dir
	return agentDir;
}

/** The prompt options this suite hands the handler: the delegation section, and the two declaration channels. */
interface PromptOptionsFixture {
	sections: Record<string, string>;
	toolSnippets?: Record<string, string>;
	toolGuidelines?: Record<string, string[]>;
}

const promptOptions = (): PromptOptionsFixture => ({ sections: {} });

function withLimits(config: Record<string, unknown>): () => ReturnType<typeof loadSubagentLimits> {
	const agentDir = configDir(config);
	return () => loadSubagentLimits(join(agentDir, "repo"), false, agentDir);
}

afterEach(() => {
	for (const dir of agentDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

afterAll(() => {
	rmSync(ambientDir, { recursive: true, force: true });
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

describe("the declaration from subagent.tool", () => {
	/** The built-in table, as the reader settles it with no config edits. */
	const table = applyRoleConfig(undefined).roles;

	it("lists the roles of the table it was given, so prose cannot drift from the roles that exist", () => {
		const decl = buildToolDeclaration({ roles: table, defaultRole: "explore" });
		expect(decl.description).toContain("explore = Read-only survey of a code base or system");
		expect(decl.description).toContain("review = Critique of existing code, plans or diffs");
		expect(decl.promptGuidelines.join(" ")).toContain("explore, general-purpose, review");
		expect(decl.promptGuidelines.join(" ")).toContain("an unnamed call gets explore");
		// The parameter schema is fixed at load, so it must not name a default the per-run text can contradict.
		expect(decl.roleParameterDescription).toContain("one of explore, general-purpose, review");
		expect(decl.roleParameterDescription).toContain("the configured default role");
		expect(decl.roleParameterDescription).not.toContain("Read-only survey"); // meanings live in the description
		expect(decl.roleParameterDescription).toContain("subagent.roles");
	});

	it("names a role the config added even when it wrote no description for it", () => {
		// `description` is optional in `subagent.roles`, and a callable role absent from the prose is how a model
		// ends up never using it — the hole the removed `extraRoleHint()` used to plug by listing names.
		const roles = applyRoleConfig({ auditor: { tools: ["read"] } }).roles;
		const decl = buildToolDeclaration({ roles, defaultRole: "general-purpose" });
		expect(decl.description).toContain(", auditor"); // named on its own, since it has no description to name
		expect(decl.roleParameterDescription).toContain("auditor");
	});

	it("shows a role the config added, with no code change", () => {
		// The whole point of moving the strings out of `index.ts`: one config block adds a role that the model is
		// told about, in the description, in the rules bullets and in the parameter list.
		const roles = applyRoleConfig({ auditor: { tools: ["read"], description: "Compliance read-through" } }).roles;
		const decl = buildToolDeclaration({ roles, defaultRole: "auditor" });
		expect(decl.description).toContain("auditor = Compliance read-through");
		expect(decl.promptGuidelines.join(" ")).toContain("auditor");
		expect(decl.roleParameterDescription).toContain("auditor");
	});

	it("bounds the role list, and says what it left out", () => {
		const config = Object.fromEntries(Array.from({ length: MAX_LISTED_ROLES }, (_unused, i) => [`role_${i}`, { tools: ["read"], description: `Role number ${i}` }]));
		const roles = applyRoleConfig(config).roles;
		const names = Object.keys(roles);
		const text = expandToolTokens("{{roles}}", { roles, defaultRole: "general-purpose" });
		expect(names.length).toBeGreaterThan(MAX_LISTED_ROLES);
		expect(text).toContain(`and ${names.length - MAX_LISTED_ROLES} more role(s) in subagent.roles`);
		for (const name of names.slice(MAX_LISTED_ROLES)) expect(text).not.toContain(`${name} = `);
		// The slots the built-ins did not take are the ones described; the rest are refused a slot, not a name.
		expect(text.match(/Role number \d+/g)?.length).toBe(MAX_LISTED_ROLES - ROLE_ORDER.length);
		expect(expandToolTokens("{{roleNames}}", { roles, defaultRole: "general-purpose" })).toContain(`and ${names.length - MAX_LISTED_ROLES} more`);
	});

	it("takes the shipped text where the config wrote nothing, and its text where it wrote", () => {
		const tokens = { roles: table, defaultRole: "review" };
		const overridden = buildToolDeclaration(tokens, { description: "child session about {{roleNames}}", promptGuidelines: ["one bullet"] });
		expect(overridden.description).toBe("child session about explore, general-purpose, review");
		expect(overridden.promptGuidelines).toEqual(["one bullet"]);
		// A partial block keeps the untouched fields shipped — `subagent.tool` rewords, it does not silence.
		expect(overridden.promptSnippet).toBe(DEFAULT_TOOL_PROMPT.promptSnippet);
	});

	it("refuses an unknown placeholder rather than sending it to the model", () => {
		const agentDir = configDir({ subagent: { tool: { description: "{{role}}" } } });
		const loaded = loadSubagentLimits(join(agentDir, "repo"), false, agentDir);
		expect(loaded.errors.join(" ")).toContain("unknown token");
		expect(loaded.limits.tool).toBeUndefined();
		expect(buildToolDeclaration({ roles: table, defaultRole: "explore" }, loaded.limits.tool).description).toContain("one-shot child session");
	});

	it("flattens a reworded snippet or bullet to the one line pi wants", () => {
		// pi normalizes the registered text (`_normalizePromptSnippet`); the injected text has to normalize itself.
		const decl = buildToolDeclaration({ roles: table, defaultRole: "explore" }, { promptSnippet: "one\n  line", promptGuidelines: ["a\n  bullet"] });
		expect(decl.promptSnippet).toBe("one line");
		expect(decl.promptGuidelines).toEqual(["a bullet"]);
	});

	it("reaches the prompt and the loadout through the handler, not only through registration", async () => {
		// The registered strings are fixed for the process; these two channels are what make a config edit land
		// in a running session.
		const agentDir = configDir({ subagent: { tool: { description: "Custom: {{roleNames}} on {{defaultRole}}", promptSnippet: "custom snippet", promptGuidelines: ["custom bullet"] } } });
		const { tool, handlers } = register();
		const event = { systemPromptOptions: promptOptions() };
		const ctx = { cwd: join(agentDir, "repo"), isProjectTrusted: () => false, ui: { notify: () => undefined } };
		for (const handler of handlers.get("before_agent_start") ?? []) await handler(event, ctx);
		expect(event.systemPromptOptions.toolSnippets?.subagent).toBe("custom snippet");
		expect(event.systemPromptOptions.toolGuidelines?.subagent).toEqual(["custom bullet"]);
		expect(tool.prepareLoadout?.()).toEqual({ descriptions: { subagent: `Custom: explore, general-purpose, review on ${DEFAULT_LIMITS.defaultRole}` } });
	});

	it("lists a config-added role in the live channels of a running session", async () => {
		// End to end: the human writes a role, the next run describes it. Nothing in this file was edited.
		const agentDir = configDir({ subagent: { roles: { auditor: { tools: ["read"], description: "Compliance read-through" } } } });
		const { tool, handlers } = register();
		const event = { systemPromptOptions: promptOptions() };
		const ctx = { cwd: join(agentDir, "repo"), isProjectTrusted: () => false, ui: { notify: () => undefined } };
		for (const handler of handlers.get("before_agent_start") ?? []) await handler(event, ctx);
		expect(tool.prepareLoadout?.()?.descriptions?.subagent).toContain("auditor = Compliance read-through");
		expect((event.systemPromptOptions.toolGuidelines?.subagent ?? []).join(" ")).toContain("auditor");
		// The registered parameter schema cannot follow: it is fixed for the process, which is why the same list
		// rides in the description.
		expect(JSON.stringify(tool.parameters)).not.toContain("auditor");
	});

	it("keeps the shipped snippet and bullets when the options carry none", () => {
		const options = {
			sections: {} as Record<string, string>,
			toolSnippets: { read: "read a file" } as Record<string, string>,
			toolGuidelines: { bash: ["a rule"] } as Record<string, string[]>,
		};
		applyToolPromptDeclaration(options, buildToolDeclaration({ roles: table, defaultRole: "explore" }));
		expect(options.toolSnippets?.subagent).toContain("isolated child session");
		expect(options.toolGuidelines?.subagent?.length).toBe(3);
		// The prompt options are shared with every other tool: writing ours may not erase theirs.
		expect(options.toolSnippets?.read).toBe("read a file");
		expect(options.toolGuidelines?.bash).toEqual(["a rule"]);
	});

	it("refreshes the declaration before it touches the active tools", async () => {
		// `setActiveTools` is what makes pi call `prepareLoadout`, so a description rebuilt after it would arrive one
		// request late — the ordering the holder exists to make unnecessary.
		const agentDir = configDir({ subagent: { tool: { description: "Fresh: {{defaultRole}}" } } });
		let seen = "(never asked)";
		let tool: RegisteredTool | undefined;
		const { stub, handlers } = registerStub({
			registerTool: (definition: RegisteredTool) => (tool = definition),
			// A set the tool is missing from, so the handler takes its "switch it on" branch.
			getActiveTools: () => ["read", "bash"],
			setActiveTools: () => (seen = tool?.prepareLoadout?.()?.descriptions?.subagent ?? "(empty)"),
		});
		piSubagent(stub as unknown as ExtensionAPI);
		const event = { systemPromptOptions: promptOptions() };
		const ctx = { cwd: join(agentDir, "repo"), isProjectTrusted: () => false, ui: { notify: () => undefined } };
		for (const handler of handlers.get("before_agent_start") ?? []) await handler(event, ctx);
		expect(seen).toBe(`Fresh: ${DEFAULT_LIMITS.defaultRole}`);
	});
});

describe("the file that ships beside the code", () => {
	it("spells the tool text out, and says exactly what the code falls back on", () => {
		// `config.json` now carries the declaration so it can be reworded there rather than in code — which is only
		// honest while the file says what `tool-declaration.ts` would have said anyway. The same guard the shipped role
		// table is held to in `pi-gate/__tests__/schema.test.ts`, on the other half of the section.
		const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../../config.json", import.meta.url)), "utf8"));
		const written = raw.subagent.tool;
		expect(Object.keys(written).sort()).toEqual(["description", "promptGuidelines", "promptSnippet"]);
		expect(written.description).toBe(DEFAULT_TOOL_PROMPT.description);
		expect(written.promptSnippet).toBe(DEFAULT_TOOL_PROMPT.promptSnippet);
		expect(written.promptGuidelines).toEqual(DEFAULT_TOOL_PROMPT.promptGuidelines);
		// And every placeholder the file uses is one the renderer answers to.
		const decl = buildToolDeclaration({ roles: applyRoleConfig(undefined).roles, defaultRole: "general-purpose" }, written);
		expect(decl.description).not.toMatch(/\{\{/);
		expect(decl.promptGuidelines.join(" ")).not.toMatch(/\{\{/);
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

	it("merges a reword across the two config files, per key, and says which file said what", () => {
		const agentDir = configDir({ subagent: { tool: { description: "from the global file", promptSnippet: "global snippet" } } });
		const cwd = join(agentDir, "repo");
		const projectFile = join(cwd, CONFIG_DIR_NAME, "extensions", "pi-disciple", "config.json");
		mkdirSync(join(projectFile, ".."), { recursive: true });
		writeFileSync(projectFile, JSON.stringify({ subagent: { tool: { promptSnippet: "project snippet" } } }), "utf8");
		const loaded = loadSubagentLimits(cwd, true, agentDir);
		expect(loaded.errors).toEqual([]);
		// The project file reworded one string; it did not take the global description with it.
		expect(loaded.limits.tool).toEqual({ description: "from the global file", promptSnippet: "project snippet" });
		expect(loaded.toolOrigins.description).not.toBe(loaded.toolOrigins.promptSnippet);
		expect(loaded.toolOrigins.promptSnippet).toBe(projectFile);
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
