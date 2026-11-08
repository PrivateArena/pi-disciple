import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATE_CONFIG, DEFAULT_SUBAGENT_LIMITS, flattenPermission, parseGateConfig, parseSubagentConfig, ROLE_TURNS_CEILING } from "../schema.ts";
import { applyRoleConfig, ROLES } from "../../pi-subagent/roles.ts";

describe("parseGateConfig", () => {
	it("parses the shipped document", () => {
		const parsed = parseGateConfig({ gate: { enabled: true, reviewLog: true, promptTimeoutMs: 30_000, permission: { "*": "allow", bash: { "*": "ask" } } } }, "test");
		expect(parsed.errors).toEqual([]);
		expect(parsed.config).toEqual({ enabled: true, reviewLog: true, promptTimeoutMs: 30_000, permission: { "*": "allow", bash: { "*": "ask" } } });
		expect(parsed.entries).toEqual([
			{ surface: "*", pattern: "*", action: "allow" },
			{ surface: "bash", pattern: "*", action: "ask" },
		]);
	});

	it("records an error and contributes no rule for a malformed surface", () => {
		const parsed = parseGateConfig({ gate: { permission: { bash: 42, read: { "*": "maybe" }, ls: "allow" } } }, "test");
		expect(parsed.entries).toEqual([{ surface: "ls", pattern: "*", action: "allow" }]);
		expect(parsed.errors).toHaveLength(2);
	});

	it("keeps pattern order, which is the rule precedence", () => {
		const parsed = parseGateConfig({ gate: { permission: { bash: { "*": "ask", "git *": "allow", "git push *": "deny" } } } }, "test");
		expect(parsed.entries.map((entry) => entry.pattern)).toEqual(["*", "git *", "git push *"]);
	});

	it("reports malformed grants instead of dropping the whole policy", () => {
		const parsed = parseGateConfig({ gate: { permission: { bash: "ask" }, grants: { global: [{ surface: "bash", pattern: "ls", action: "yes" }, { surface: "bash", pattern: "go *" }] } } }, "test");
		expect(parsed.grants.global).toEqual([]);
		expect(parsed.errors).toHaveLength(2);
		expect(parsed.entries).toHaveLength(1);
	});

	it("accepts an empty document", () => {
		expect(parseGateConfig(undefined, "test").errors).toEqual([]);
		expect(parseGateConfig({ nothing: true }, "test").errors).toEqual([]);
	});
});

describe("parseSubagentConfig", () => {
	it("parses positive numbers only", () => {
		const parsed = parseSubagentConfig({ maxTurns: 5, timeoutMinutes: -1, maxResultBytes: 1000.9, keepTranscripts: "20" }, "test");
		expect(parsed.limits).toEqual({ maxTurns: 5, maxResultBytes: 1000 });
		expect(parsed.errors).toHaveLength(2);
	});

	it("parses a model pin and rejects a non-string one", () => {
		expect(parseSubagentConfig({ model: " local/qwen3.8-flash-next " }, "test").limits).toEqual({ model: "local/qwen3.8-flash-next" });
		const bad = parseSubagentConfig({ model: false }, "test");
		expect(bad.limits.model).toBeUndefined();
		expect(bad.errors.join(" ")).toContain("subagent.model");
	});

	it("parses the default role and the delegation prompt switch", () => {
		expect(parseSubagentConfig({ defaultRole: " Explore ", delegationPrompt: false }, "test").limits).toEqual({
			defaultRole: "explore",
			delegationPrompt: false,
		});
		// A word that is a legal role id but names no built-in is kept: `subagent.roles` may define it, and the
		// reader holding the whole table is what refuses it (`pi-subagent/config-file.ts::finish`).
		const configRole = parseSubagentConfig({ defaultRole: "browse", delegationPrompt: "yes" }, "test");
		expect(configRole.limits.defaultRole).toBe("browse");
		expect(configRole.limits.delegationPrompt).toBeUndefined();
		expect(configRole.errors).toHaveLength(1);
		// Punctuation a role id cannot contain is refused here, so it never reaches a table lookup.
		const worse = parseSubagentConfig({ defaultRole: "my role!" }, "test");
		expect(worse.limits.defaultRole).toBeUndefined();
		expect(worse.errors.join(" ")).toContain("defaultRole");
	});

	it("defaults an unnamed call to general-purpose and delegates the prompt decision to config", () => {
		// general-purpose is the parent's own tool set, so a role the model forgot adds no permission.
		expect(DEFAULT_SUBAGENT_LIMITS.defaultRole).toBe("general-purpose");
		expect(DEFAULT_SUBAGENT_LIMITS.delegationPrompt).toBe(true);
	});

	it("parses the ceiling-extension switch, and refuses a non-boolean", () => {
		// Asking is the default: the budgets are guesses, and a human watching is the one who knows.
		expect(DEFAULT_SUBAGENT_LIMITS.askToExtend).toBe(true);
		expect(parseSubagentConfig({ askToExtend: false }, "test").limits.askToExtend).toBe(false);
		const junk = parseSubagentConfig({ askToExtend: "yes" }, "test");
		expect(junk.limits.askToExtend).toBeUndefined();
		expect(junk.errors.join(" ")).toContain("subagent.askToExtend must be a boolean");
	});
});

