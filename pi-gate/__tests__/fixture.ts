import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Fixture {
	root: string;
	agentDir: string;
	cwd: string;
	cleanup: () => void;
}

/**
 * A temp `PI_CODING_AGENT_DIR` + temp project dir, so the gate's real file resolution
 * (`<agentDir>/extensions/pi-gate/config.json`, `<cwd>/.pi/extensions/pi-gate/config.json`) is
 * exercised instead of mocked.
 */
export function makeFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pi-gate-test-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(agentDir, "extensions", "pi-gate"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return {
		root,
		agentDir,
		cwd,
		cleanup: () => {
			delete process.env.PI_CODING_AGENT_DIR;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export function writeGlobalConfig(fixture: Fixture, document: unknown): string {
	const file = join(fixture.agentDir, "extensions", "pi-gate", "config.json");
	mkdirSync(join(fixture.agentDir, "extensions", "pi-gate"), { recursive: true });
	writeFileSync(file, typeof document === "string" ? document : `${JSON.stringify(document, null, 2)}\n`, "utf8");
	return file;
}

export function writeProjectConfig(fixture: Fixture, document: unknown): string {
	const file = join(fixture.cwd, ".pi", "extensions", "pi-gate", "config.json");
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, typeof document === "string" ? document : `${JSON.stringify(document, null, 2)}\n`, "utf8");
	return file;
}

export function readJson(file: string): unknown {
	return JSON.parse(readFileSync(file, "utf8"));
}

export function readText(file: string): string {
	return readFileSync(file, "utf8");
}

export function gateDoc(permission: unknown): { gate: Record<string, unknown> } {
	return { gate: { enabled: true, reviewLog: false, promptTimeoutMs: 0, permission } };
}
