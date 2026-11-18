import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import {
	CHILD_RETRIES,
	CHILD_RETRY_MAX_DELAY_MS,
	MAX_CALL_REMINDERS,
	childSessionDir,
	pruneTranscripts,
	reportFileFor,
	runChild,
	totalUsage,
	type ChildRunInput,
	type CeilingAnswer,
	type CeilingAsk,
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
	/** Every active-tool set the run asked for; the last one is what the final turn ran on. */
	activeTools?: string[][];
	/** How many times the child has been prompted: the second one is the final report turn. */
	spawns?: number;
	emit?: (event: Record<string, unknown>) => void;
	/** Releases a "hang" prompt, i.e. the child's run finishing on its own. */
	release?: () => void;
	/** What the tool-less final turn answers with, when one is asked. */
	finalText?: string;
}

function stubSession(spy: Spy, behaviour: "answer" | "hang" | "throw" = "answer") {
	const listeners: ((event: never) => void)[] = [];
	const messages = (spy.messages ?? [
		{
			role: "assistant",
			content: [{ type: "text", text: "the answer is in pi-gate/policy.ts" }],
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		},
		// Every assistant message of a real run ends with a stop reason; the shape of that reason is what
		// `final-report.ts` reads to tell a report from a fragment.
	]) as unknown[];
	const session = {
		isStreaming: behaviour === "hang",
		sessionFile: "/tmp/child.jsonl",
		sessionManager: { getSessionId: () => "child-1" },
		messages,
		subscribe(listener: (event: never) => void) {
			listeners.push(listener);
			spy.emit = (event) => listener(event as never);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		async steer(text: string) {
			spy.steers.push(text);
		},
		setActiveToolsByName(names: string[]) {
			(spy.activeTools ??= []).push(names);
		},
		async prompt(text: string) {
			spy.promptArgs = [...(spy.promptArgs ?? []), text];
			if (behaviour === "throw") throw new Error("provider exploded");
			spy.spawns = (spy.spawns ?? 0) + 1;
			if (behaviour === "hang" && spy.spawns === 1) {
				await new Promise<void>((resolve) => {
					spy.release = () => {
						session.isStreaming = false;
						resolve();
					};
				});
				return;
			}
			// A later prompt is the tool-less final report turn: it answers, and the session goes idle.
			if (spy.spawns > 1) {
				messages.push({ role: "assistant", content: [{ type: "text", text: spy.finalText ?? "FINAL REPORT: I read the policy and stopped." }], stopReason: "stop" });
			}
			session.isStreaming = false;
		},
		async abort() {
			spy.aborted = true;
			session.isStreaming = false;
		},
		async waitForIdle() {
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
		// These tests are about the child run, not the artefacts it leaves on disk; the shipped default of
		// one JSONL per run is what the debug-log suite opts into explicitly.
		debugLog: false,
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

describe("the report guarantee", () => {
	/** Exactly what a budget-starved Qwen turn leaves behind (`tool_calls.txt`, 2026-11-17). */
	const LEAKED_CALL = "Now I'll write the code. Starting with deps and lib.rs:\n[Tool call: bash]";

	const leakedMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "Now verify the claim, then write deps." }, { type: "text", text: LEAKED_CALL }],
		stopReason: "stop",
	} as never;

	it("makes a run that was cut off mid-turn write its report in a tool-less turn", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [], finalText: "REPORT: wrote lib.rs and mod.rs; tests not run." };
		const started = Date.now();
		const result = await runChild({
			...input(),
			role: { ...ROLES.explore, timeoutMinutes: 0.02 },
			hardSlackMs: 40,
			sessionFactory: async () => {
				// The last thing the child said is the half of a turn the wall interrupted.
				spy.messages = [{ role: "assistant", content: [{ type: "text", text: "Now I'll write the code, starting with deps:" }], stopReason: "aborted" } as never];
				return stubSession(spy, "hang");
			},
		});
		// Two prompts: the task, and the rescue. The rescue ran with no tools, which is what forces a message.
		expect(spy.promptArgs?.length).toBe(2);
		expect(spy.activeTools?.at(-1)).toEqual([]);
		expect(spy.promptArgs?.[1]).toMatch(/tools are now switched off/i);
		expect(result.exit).toBe("timeout");
		expect(result.reportSource).toBe("rescued");
		expect(result.text).toBe("REPORT: wrote lib.rs and mod.rs; tests not run.");
		expect(result.text).not.toContain("Now I'll write the code");
		expect(spy.disposed).toBe(true);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("tells the child that a call written as text ran nothing, and takes the report anyway", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [], finalText: "REPORT: 4 files written, cargo check not run." };
		const run = runChild({
			...input(),
			hardSlackMs: 60_000,
			sessionFactory: async () => {
				spy.messages = [leakedMessage];
				return stubSession(spy, "hang");
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		spy.emit?.({ type: "message_end", message: leakedMessage });
		await new Promise((resolve) => setTimeout(resolve, 10));
		spy.release?.();
		const result = await run;
		// The in-place correction, before the run could end on the sentence…
		expect(spy.steers.join(" ")).toMatch(/Malformed tool call.*\[Tool call: bash\]/s);
		expect(result.reminders).toBe(1);
		// …and the rescue, because the text it stopped on was never a report. `exit` stays "done": the child
		// did stop on its own. What changed is that the parent is not handed markup-as-an-answer.
		expect(result.exit).toBe("done");
		expect(result.reportSource).toBe("rescued");
		expect(result.text).toBe("REPORT: 4 files written, cargo check not run.");
		expect(spy.promptArgs?.[1]).toMatch(/wrote a tool call as text/);
	});

	it("caps the reminders: a model that keeps writing calls is rescued, not lectured", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const run = runChild({
			...input(),
			hardSlackMs: 60_000,
			sessionFactory: async () => {
				spy.messages = [leakedMessage];
				return stubSession(spy, "hang");
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		for (let i = 0; i < 5; i++) spy.emit?.({ type: "message_end", message: leakedMessage });
		await new Promise((resolve) => setTimeout(resolve, 10));
		spy.release?.();
		const result = await run;
		expect(result.reminders).toBe(MAX_CALL_REMINDERS);
		expect(spy.steers.filter((text) => text.includes("Malformed tool call")).length).toBe(MAX_CALL_REMINDERS);
		expect(result.reportSource).toBe("rescued");
	});

	it("asks nothing of a run the human stopped, or of one the provider killed", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const controller = new AbortController();
		const run = runChild({ ...input({ signal: controller.signal }), sessionFactory: async () => stubSession(spy, "hang") });
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		const aborted = await run;
		expect(aborted.exit).toBe("aborted");
		expect(spy.promptArgs?.length).toBe(1);
		expect(aborted.reportSource).toBe("final"); // the canned message is a report, and the human said stop

		const broken: Spy = { disposed: false, aborted: false, steers: [] };
		const errored = await runChild({ ...input(), sessionFactory: async () => stubSession(broken, "throw") });
		expect(errored.exit).toBe("error");
		expect(broken.promptArgs?.length).toBe(1);
	});

	it("stands down when subagent.requireFinalReport is off", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const result = await runChild({
			...input(),
			requireFinalReport: false,
			role: { ...ROLES.explore, timeoutMinutes: 0.02 },
			hardSlackMs: 40,
			sessionFactory: async () => {
				spy.messages = [leakedMessage];
				return stubSession(spy, "hang");
			},
		});
		expect(spy.promptArgs?.length).toBe(1);
		expect(result.reportSource).toBe("salvaged");
		expect(result.text).toContain("[Tool call: bash]");
	});

	it("does not rescue a child that answered after its budget was spent", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const result = await runChild({
			...input(),
			role: { ...ROLES.explore, maxTurns: 1 },
			hardSlackMs: 60_000,
			sessionFactory: async () => stubSession(spy),
		});
		expect(result.reportSource).toBe("final");
		expect(spy.promptArgs?.length).toBe(1);
	});
});

describe("the debug log (subagent.debugLog)", () => {
	it("writes one JSONL per run, and nothing at all when it is off", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-sub-turnlog-"));
		try {
			const spy: Spy = { disposed: false, aborted: false, steers: [] };
			const result = await runChild({
				...input(),
				debugLog: true,
				debugLogDir: dir,
				callId: "call-parent-1",
				role: { ...ROLES.explore, timeoutMinutes: 0.02 },
				hardSlackMs: 40,
				sessionFactory: async () => {
					// Cut off mid-turn, so the run owes a final report turn and the log records it asking.
					spy.messages = [{ role: "assistant", content: [{ type: "thinking", thinking: "let me check the deps" }], stopReason: "aborted" } as never];
					return stubSession(spy, "hang");
				},
			});
			expect(result.turnLogFile).toContain("_explore_");
			expect(result.turnLogFile).toMatch(/\.jsonl$/);
			// No sleep: `close()` is what makes the queued lines land before the result is returned.
			const lines = readFileSync(result.turnLogFile!, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { kind: string; detail?: Record<string, unknown> });
			const kinds = lines.map((line) => line.kind);
			expect(kinds).toContain("run_start");
			expect(kinds).toContain("prompt");
			expect(kinds).toContain("steer");
			expect(kinds).toContain("race");
			expect(kinds).toContain("final_report_start");
			expect(kinds).toContain("run_end");
			expect(lines.find((line) => line.kind === "run_end")?.detail?.reportSource).toBe("rescued");
			expect(lines.find((line) => line.kind === "run_start")?.detail?.role).toBe("explore");

			const quiet: Spy = { disposed: false, aborted: false, steers: [] };
			const off = await runChild({ ...input(), sessionFactory: async () => stubSession(quiet) });
			expect(off.turnLogFile).toBeUndefined();
			// Only the one log file landed in the directory.
			expect(readdirSync(dir)).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates its own directory and keeps the lines it wrote into it", async () => {
		// The directory does not exist yet, which is the ordinary case and was the broken one: `mkdir` was fired
		// beside the append chain, not on it, so the first lines of a run raced a path that was not there.
		const root = mkdtempSync(join(tmpdir(), "pi-sub-turnlog-fresh-"));
		const dir = join(root, "nested", "child-logs");
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		try {
			const result = await runChild({
				...input({ debugLog: true, debugLogDir: dir }),
				hardSlackMs: 60_000,
				sessionFactory: async () => stubSession(spy),
			});
			expect(result.turnLogFile).toBeDefined();
			const kinds = readFileSync(result.turnLogFile!, "utf8")
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { kind: string }).kind);
			expect(kinds[0]).toBe("run_start");
			expect(kinds).toContain("run_end");
			// A child's thinking and its tool arguments end up in here, so the file is the run's owner's alone.
			expect(statSync(result.turnLogFile!).mode & 0o777).toBe(0o600);
			expect(statSync(dir).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("redacts credentials out of the calls it records", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-sub-turnlog-secret-"));
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const secretCall = {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "bash", args: { command: "curl -H 'Authorization: Bearer abc123' https://api?api_key=super-secret-123" } }],
			stopReason: "toolUse",
		} as never;
		try {
			const run = runChild({
				...input({ debugLog: true, debugLogDir: dir }),
				hardSlackMs: 60_000,
				sessionFactory: async () => stubSession(spy, "hang"),
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			spy.emit?.({ type: "message_end", message: secretCall });
			spy.release?.();
			const result = await run;
			const logged = readFileSync(result.turnLogFile!, "utf8");
			expect(logged).toContain("<redacted>");
			expect(logged).not.toContain("super-secret-123");
			expect(logged).toContain("Authorization: <redacted>");
			// The redactor is the one `pi-gate`'s review log uses, by choice: same coverage, same limits, so a secret
			// is redacted the same way in both places or in neither — never silently better in one of them.
			expect(logged).toContain("abc123");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never costs a run the shape of a message it did not expect", async () => {
		// A live probe found this: pi's user messages carry `content` as a plain string, and reading it as an
		// array threw inside the subscriber — which turned a debug log into an aborted child.
		const dir = mkdtempSync(join(tmpdir(), "pi-sub-turnlog-shapes-"));
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		try {
			const run = runChild({
				...input(),
				debugLog: true,
				debugLogDir: dir,
				hardSlackMs: 60_000,
				sessionFactory: async () => stubSession(spy, "hang"),
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			spy.emit?.({ type: "message_end", message: { role: "user", content: "read src/ and report" } });
			spy.emit?.({ type: "message_end", message: { role: "toolResult", toolName: "bash", content: "entry.rs\nlib.rs" } });
			spy.emit?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Two files: entry.rs, lib.rs." }] } });
			spy.release?.();
			const result = await run;
			expect(result.exit).toBe("done");
			expect(result.error ?? "").not.toMatch(/map is not a function/);
			const kinds = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8")
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { kind: string }).kind);
			expect(kinds.filter((kind) => kind === "message_end")).toHaveLength(3);
			expect(kinds).toContain("run_end");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the ceiling offer (runChild.onCeiling)", () => {
	const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	it("asks at maxTurns, and a granted extension raises the limit instead of ending the run", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const asks: CeilingAsk[] = [];
		const controller = new AbortController();
		const run = runChild({
			...input({ signal: controller.signal }),
			role: { ...ROLES.explore, maxTurns: 2 },
			hardSlackMs: 60_000,
			onCeiling: async (ask) => {
				asks.push(ask);
				return { outcome: "granted", grant: { turns: 2, minutes: 1 } };
			},
			sessionFactory: async () => stubSession(spy, "hang"),
		});
		await tick(10);
		spy.emit?.({ type: "message_end", message: { role: "assistant", content: [] } });
		spy.emit?.({ type: "message_end", message: { role: "assistant", content: [] } });
		await tick(20);

		expect(asks).toHaveLength(1);
		expect(asks[0]).toMatchObject({ reason: "maxTurns", role: "explore", task: "find the gate", turns: 2, maxTurns: 2 });
		const asked = spy.steers.join(" ");
		// The child is told it has more rope, not to wrap up — the whole point of asking before enforcing.
		expect(asked).toMatch(/extended this run by 2 turns and 1 minutes/);
		expect(asked).not.toMatch(/Summarise your findings now/);

		// The raised limit is what the run is measured against now, and the offer is spent: enforce, no dialog.
		spy.emit?.({ type: "message_end", message: { role: "assistant", content: [] } });
		spy.emit?.({ type: "message_end", message: { role: "assistant", content: [] } });
		await tick(20);
		expect(asks).toHaveLength(1);
		expect(spy.steers.join(" ")).toMatch(/reached its limit of 4 turns/);

		controller.abort();
		const result = await run;
		expect(result.turns).toBe(4);
		expect(result.ceiling).toEqual({ reason: "maxTurns", outcome: "granted", turns: 2, minutes: 1 });
	});

	it("a refused offer is exactly the behaviour this run always had", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const run = runChild({
			...input(),
			role: { ...ROLES.explore, maxTurns: 2 },
			hardSlackMs: 60_000,
			onCeiling: async () => ({ outcome: "rejected" }),
			sessionFactory: async () => stubSession(spy, "hang"),
		});
		await tick(10);
		spy.emit?.({ type: "message_end", message: { role: "assistant", content: [] } });
		spy.emit?.({ type: "message_end", message: { role: "assistant", content: [] } });
		await tick(20);
		expect(spy.steers.join(" ")).toMatch(/reached its limit of 2 turns\. Summarise your findings now/);
		spy.release?.();
		const result = await run;
		expect(result.exit).toBe("maxTurns");
		expect(result.ceiling).toEqual({ reason: "maxTurns", outcome: "rejected", turns: 0, minutes: 0 });
	});

	it("holds the hard ceiling for the answer, then restarts both budgets from it", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		let answer!: (a: CeilingAnswer) => void;
		const asks: CeilingAsk[] = [];
		const started = Date.now();
		const run = runChild({
			...input(),
			// A 600 ms budget, a 640 ms ceiling and a 760 ms wall: the offer below outlives all three.
			role: { ...ROLES.explore, timeoutMinutes: 0.01 },
			hardSlackMs: 40,
			reportGraceMs: 120,
			ceilingHoldMs: 5_000,
			onCeiling: (ask) => {
				asks.push(ask);
				return new Promise<CeilingAnswer>((resolve) => {
					answer = resolve;
				});
			},
			sessionFactory: async () => stubSession(spy, "hang"),
		});
		await tick(780);
		expect(asks.map((ask) => ask.reason)).toEqual(["timeout"]);
		// The clock reached the wall while the human had not answered — and did not cut the run.
		expect(Date.now() - started).toBeGreaterThanOrEqual(760);
		expect(spy.aborted).toBe(false);

		answer({ outcome: "granted", grant: { turns: 5, minutes: 0.05 } });
		await tick(150);
		expect(spy.aborted).toBe(false);
		expect(spy.steers.join(" ")).toMatch(/extended this run by 5 turns and 0.05 minutes/);
		spy.release?.();
		const result = await run;
		// The run finished inside its second budget, so it reports as a completion, not as a cut short.
		expect(result.exit).toBe("done");
		expect(result.ceiling).toEqual({ reason: "timeout", outcome: "granted", turns: 5, minutes: 0.05 });
	});

	it("settles on the ceiling even when the offer never answers", async () => {
		const spy: Spy = { disposed: false, aborted: false, steers: [] };
		const started = Date.now();
		const result = await runChild({
			...input(),
			role: { ...ROLES.explore, timeoutMinutes: 0.01 },
			hardSlackMs: 40,
			reportGraceMs: 120,
			ceilingHoldMs: 200,
			// A broker that hangs: the dialog is not the thing that has to be trustworthy.
			onCeiling: () => new Promise<CeilingAnswer>(() => undefined),
			sessionFactory: async () => stubSession(spy, "hang"),
		});
		expect(result.exit).toBe("timeout");
		expect(spy.aborted).toBe(true);
		// Asked at 600 ms, held for 200 ms of backstop, then the wall (760 ms) decides.
		expect(Date.now() - started).toBeGreaterThanOrEqual(760);
		expect(result.ceiling).toBeUndefined();
	});
});