describe("subagent.roles", () => {
	it("keeps an entry that is a usable partial edit", () => {
		const parsed = parseSubagentConfig({ roles: { explore: { maxTurns: 8.7, description: " Survey " } } }, "test");
		expect(parsed.errors).toEqual([]);
		expect(parsed.limits.roles).toEqual({ explore: { maxTurns: 8, description: "Survey" } });
	});

	it("reports a malformed entry without losing the entries beside it", () => {
		const parsed = parseSubagentConfig(
			{
				roles: {
					"Good Role": { tools: ["read"] },
					bad: "nope",
					only: { maxTurns: ROLE_TURNS_CEILING + 1, timeoutMinutes: 3, prompt: "   " },
					ok: { tools: ["read", " grep "] },
				},
			},
			"test",
		);
		expect(parsed.limits.roles).toEqual({ only: { timeoutMinutes: 3 }, ok: { tools: ["read", "grep"] } });
		const text = parsed.errors.join(" | ");
		expect(text).toContain(`subagent.roles key "Good Role" must match`);
		expect(text).toContain("roles.bad must be an object");
		expect(text).toContain(`maxTurns must be a number in 1..${ROLE_TURNS_CEILING}`);
		expect(text).toContain("roles.only.prompt must be a non-empty string");
	});

	it("refuses two ids a role lookup could not tell apart", () => {
		const parsed = parseSubagentConfig({ roles: { my_role: { tools: ["read"] }, "my-role": { tools: ["read"] } } }, "test");
		expect(Object.keys(parsed.limits.roles ?? {})).toEqual(["my_role"]);
		expect(parsed.errors.join(" ")).toContain("collides with");
	});

	it("refuses the whole section when it is not an object", () => {
		const parsed = parseSubagentConfig({ roles: ["explore"] }, "test");
		expect(parsed.limits.roles).toBeUndefined();
		expect(parsed.errors.join(" ")).toContain("subagent.roles must be an object");
	});

	it("reads a role's sampling params and thinking level", () => {
		// Values are the server's vocabulary, not pi's, so they pass through untouched — including the
		// structured ones a Qwen-style endpoint wants.
		const parsed = parseSubagentConfig(
			{
				roles: {
					explore: {
						thinkingLevel: " Off ",
						sampling: { temperature: 0.2, top_p: 0.9, top_k: 20, min_p: 0, do_sample: true, repetition_penalty: 1.05, chat_template_kwargs: { use_audio: false } },
						samplingByThinkingLevel: { xhigh: { temperature: 0.6 }, off: { temperature: 1 } },
					},
				},
			},
			"test",
		);
		expect(parsed.errors).toEqual([]);
		expect(parsed.limits.roles).toEqual({
			explore: {
				thinkingLevel: "off",
				sampling: { temperature: 0.2, top_p: 0.9, top_k: 20, min_p: 0, do_sample: true, repetition_penalty: 1.05, chat_template_kwargs: { use_audio: false } },
				samplingByThinkingLevel: { xhigh: { temperature: 0.6 }, off: { temperature: 1 } },
			},
		});
	});

	it("refuses the sampling shapes that could never reach a server, key by key", () => {
		const parsed = parseSubagentConfig(
			{
				roles: {
					explore: { thinkingLevel: "hig", sampling: ["temperature"], samplingByThinkingLevel: { hig: { temperature: 0 } } },
					deep: { tools: ["read"], sampling: { "top k": 20, temperature: Number.NaN, top_p: 0.9 } },
					proto: { tools: ["read"], sampling: { ["__proto__"]: 1, constructor: 2, top_k: 5 } },
				},
			},
			"test",
		);
		const text = parsed.errors.join(" | ");
		expect(text).toContain("roles.explore.thinkingLevel must be one of off, minimal, low, medium, high, xhigh, max");
		expect(text).toContain("roles.explore.sampling must be an object of request-body params");
		expect(text).toContain(`samplingByThinkingLevel key "hig" is not a thinking level`);
		expect(text).toContain(`sampling key "top k" is not a request-body field name`);
		expect(text).toContain("sampling.temperature must be a finite number");
		// A bag key that is really a prototype write would vanish from the body and pollute the object instead.
		expect(text).toContain(`sampling key "__proto__" is not a request-body field name`);
		expect(text).toContain(`sampling key "constructor" is not a request-body field name`);
		// The refusals cost only themselves: the one usable key survives.
		expect(parsed.limits.roles?.deep).toEqual({ tools: ["read"], sampling: { top_p: 0.9 } });
		expect(parsed.limits.roles?.proto).toEqual({ tools: ["read"], sampling: { top_k: 5 } });
		expect(parsed.limits.roles?.explore).toEqual({});
	});
});

