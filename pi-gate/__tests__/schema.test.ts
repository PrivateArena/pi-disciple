import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATE_CONFIG, DEFAULT_SUBAGENT_LIMITS, flattenPermission, parseGateConfig, parseSubagentConfig } from "../schema.ts";

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
});

describe("defaults", () => {
	it("matches the shipped config.json exactly", () => {
		const shipped = JSON.parse(readFileSync(fileURLToPath(new URL("../config.json", import.meta.url)), "utf8"));
		expect(shipped.gate.permission).toEqual(DEFAULT_GATE_CONFIG.permission);
		expect(shipped.gate.enabled).toBe(DEFAULT_GATE_CONFIG.enabled);
		expect(shipped.gate.reviewLog).toBe(DEFAULT_GATE_CONFIG.reviewLog);
		expect(shipped.gate.promptTimeoutMs).toBe(DEFAULT_GATE_CONFIG.promptTimeoutMs);
		expect(shipped.subagent).toEqual(DEFAULT_SUBAGENT_LIMITS);
	});

	it("asks for bash by default and allows the read-only tools", () => {
		expect(flattenPermission(DEFAULT_GATE_CONFIG.permission)).toContainEqual({ surface: "bash", pattern: "*", action: "ask" });
		expect(DEFAULT_GATE_CONFIG.permission.read).toBe("allow");
		expect(DEFAULT_GATE_CONFIG.permission["*"]).toBe("ask");
	});
});
