import { afterEach, describe, expect, it } from "vitest";
import { claimGuard, composeResult, currentGuard, formatProgress, releaseGuard, RUN_GUARD_KEY } from "../run.ts";
import { reportFileFor } from "../child.ts";
import type { ChildResult } from "../child.ts";
import { loadSubagentLimits } from "../config-file.ts";
import { DEFAULT_SUBAGENT_LIMITS } from "../../pi-gate/schema.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

	it("records that the role came from the config and not from the model", () => {
		const result = composeResult(child(), "general-purpose", 20_000, 1000, { roleDefaulted: true, task: "fix the flaky test" });
		expect(result.details.roleDefaulted).toBe(true);
		// A frontend switches on these, so a defaulted call must still look like a normal role.
		expect(result.details.subagentType).toBe("general-purpose");
		expect(result.details.displayName).toBe("General Purpose");
		expect(result.details.status).toBe("completed");
		// The header a non-TUI frontend draws its card title from.
		expect(result.details.pendant.title).toBe("General Purpose");
		expect(result.details.pendant.subtitle).toBe("fix the flaky test");
		// The model needs no lecture about which role it forgot to name.
		expect((result.content[0] as { text: string }).text).not.toMatch(/default/);
		expect(composeResult(child(), "explore", 20_000, 1000).details.roleDefaulted).toBeUndefined();
	});

	it("titles the frontend header with the role and the whole task", () => {
		const result = composeResult(child(), "explore", 20_000, 1000, { task: "# Survey\n\nread pi-gate/ and report the rule layers" });
		expect(result.details.agent).toBe("explore");
		expect(result.details.description).not.toContain("\n");
		expect(result.details.pendant).toEqual({ title: "Explore", subtitle: "Survey read pi-gate/ and report the rule layers" });
		// A call with no task gets a title only: an empty label counts as missing at the frontend.
		expect(composeResult(child(), "explore", 20_000, 1000).details.pendant).toEqual({ title: "Explore" });
	});

	it("never clips the task the human has to audit", () => {
		const task = `Survey every rule layer in the gate.\n\n${"report the exact pattern that matches each fact; ".repeat(30)}`;
		const result = composeResult(child(), "explore", 20_000, 1000, { task });
		expect(result.details.task).toBe(task);
		expect(result.details.description).toBe(task.replace(/\s+/g, " ").trim());
		expect(result.details.pendant.subtitle).toContain("each fact");
		expect(result.details.pendant.subtitle).not.toContain("…");
	});

	it("marks every non-done exit INCOMPLETE", () => {
		const result = composeResult(child({ exit: "timeout", text: "partial" }), "review", 20_000, 1000);
		expect((result.content[0] as { text: string }).text).toMatch(/INCOMPLETE \(timeout\)/);
		expect(result.details.exit).toBe("timeout");
	});

	it("returns the report whole when it fits the byte budget", () => {
		const report = "a\n".repeat(3000); // 6000 bytes over 3000 lines: pi's 2000-line budget must not apply
		const result = composeResult(child({ text: report }), "explore", 8_000, 1000, { childSessionFile: "/tmp/c.jsonl" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).not.toContain("truncated");
		expect(text.endsWith(report.trim())).toBe(true);
		expect(result.details.truncated).toBe(false);
		expect(result.details.report).toBe(report);
		expect(result.details.reportFile).toBeUndefined();
	});

	it("beyond the byte budget, sends the head and writes the complete report beside the transcript", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-sub-report-"));
		try {
			const transcript = join(dir, "child.jsonl");
			const long = `${"head\n".repeat(300)}TAIL-MARKER`;
			const result = composeResult(child({ text: long }), "explore", 1000, 1000, { childSessionFile: transcript });
			const text = (result.content[0] as { text: string }).text;
			expect(result.details.truncated).toBe(true);
			expect(text).not.toContain("TAIL-MARKER");
			// The pointer is to a report-only file, and it says so: the transcript is explicitly ruled out.
			expect(result.details.reportFile).toBe(join(dir, "child.report.md"));
			expect(text).toContain(join(dir, "child.report.md"));
			expect(text).toContain("Do not re-read the transcript");
			expect(readFileSync(result.details.reportFile!, "utf8")).toBe(long);
			// The human still gets the whole report on the card, cut or not.
			expect(result.details.report).toBe(long);
			expect(result.details.preview).toBe("head");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fills the byte budget when one enormous line would otherwise eat it", () => {
		// `truncateHead` never returns a partial line: given a 48 KB single line it stops at the 13-byte
		// heading, so the model would get a heading and 3987 bytes of the cap left unused.
		const blob = `## Conclusion\n\n${"payload ".repeat(6000)}\n\nEPILOGUE`;
		const result = composeResult(child({ text: blob }), "explore", 4000, 1000);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("## Conclusion");
		expect(text).toContain("payload");
		expect(text).not.toContain("EPILOGUE");
		expect(Buffer.byteLength(text)).toBeGreaterThan(4000);
	});

	it("cuts a byte budget at a character boundary, never mid-codepoint", () => {
		const text = (composeResult(child({ text: "é".repeat(5000) }), "explore", 100, 1000).content[0] as { text: string }).text;
		expect(text).not.toContain("\uFFFD");
		expect(text).toContain("é");
	});

	it("falls back to the transcript when there is nowhere to write the report", () => {
		const result = composeResult(child({ text: "y".repeat(5000) }), "explore", 1000, 1000);
		const text = (result.content[0] as { text: string }).text;
		expect(result.details.reportFile).toBeUndefined();
		expect(text).toContain("the rest is in the transcript above");
	});

	it("pairs the report file with its transcript", () => {
		expect(reportFileFor("/a/b/c.jsonl")).toBe("/a/b/c.report.md");
		expect(reportFileFor("/a/b/c.log")).toBe("/a/b/c.log.report.md");
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

	it("reads a model pin and lets the project scope replace it", () => {
		fixture({
			global: { subagent: { model: "kilo:minimax/minimax-m2.7:free" } },
			project: { subagent: { model: "local/qwen3.8-flash-next" } },
		});
		const loaded = loadSubagentLimits(join(root, "project"), true);
		expect(loaded.limits.model).toBe("local/qwen3.8-flash-next");
		expect(loaded.errors).toEqual([]);
	});

	it("leaves the model unpinned when no file sets one", () => {
		fixture({ global: { subagent: { maxTurns: 5 } } });
		expect(loadSubagentLimits(root, false).limits.model).toBeUndefined();
	});

	it("reports a malformed model without disabling the tool", () => {
		fixture({ global: { subagent: { enabled: true, model: 42 } } });
		const loaded = loadSubagentLimits(root, false);
		expect(loaded.limits.enabled).toBe(true);
		expect(loaded.limits.model).toBeUndefined();
		expect(loaded.errors.join(" ")).toContain("subagent.model");
	});

	it("tolerates hand-written JSONC comments like pi-gate does", () => {
		const agentDir = join(root, `agent-jsonc-${Math.random().toString(36).slice(2)}`);
		const path = join(agentDir, "extensions/pi-gate/config.json");
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, `{\n // pin the cheap local model\n "subagent": { "maxTurns": 6, "model": "local/qwen3.8-flash-next" }\n}\n`, "utf8");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const loaded = loadSubagentLimits(root, false);
		expect(loaded.limits.maxTurns).toBe(6);
		expect(loaded.limits.model).toBe("local/qwen3.8-flash-next");
		expect(loaded.errors.join(" ")).toContain("comments were stripped");
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
