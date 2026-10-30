/**
 * The two readers of one file (plan step 20's deliberate duplication).
 *
 * `pi-gate/schema.ts::parseSubagentConfig` is the pure parser pi-gate uses; `pi-subagent/config-file.ts`
 * re-implements the same rules so the subagent still loads its limits with `pi-gate` deleted. Duplication is
 * only acceptable while they agree, so every rule the config can trip is fed to both here: the same accept,
 * the same clamp, the same error wording.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseSubagentConfig } from "../../pi-gate/schema.ts";
import { ROLES } from "../roles.ts";
import { DEFAULT_LIMITS, loadSubagentLimits, MODEL_INHERIT_WORDS, ROLE_ID_PATTERN, ROLE_TIMEOUT_CEILING_MINUTES, ROLE_TURNS_CEILING } from "../config-file.ts";

const dirs: string[] = [];

/** One agent dir holding `config`, read by both readers. */
function document(config: Record<string, unknown>): { cwd: string; agentDir: string; file: string } {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-sub-parity-"));
	mkdirSync(join(agentDir, "extensions", "pi-gate"), { recursive: true });
	const file = join(agentDir, "extensions", "pi-gate", "config.json");
	writeFileSync(file, JSON.stringify({ subagent: config }), "utf8");
	dirs.push(agentDir);
	return { cwd: join(agentDir, "repo"), agentDir, file };
}

afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The reader's per-file prefix stripped, so the two error lists are comparable. */
function stripFile(error: string, file: string): string {
	return error.replace(`${file}: `, "").replace("subagent.roles: ", "");
}

const CASES: [label: string, config: Record<string, unknown>][] = [
	["empty", {}],
	["numbers", { maxTurns: 4.9, timeoutMinutes: 0, maxResultBytes: -1, keepTranscripts: "20" }],
	["inherit words", { model: "inherit" }],
	["a real pin", { model: " kilo/kilo-auto/free " }],
	["a junk pin", { model: 7 }],
	["an unusable pin", { model: "/no-lead" }],
	["a built-in default role", { defaultRole: "GP" }],
	["a not-a-role word", { defaultRole: "my role!" }],
	["a partial role edit", { roles: { explore: { maxTurns: 6, description: " Survey ", prompt: "" } } }],
	["role id rules", { roles: { "Bad Name": { tools: ["read"] }, ok_role: { tools: [" read ", "subagent"] }, dupe: 3 } }],
	["role ceilings", { roles: { r: { maxTurns: ROLE_TURNS_CEILING + 5, timeoutMinutes: ROLE_TIMEOUT_CEILING_MINUTES + 1 } } }],
	["roles not an object", { roles: ["explore"] }],
	["everything at once", { enabled: false, delegationPrompt: false, maxTurns: 2, model: "session", roles: { auditor: { tools: ["read"], maxTurns: 3 } } }],
	["a non-boolean ceiling switch", { askToExtend: "yes" }],
];

describe("the shipped duplication stays honest", () => {
	for (const [label, config] of CASES) {
		it(`agrees on ${label}`, () => {
			const pure = parseSubagentConfig(config, "test");
			const where = document(config);
			const file = loadSubagentLimits(where.cwd, false, where.agentDir);
			// Same accepted values, key for key.
			for (const key of ["enabled", "delegationPrompt", "askToExtend", "maxTurns", "timeoutMinutes", "maxResultBytes", "keepTranscripts", "model", "roles", "defaultRole"] as const) {
				if (pure.limits[key] === undefined) continue;
				expect(file.limits[key], key).toEqual(pure.limits[key]);
			}
			// Same refusals, in the same words. Only the shape rules are shared: the reader additionally settles
			// `defaultRole` and the forbidden tools against the table it built, which the pure parser has no.
			const shared = (error: string) =>
				!error.includes("defaultRole") && !error.includes("names no role") && !error.includes("a child may never reach") && !error.includes("names a new role");
			const readerErrors = file.errors.map((error) => stripFile(error, where.file)).filter(shared);
			const parserErrors = pure.errors.map((error) => error.replace("test: ", "")).filter(shared);
			for (const error of parserErrors) expect(readerErrors.join(" | "), error).toContain(error);
			for (const error of readerErrors) expect(parserErrors.join(" | "), error).toContain(error);
		});
	}

	it("ships the ceiling switch on, in both readers", () => {
		// The dialog is the feature's whole value; a default that quietly turned it off would not be reported.
		expect(DEFAULT_LIMITS.askToExtend).toBe(true);
		const where = document({});
		expect(loadSubagentLimits(where.cwd, false, where.agentDir).limits.askToExtend).toBe(true);
		// The pure parser returns a partial: the caller owns the default, and both agree it is on.
		expect(parseSubagentConfig({}, "test").limits.askToExtend).toBeUndefined();
	});

	it("mirrors the vocabulary constants", () => {
		expect(ROLE_ID_PATTERN.test("general-purpose")).toBe(true);
		expect(ROLE_ID_PATTERN.test("Good Role")).toBe(false);
		expect(MODEL_INHERIT_WORDS).toContain("inherit");
	});
});