describe("subagent.model", () => {
	it("treats an inherit word as no pin, which is what lets the shipped file show the key", () => {
		for (const word of ["inherit", "INHERIT", "session", "parent", "default", "inherited"]) {
			const parsed = parseSubagentConfig({ model: word }, "test");
			expect(parsed.errors).toEqual([]);
			expect(parsed.limits.model).toBeUndefined();
		}
		expect(parseSubagentConfig({ model: "kilo/kilo-auto/free" }, "test").limits.model).toBe("kilo/kilo-auto/free");
		const bad = parseSubagentConfig({ model: 7 }, "test");
		expect(bad.limits.model).toBeUndefined();
		expect(bad.errors.join(" ")).toContain("subagent.model");
	});
});

/**
 * The shipped file documents the keys it does not set as `"==key": <example>` — inert to both parsers, and
 * the assertions below are about the live configuration, so the documentation keys come back out first.
 */
function stripDocs<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => stripDocs(item)) as unknown as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) if (!key.startsWith("==")) out[key] = stripDocs(item);
		return out as T;
	}
	return value;
}

describe("defaults", () => {
	it("matches the shipped config.json, whose placeholders change nothing", () => {
		const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../../config.json", import.meta.url)), "utf8"));
		const shipped = stripDocs(raw);
		expect(shipped.gate.permission).toEqual(DEFAULT_GATE_CONFIG.permission);
		expect(shipped.gate.enabled).toBe(DEFAULT_GATE_CONFIG.enabled);
		expect(shipped.gate.reviewLog).toBe(DEFAULT_GATE_CONFIG.reviewLog);
		expect(shipped.gate.promptTimeoutMs).toBe(DEFAULT_GATE_CONFIG.promptTimeoutMs);
		expect(shipped.gate.grants).toEqual({ global: [], project: [] });

		// Reading the file as shipped must be silent and must yield exactly the rules of the stripped document:
		// a documentation key that produced an error (degraded config, floor on every call) or a live rule would
		// turn the file's own comments into behaviour.
		const rawGate = parseGateConfig(raw, "shipped config.json");
		expect(rawGate.errors).toEqual([]);
		expect(rawGate.entries.filter((entry) => !entry.surface.startsWith("=="))).toEqual(flattenPermission(DEFAULT_GATE_CONFIG.permission));
		const rawLimits = parseSubagentConfig(raw.subagent, "shipped config.json");
		expect(rawLimits.errors).toEqual([]);

		// Every configurable `subagent` key is spelled out, so the block is the defaults plus the shipped file's
		// own stated choices — and nothing else. "model": "inherit" is an explicit no-pin, so it is not one.
		// The two real choices: an unnamed delegation runs the read-only role, and the role budgets are written
		// out under the ceiling so the arithmetic is visible instead of implicit.
		const parsed = parseSubagentConfig(shipped.subagent, "shipped config.json");
		expect(rawLimits.limits).toEqual(parsed.limits);
		expect(parsed.errors).toEqual([]);
		expect(parsed.limits).toEqual({ ...DEFAULT_SUBAGENT_LIMITS, defaultRole: "explore", roles: shipped.subagent.roles });
		// The written role table re-states the three built-ins in full and adds nothing: no new role, no new tool,
		// no rewritten prompt, no sampling bag. A shipped file that added privilege or retuned a request would fail
		// here, not in a running session.
		const effective = applyRoleConfig(parsed.limits.roles).roles;
		expect(Object.keys(effective).sort()).toEqual(["explore", "general-purpose", "review"]);
		for (const name of ["explore", "general-purpose", "review"] as const) {
			expect(effective[name].allowTools, name).toEqual(ROLES[name].allowTools);
			expect(effective[name].description, name).toBe(ROLES[name].description);
			expect(effective[name].prompt, name).toBe(ROLES[name].prompt);
			expect(effective[name].maxTurns, name).toBeGreaterThanOrEqual(ROLES[name].maxTurns);
			expect(effective[name].timeoutMinutes, name).toBe(ROLES[name].timeoutMinutes);
			// The entries are templates, so they spell out every built-in field the file could tighten — but only
			// budgets differ from `roles.ts`, and nothing ships a request-body retune.
			const written = shipped.subagent.roles[name];
			expect(Object.keys(written).sort(), name).toEqual(["description", "maxTurns", "prompt", "timeoutMinutes", "tools"]);
			expect(written.tools, name).toEqual(ROLES[name].allowTools);
			expect(written.description, name).toBe(ROLES[name].description);
			expect(written.prompt, name).toBe(ROLES[name].prompt);
			expect(parsed.limits.roles?.[name]?.sampling, name).toBeUndefined();
			expect(parsed.limits.roles?.[name]?.samplingByThinkingLevel, name).toBeUndefined();
			expect(parsed.limits.roles?.[name]?.thinkingLevel, name).toBeUndefined();
			expect(effective[name].sampling, name).toBeUndefined();
			expect(effective[name].samplingByThinkingLevel, name).toBeUndefined();
			expect(effective[name].thinkingLevel, name).toBeUndefined();
			// Every sampling bag the file suggests for this role is a documentation key: a suggestion that reached a
			// real key would change what children send, which is exactly what these strings let a human decide.
			const docs = Object.keys(raw.subagent.roles[name]).filter((key) => key.startsWith("=="));
			expect(docs.join(" "), name).toContain("sampling");
		}
	});

	it("asks for bash by default and allows the read-only tools", () => {
		expect(flattenPermission(DEFAULT_GATE_CONFIG.permission)).toContainEqual({ surface: "bash", pattern: "*", action: "ask" });
		expect(DEFAULT_GATE_CONFIG.permission.read).toBe("allow");
		expect(DEFAULT_GATE_CONFIG.permission["*"]).toBe("ask");
	});
});

