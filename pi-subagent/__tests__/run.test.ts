import { afterEach, describe, expect, it } from "vitest";
import { claimGuard, composeResult, currentGuard, formatProgress, releaseGuard, RUN_GUARD_KEY } from "../run.ts";
import type { ChildResult } from "../child.ts";
import { loadSubagentLimits } from "../config-file.ts";
import { DEFAULT_SUBAGENT_LIMITS } from "../../pi-gate/schema.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const child = (overrides: Partial<ChildResult> = {}): ChildResult => ({
	text: "Findings: the gate lives in pi-gate/policy.ts and evaluates rules in order.",
	exit: "done",
	turns: 4,
	toolCalls: 7,
	...overrides,
});

describe("run guard", () => {
	afterEach(() => {
		delete (globalThis as Record<symbol, unknown>)[RUN_GUARD_KEY];
	});

	it("rejects a second concurrent child", () => {
		claimGuard({ callId: "a", role: "explore", startedAt: Date.now(), abort: () => undefined });
		expect(currentGuard()?.callId).toBe("a");
		expect(() => claimGuard({ callId: "b", role: "review", startedAt: Date.now(), abort: () => undefined })).toThrow(/one subagent at a time/);
	});

	it("survives a simulated /reload because it lives on globalThis", () => {
		claimGuard({ callId: "a", role: "explore", startedAt: Date.now(), abort: () => undefined });
		const seenThroughReload = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent.run")];
		expect(seenThroughReload).toBeTruthy();
		releaseGuard("a");
		expect(currentGuard()).toBeUndefined();
	});

	it("releases only its own guard", () => {
		claimGuard({ callId: "a", role: "explore", startedAt: Date.now(), abort: () => undefined });
		releaseGuard("other");
		expect(currentGuard()?.callId).toBe("a");
		releaseGuard("a");
		expect(currentGuard()).toBeUndefined();
	});
});

describe("result mapping", () => {
	it("leads with a status header and keeps the answer head", () => {
		const result = composeResult(child(), "explore", 20_000, 22_000);
		const text = (result.content[0] as { text: string }).text;
		expect(text.startsWith("[subagent explore · DONE · 4 turns · 7 tool calls · 22.0s]")).toBe(true);
		expect(text).toContain("Findings:");
		expect(result.details.truncated).toBe(false);
	});

	it("marks every non-done exit INCOMPLETE", () => {
		const result = composeResult(child({ exit: "timeout", text: "partial" }), "review", 20_000, 1000);
		expect((result.content[0] as { text: string }).text).toMatch(/INCOMPLETE \(timeout\)/);
		expect(result.details.exit).toBe("timeout");
	});

	it("truncates to the configured byte budget and points at the transcript", () => {
		const long = "x".repeat(5000);
		const result = composeResult(child({ text: long }), "explore", 1000, 1000, { childSessionFile: "/tmp/c.jsonl" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("output truncated");
		expect(text).toContain("/tmp/c.jsonl");
		expect(result.details.truncated).toBe(true);
	});

	it("reports an error exit as a tool error", () => {
		const result = composeResult(child({ exit: "error", error: "boom", text: "" }), "explore", 1000, 10);
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("(the subagent returned no text)");
	});

	it("formats the progress line", () => {
		expect(formatProgress({ turns: 4, toolCalls: 7, lastTool: "bash", elapsedMs: 22_000 }, 5)).toBe(
			"subagent running · turn 4 · 7 calls · bash · 22s · 5 tools",
		);
	});
});

describe("limits file", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-sub-cfg-"));
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function fixture(files: Record<string, unknown>) {
		const agentDir = join(root, `agent-${Object.keys(files).length}-${Math.random().toString(36).slice(2)}`);
		for (const [key, document] of Object.entries(files)) {
			const path = key === "global" ? join(agentDir, "extensions/pi-gate/config.json") : join(root, "project", ".pi/extensions/pi-gate/config.json");
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, JSON.stringify(document), "utf8");
		}
		process.env.PI_CODING_AGENT_DIR = agentDir;
		return agentDir;
	}

	it("defaults when no file exists", () => {
		fixture({});
		expect(loadSubagentLimits(root, false).limits).toEqual(DEFAULT_SUBAGENT_LIMITS);
	});

	it("reads the subagent section without needing pi-gate code", () => {
		fixture({ global: { gate: { permission: { "*": "allow" } }, subagent: { maxTurns: 7, keepTranscripts: 3 } } });
		const loaded = loadSubagentLimits(root, false);
		expect(loaded.limits.maxTurns).toBe(7);
		expect(loaded.limits.keepTranscripts).toBe(3);
		expect(loaded.limits.timeoutMinutes).toBe(DEFAULT_SUBAGENT_LIMITS.timeoutMinutes);
	});

	it("lets a trusted project tighten the limits", () => {
		fixture({
			global: { subagent: { maxTurns: 20 } },
			project: { subagent: { maxTurns: 4, timeoutMinutes: 2 } },
		});
		expect(loadSubagentLimits(join(root, "project"), true).limits.maxTurns).toBe(4);
	});
});

describe("enabled switch", () => {
	it("reads subagent.enabled and defaults to on", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-sub-enabled-"));
		mkdirSync(join(root, "extensions", "pi-gate"), { recursive: true });
		mkdirSync(join(root, ".pi", "extensions", "pi-gate"), { recursive: true });
		writeFileSync(join(root, "extensions", "pi-gate", "config.json"), JSON.stringify({ subagent: { enabled: true } }), "utf8");
		writeFileSync(join(root, ".pi", "extensions", "pi-gate", "config.json"), JSON.stringify({ subagent: { enabled: false } }), "utf8");
		expect(loadSubagentLimits(root, false, root).limits.enabled).toBe(true);
		expect(loadSubagentLimits(root, true, root).limits.enabled).toBe(false);
	});

	it("rejects a non-boolean enabled value", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-sub-enabled-"));
		mkdirSync(join(root, "extensions", "pi-gate"), { recursive: true });
		writeFileSync(join(root, "extensions", "pi-gate", "config.json"), JSON.stringify({ subagent: { enabled: "no" } }), "utf8");
		const loaded = loadSubagentLimits(root, false, root);
		expect(loaded.limits.enabled).toBe(true);
		expect(loaded.errors.join(" ")).toMatch(/enabled must be a boolean/);
	});
});
