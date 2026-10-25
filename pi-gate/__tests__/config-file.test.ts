import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalConfigFile, getProjectConfigFile, readConfigFile, writeDefaultConfig } from "../config-file.ts";

function dir(): string {
	return mkdtempSync(join(tmpdir(), "pi-gate-cfg-"));
}

describe("config file locations", () => {
	it("puts the global file under the agent dir", () => {
		expect(getGlobalConfigFile("/agent")).toBe(join("/agent", "extensions", "pi-gate", "config.json"));
	});

	it("puts the project file under .pi", () => {
		expect(getProjectConfigFile("/w")).toBe(join("/w", ".pi", "extensions", "pi-gate", "config.json"));
	});
});

describe("readConfigFile", () => {
	it("reports a missing file without throwing", () => {
		const read = readConfigFile(join(dir(), "nope.json"));
		expect(read.json).toBeUndefined();
		expect(read.error).toMatch(/does not exist/);
	});

	it("tolerates hand-written comments and says so", () => {
		const file = join(dir(), "c.json");
		writeFileSync(file, '{ "gate": { "enabled": true } } // mine\n', "utf8");
		const read = readConfigFile(file);
		expect(read.json).toMatchObject({ gate: { enabled: true } });
		expect(read.error).toMatch(/comments were stripped/);
	});

	it("keeps mtime for the reload stamp", () => {
		const file = join(dir(), "c.json");
		writeFileSync(file, "{}", "utf8");
		expect(readConfigFile(file).mtimeMs).toBeGreaterThan(0);
	});
});

describe("writeDefaultConfig", () => {
	it("seeds a missing file and leaves an existing one alone", () => {
		const root = dir();
		const missing = join(root, "extensions", "pi-gate", "config.json");
		expect(writeDefaultConfig(missing, '{"gate":{}}').created).toBe(true);
		expect(readFileSync(missing, "utf8")).toContain(String.raw`{"gate":{}}`);

		writeFileSync(missing, "human edited", "utf8");
		expect(writeDefaultConfig(missing, '{"gate":{}}')).toMatchObject({ created: false });
		expect(readFileSync(missing, "utf8")).toBe("human edited");
	});

	it("creates the directory chain", () => {
		const file = join(dir(), "deep", "nested", "config.json");
		expect(writeDefaultConfig(file, "{}").created).toBe(true);
	});
});