describe("documentation keys are never config", () => {
	it("skips `==` keys inside subagent.roles, so a note in the role table is never a config error", () => {
		// An error means a degraded config, which floors every call in the session: an unread note may not do that.
		const parsed = parseSubagentConfig({ roles: { "==template": { tools: ["read"] }, explore: { maxTurns: 8 } } }, "test");
		expect(parsed.errors).toEqual([]);
		expect(Object.keys(parsed.limits.roles ?? {})).toEqual(["explore"]);
		// Same inside an entry: documentation beside the live fields.
		const inEntry = parseSubagentConfig({ roles: { r: { tools: ["read"], "==sampling": "{ temperature: 0.2 }" } } }, "test");
		expect(inEntry.errors).toEqual([]);
		expect(inEntry.limits.roles).toEqual({ r: { tools: ["read"] } });
		// A name that is neither a role nor a doc key is still refused.
		expect(parseSubagentConfig({ roles: { "Bad Name": { tools: ["read"] } } }, "test").errors).toHaveLength(1);
	});

	it("skips `==` surfaces in the permission map, so they create no rules", () => {
		const parsed = parseGateConfig({ gate: { permission: { "*": "ask", "==powershell": { "*": "ask" }, bash: "ask" } } }, "t");
		expect(parsed.entries.map((entry) => entry.surface)).toEqual(["*", "bash"]);
		expect(flattenPermission(DEFAULT_GATE_CONFIG.permission).every((entry) => !entry.surface.startsWith("=="))).toBe(true);
	});
});
