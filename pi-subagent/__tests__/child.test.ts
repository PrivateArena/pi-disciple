import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import {
	CHILD_RETRIES,
	CHILD_RETRY_MAX_DELAY_MS,
	childSessionDir,
	pruneTranscripts,
	reportFileFor,
	runChild,
	totalUsage,
	type ChildRunInput,
} from "../child.ts";
import { ROLES } from "../roles.ts";
import { buildShims, type ShimHost } from "../shims.ts";

interface Spy {
	messages?: unknown[];
	options?: CreateAgentSessionOptions;
	disposed: boolean;
	aborted: boolean;
	promptArgs?: string[];
	steers: string[];
	emit?: (event: Record<string, unknown>) => void;
	/** Releases a "hang" prompt, i.e. the child's run finishing on its own. */
	release?: () => void;
}

function stubSession(spy: Spy, behaviour: "answer" | "hang" | "throw" = "answer") {
	const listeners: ((event: never) => void)[] = [];
	const session = {
		isStreaming: behaviour === "hang",
		sessionFile: "/tmp/child.jsonl",
		sessionManager: { getSessionId: () => "child-1" },
		messages: (spy.messages ?? [
			{
				role: "assistant",
				content: [{ type: "text", text: "the answer is in pi-gate/policy.ts" }],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		]),
		subscribe(listener: (event: never) => void) {
			listeners.push(listener);
			spy.emit = (event) => listener(event as never);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		async steer(text: string) {
			spy.steers.push(text);
		},
		async prompt(text: string) {
			spy.promptArgs = [text];
			if (behaviour === "throw") throw new Error("provider exploded");
			if (behaviour === "hang") await new Promise<void>((resolve) => {
				spy.release = () => {
					session.isStreaming = false;
					resolve();
				};
			});
		},
		async abort() {
			spy.aborted = true;
			session.isStreaming = false;
		},
		dispose() {
			spy.disposed = true;
		},
	};
	return { session: session as unknown as AgentSession };
}

function input(overrides: Partial<ChildRunInput> = {}): ChildRunInput {
	const root = mkdtempSync(join(tmpdir(), "pi-sub-child-"));
	const host: ShimHost = { parentCallId: "P", executeTool: async () => ({ result: { content: [], details: undefined }, isError: false }) as never };
	return {
		role: ROLES.explore,
		task: "find the gate",
		cwd: root,
		agentDir: root,
		model: { id: "stub", contextWindow: 200_000 } as never,
		tools: buildShims(
			[{ name: "read", label: "read", description: "read", parameters: { type: "object" } } as never],
			ROLES.explore,
			host,
		),
		sessionDir: root,
		signal: new AbortController().signal,
		onProgress: () => undefined,
		...overrides,
	};
}

describe("runChild", () => {
	it("assembles a child with zero extensions and exactly the shim allowlist", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const base = input();
		const result = await runChild({
			...base,
			sessionFactory: async (options) => {
				spy.options = options;
				return stubSession(spy);
			},
		});

		expect(spy.options?.tools).toEqual(["read"]);
		expect(spy.options?.customTools).toHaveLength(1);
		expect(spy.options?.resourceLoader?.getExtensions().extensions).toEqual([]);
		expect(spy.options?.resourceLoader?.getSystemPrompt?.()).toMatch(/subagent/);
		expect(spy.options?.sessionManager?.getSessionDir?.()).toBe(childSessionDir(base.sessionDir));
		expect(result.exit).toBe("done");
		expect(result.text).toContain("pi-gate/policy.ts");
		expect(result.childSessionFile).toBe("/tmp/child.jsonl");
		expect(spy.disposed).toBe(true);
	});

	it("returns aborted and disposes when the parent aborts mid-run", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const controller = new AbortController();
		const run = runChild({ ...input({ signal: controller.signal }), sessionFactory: async () => stubSession(spy, "hang") });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const started = Date.now();
		controller.abort();
		const result = await run;
		expect(Date.now() - started).toBeLessThan(1000);
		expect(result.exit).toBe("aborted");
		expect(spy.disposed).toBe(true);
	});

	it("settles even when prompt() never resolves (FM-2)", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const controller = new AbortController();
		const result = await runChild({
			...input({ signal: controller.signal }),
			role: { ...ROLES.explore, timeoutMinutes: 0.02 },
			hardSlackMs: 40,
			sessionFactory: async () => stubSession(spy, "hang"),
		});
		expect(result.exit).toBe("timeout");
		expect(spy.steers.join(" ")).toMatch(/Summarise your findings now/);
		expect(spy.disposed).toBe(true);
	});

	it("lets a report that is still being written finish past the hard ceiling", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const started = Date.now();
		const run = runChild({
			...input(),
			role: { ...ROLES.explore, timeoutMinutes: 0.01 },
			hardSlackMs: 40,
			reportGraceMs: 3_000,
			sessionFactory: async () => stubSession(spy, "hang"),
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		// The child is streaming its final answer: text so far, no tool call.
		spy.emit?.({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "the report" }] } });
		await new Promise((resolve) => setTimeout(resolve, 700)); // past the ceiling, which the report outran
		expect(spy.aborted).toBe(false); // the ceiling passed while the report was mid-sentence
		spy.release?.();
		const result = await run;
		expect(result.exit).toBe("done");
		expect(spy.aborted).toBe(false);
		expect(Date.now() - started).toBeGreaterThan(200);
	});

	it("cuts a report at the report wall so a run still cannot run forever", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const started = Date.now();
		const run = runChild({
			...input(),
			role: { ...ROLES.explore, timeoutMinutes: 0.01 },
			hardSlackMs: 40,
			reportGraceMs: 120,
			sessionFactory: async () => stubSession(spy, "hang"),
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		spy.emit?.({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "still writing" }] } });
		const result = await run;
		expect(result.exit).toBe("timeout");
		expect(spy.aborted).toBe(true);
		expect(Date.now() - started).toBeGreaterThanOrEqual(720); // hard ceiling (640 ms) plus most of the 120 ms wall
	});

	it("gives an in-flight tool call the slack to land, then lets the report finish", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const run = runChild({
			...input(),
			role: { ...ROLES.explore, timeoutMinutes: 0.01 },
			hardSlackMs: 200,
			reportGraceMs: 3_000,
			sessionFactory: async () => stubSession(spy, "hang"),
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		// A long tool call is why the "wrap up" steer was never delivered - the ceiling must not kill it.
		spy.emit?.({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} });
		await new Promise((resolve) => setTimeout(resolve, 780));
		expect(spy.aborted).toBe(false);
		spy.emit?.({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: {}, isError: false });
		spy.emit?.({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "conclusion" }] } });
		await new Promise((resolve) => setTimeout(resolve, 260));
		expect(spy.aborted).toBe(false);
		spy.release?.();
		const result = await run;
		expect(result.exit).toBe("done");
		expect(result.toolCalls).toBe(1);
	});

	it("reports an error result without throwing", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const result = await runChild({ ...input(), sessionFactory: async () => stubSession(spy, "throw") });
		expect(result.exit).toBe("error");
		expect(result.error).toContain("provider exploded");
		expect(spy.disposed).toBe(true);
	});

	it("steers to a conclusion at maxTurns and marks the run incomplete", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const controller = new AbortController();
		const run = runChild({
			...input({ signal: controller.signal }),
			role: { ...ROLES.explore, maxTurns: 2 },
			hardSlackMs: 60_000,
			sessionFactory: async () => stubSession(spy, "hang"),
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		spy.emit?.({ type: "message_end", message: { role: "assistant", content: [] } });
		spy.emit?.({ type: "message_end", message: { role: "assistant", content: [] } });
		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		const result = await run;
		expect(spy.steers.join(" ")).toMatch(/reached its limit of 2 turns\. Summarise your findings now/);
		expect(result.exit).toBe("aborted"); // the parent abort beats the earlier maxTurns steer
		expect(result.turns).toBe(2);
	});

	it("counts tool calls and turns for the progress line", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const progress: number[] = [];
		const controller = new AbortController();
		const run = runChild({
			...input({ signal: controller.signal, onProgress: (p) => progress.push(p.toolCalls) }),
			hardSlackMs: 60_000,
			sessionFactory: async () => stubSession(spy, "hang"),
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		spy.emit?.({ type: "tool_execution_start", toolCallId: "x", toolName: "bash" });
		spy.emit?.({ type: "tool_execution_start", toolCallId: "y", toolName: "read" });
		controller.abort();
		const result = await run;
		expect(result.toolCalls).toBe(2);
		expect(progress).toEqual([1, 2, 2]); // the last emit carries the final state
	});
});