describe("subagent.roles in the file", () => {
	it("makes a new role callable and shows it in the effective table", () => {
		const where = document({ roles: { auditor: { tools: ["read", "grep"], description: "Compliance read-through", maxTurns: 4 } } });
		const loaded = loadSubagentLimits(where.cwd, false, where.agentDir);
		expect(loaded.errors).toEqual([]);
		expect(loaded.effectiveRoles.auditor).toMatchObject({ allowTools: ["read", "grep"], maxTurns: 4, description: "Compliance read-through" });
		expect(loaded.roleOrigins.auditor).toBe(where.file);
		expect(loaded.effectiveRoles.explore?.allowTools).toEqual(ROLES.explore.allowTools);
	});

	it("accepts a default role that only the config defines, and refuses one nothing defines", () => {
		const good = document({ defaultRole: "auditor", roles: { auditor: { tools: ["read"] } } });
		const loaded = loadSubagentLimits(good.cwd, false, good.agentDir);
		expect(loaded.errors).toEqual([]);
		expect(loaded.limits.defaultRole).toBe("auditor");

		const bad = document({ defaultRole: "auditor" });
		const refused = loadSubagentLimits(bad.cwd, false, bad.agentDir);
		expect(refused.limits.defaultRole).toBe(DEFAULT_LIMITS.defaultRole);
		expect(refused.errors.join(" ")).toContain('subagent.defaultRole "auditor" names no role');
	});

	it("merges the project file over the global one per role and per field", () => {
		const where = document({ roles: { auditor: { tools: ["read"], maxTurns: 4 }, explore: { maxTurns: 9 } } });
		mkdirSync(join(where.cwd, ".pi", "extensions", "pi-gate"), { recursive: true });
		writeFileSync(
			join(where.cwd, ".pi", "extensions", "pi-gate", "config.json"),
			JSON.stringify({ subagent: { roles: { auditor: { maxTurns: 7 }, explorer: { tools: ["ls"] } } } }),
			"utf8",
		);
		const merged = loadSubagentLimits(where.cwd, true, where.agentDir);
		expect(merged.errors).toEqual([]);
		expect(merged.effectiveRoles.auditor).toMatchObject({ allowTools: ["read"], maxTurns: 7 });
		expect(merged.effectiveRoles.explore.maxTurns).toBe(9);
		expect(Object.keys(merged.effectiveRoles)).toEqual(["explore", "general-purpose", "review", "auditor", "explorer"]);
	});

	it("an inherit word clears a pin the other file set", () => {
		const where = document({ model: "kilo/kilo-auto/free" });
		mkdirSync(join(where.cwd, ".pi", "extensions", "pi-gate"), { recursive: true });
		writeFileSync(join(where.cwd, ".pi", "extensions", "pi-gate", "config.json"), JSON.stringify({ subagent: { model: "inherit" } }), "utf8");
		const loaded = loadSubagentLimits(where.cwd, true, where.agentDir);
		expect(loaded.errors).toEqual([]);
		expect(loaded.limits.model).toBeUndefined();
		expect(loaded.origins.model).toBeUndefined();
	});
});