describe("usage and transcripts", () => {
	it("sums assistant usage for the footer (A9)", () => {
		const usage = totalUsage([
			{ role: "assistant", content: [], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
			{ role: "assistant", content: [], usage: { input: 4, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
		] as never);
		expect(usage?.totalTokens).toBe(12);
		expect(totalUsage([] as never)).toBeUndefined();
	});

	it("keeps the newest transcripts and deletes the rest (FM-15)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-sub-prune-"));
		for (let i = 0; i < 5; i++) writeFileSync(join(dir, `s${i}.jsonl`), "{}", "utf8");
		const removed = await pruneTranscripts(dir, 2);
		expect(removed).toBe(3);
	});

	it("takes each report file with its transcript, and sweeps orphans", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-sub-prune-report-"));
		try {
			// Three runs, newest last, each a transcript plus the report spilled beside it — plus a report whose
			// transcript was deleted by an earlier pass.
			for (const name of ["s0", "s1", "s2"]) {
				writeFileSync(join(dir, `${name}.jsonl`), "{}", "utf8");
				writeFileSync(reportFileFor(join(dir, `${name}.jsonl`)), "report", "utf8");
				const when = new Date(Date.parse("2026-01-01T00:00:00Z") + Number(name.slice(1)) * 60_000);
				utimesSync(join(dir, `${name}.jsonl`), when, when);
			}
			writeFileSync(join(dir, "gone.report.md"), "report", "utf8");

			const removed = await pruneTranscripts(dir, 2);
			// Only transcripts count as removed — the count is what the model is told, and it means sessions.
			expect(removed).toBe(1);
			expect(readdirSync(dir).sort()).toEqual(["s1.jsonl", "s1.report.md", "s2.jsonl", "s2.report.md"]);
			expect(existsSync(reportFileFor(join(dir, "s0.jsonl")))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("child resilience", () => {
	it("keeps compaction off but retries transient provider errors (bounded)", async () => {
		let captured: CreateAgentSessionOptions | undefined;
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		await runChild({
			...input(),
			sessionFactory: async (options) => {
				captured = options;
				return stubSession(spy);
			},
		});
		const settings = captured?.settingsManager as unknown as { settings: Record<string, unknown> };
		expect(settings.settings.compaction).toMatchObject({ enabled: false });
		expect(settings.settings.retry).toMatchObject({ enabled: true, maxRetries: CHILD_RETRIES, maxAgentDelayMs: CHILD_RETRY_MAX_DELAY_MS });
	});

	it("maps a quiet provider error onto the result instead of reporting DONE", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const result = await runChild({
			...input(),
			sessionFactory: async () => {
				spy.messages = [
					{
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: '503 "The upstream provider was unable to process the request"',
					} as never,
				];
				return stubSession(spy);
			},
		});
		expect(result.exit).toBe("error");
		expect(result.error).toContain("503");
	});
});
