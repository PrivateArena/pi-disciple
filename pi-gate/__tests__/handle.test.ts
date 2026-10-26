import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { allowAllNote, attachNote, handleToolCall, PENDING_NOTE_LIMIT, rememberNote, type GateState } from "../handle.ts";
import { clearPolicyCache, loadPolicy, type Policy, withSessionGrants } from "../policy.ts";
import { gateDoc, makeFixture, writeGlobalConfig, type Fixture } from "./fixture.ts";
import type { GrantRule } from "../schema.ts";
import { CHOICES, type Choice } from "../prompt.ts";

let fixture: Fixture | undefined;

function policyWith(permission: unknown): Policy {
	fixture = makeFixture();
	writeGlobalConfig(fixture, gateDoc(permission));
	clearPolicyCache();
	return loadPolicy(fixture.cwd, true, fixture.agentDir);
}

interface UiLog {
	titles: string[];
	questions: string[][];
}

function stubCtx(policyChoice: Choice | "undefined", log: UiLog): ExtensionContext {
	return {
	 cwd: fixture?.cwd ?? "/repo",
		hasUI: true,
		mode: "tui",
		signal: new AbortController().signal,
		isProjectTrusted: () => true,
		ui: {
			select: async (title: string, options: string[]) => {
				log.titles.push(title);
				log.questions.push(options);
				return policyChoice === "undefined" ? undefined : options[CHOICES.indexOf(policyChoice)] ?? undefined;
			},
			input: async () => "use the make target instead",
			notify: () => undefined,
			setStatus: () => undefined,
		},
	} as unknown as ExtensionContext;
}

function stateFor(policy: Policy, grants: GrantRule[] = []): GateState & { applied: Policy[] } {
	const applied: Policy[] = [];
	return {
		policy,
		sessionGrants: grants,
		allowAll: undefined,
		subagentCalls: new Map(),
		pendingNotes: new Map(),
		policyChanged: (next) => applied.push(next),
		applied,
	};
}

const bash = (command: string, callId = "c1"): ToolCallEvent =>
	({ type: "tool_call", toolCallId: callId, toolName: "bash", input: { command } }) as ToolCallEvent;

const tool = (toolName: string, input: Record<string, unknown>, callId = "c1"): ToolCallEvent =>
	({ type: "tool_call", toolCallId: callId, toolName, input }) as ToolCallEvent;

afterEach(() => {
	fixture?.cleanup();
	fixture = undefined;
	clearPolicyCache();
});

describe("ask outcomes", () => {
	it("lets the call through on allow once", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const log: UiLog = { titles: [], questions: [] };
		const result = await handleToolCall(bash("git commit -m x"), stubCtx("once", log), stateFor(policy));
		expect(result).toBeUndefined();
		expect(log.titles).toHaveLength(1);
		expect(log.titles[0]).toContain("git commit -m x");
	});

	it("lets the call through on allow-with-reason and queues the note for that call", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const state = stateFor(policy);
		const log: UiLog = { titles: [], questions: [] };
		const result = await handleToolCall(bash("git commit -m x", "c1"), stubCtx("allow_reason", log), state);
		expect(result).toBeUndefined();
		expect(state.pendingNotes.get("c1")).toBe("use the make target instead");
	});

	it("redacts secrets out of an allow-with-reason note", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const state = stateFor(policy);
		const ctx = {
			...stubCtx("allow_reason", { titles: [], questions: [] }),
			ui: { ...stubCtx("allow_reason", { titles: [], questions: [] }).ui, input: async () => "keep going, token=abc123" },
		} as unknown as ExtensionContext;
		await handleToolCall(bash("git commit -m x", "c1"), ctx, state);
		expect(state.pendingNotes.get("c1")).toContain("token=<redacted>");
	});

	it("puts the queued note on that call's result and nowhere else", async () => {
		const notes = new Map([["c1", "use the make target instead"]]);
		const result = { type: "tool_result", toolCallId: "c1", toolName: "bash", input: {}, content: [{ type: "text", text: "ok" }], isError: false } as unknown as Parameters<typeof attachNote>[0];
		const patched = attachNote(result, notes);
		expect(patched?.content?.map((part) => (part as { text?: string }).text)).toEqual(["Allowed by user with note: use the make target instead", "ok"]);
		expect(patched?.isError).toBe(false);
		expect(attachNote({ ...result, toolCallId: "c2" } as typeof result, notes)).toBeUndefined();
		expect(notes.size).toBe(0);
	});

	it("drops the oldest note past the ceiling so an unresultful call cannot leak the map", () => {
		const notes = new Map();
		for (let i = 0; i <= PENDING_NOTE_LIMIT; i++) rememberNote(notes, `c${i}`, "n");
		expect(notes.size).toBe(PENDING_NOTE_LIMIT);
		expect(notes.has("c0")).toBe(false);
	});

	it("blocks on abort, naming the call", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const log: UiLog = { titles: [], questions: [] };
		const result = await handleToolCall(bash("rm -rf build"), stubCtx("abort", log), stateFor(policy));
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Blocked by user: `rm -rf build`");
	});

	it("passes an abort-with-reason note verbatim, in a one-line template", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const log: UiLog = { titles: [], questions: [] };
		const result = await handleToolCall(bash("rm -rf build"), stubCtx("abort_reason", log), stateFor(policy));
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("Blocked by user with note: use the make target instead");
	});

	it("treats a dismissed or timed out dialog as abort", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const log: UiLog = { titles: [], questions: [] };
		const result = await handleToolCall(bash("rm -rf build"), stubCtx("undefined", log), stateFor(policy));
		expect(result?.block).toBe(true);
	});

	it("records a session grant and does not ask again for the same call", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const grants: GrantRule[] = [];
		const state = stateFor(policy, grants);
		const log: UiLog = { titles: [], questions: [] };
		await handleToolCall(bash("git commit -m x", "c1"), stubCtx("session", log), state);
		expect(grants).toHaveLength(1);
		expect(state.applied).toHaveLength(1);

		const updated = state.applied[0]!;
		expect(updated.rules.some((rule) => rule.scope === "grants.session")).toBe(true);
		const second = await handleToolCall(bash("git commit -m x", "c2"), stubCtx("session", log), { ...state, policy: updated });
		expect(second).toBeUndefined();
		expect(log.titles).toHaveLength(1);
	});

	it("writes a project grant to the project config", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const log: UiLog = { titles: [], questions: [] };
		const written: string[] = [];
		const state = stateFor(policy);
		await handleToolCall(bash("git commit -m x"), stubCtx("project", log), state, {
			appendPersisted: async (_offer, scope, cwd) => {
				written.push(`${scope}:${cwd}`);
				return { ok: true, file: "written" };
			},
		});
		expect(written).toEqual([`project:${fixture?.cwd}`]);
	});

	it("blocks a policy deny without opening a dialog", async () => {
		const policy = policyWith({ bash: { "*": "deny" } });
		const log: UiLog = { titles: [], questions: [] };
		const result = await handleToolCall(bash("rm -rf /"), stubCtx("once", log), stateFor(policy));
		expect(result?.block).toBe(true);
		expect(log.titles).toHaveLength(0);
		expect(result?.reason).toMatch(/^Blocked by policy/);
	});

	it("blocks without a UI and names the exact fix (FM-12)", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const ctx = { ...stubCtx("once", { titles: [], questions: [] }), hasUI: false, mode: "print" } as ExtensionContext;
		const result = await handleToolCall(bash("git commit -m x"), ctx, stateFor(policy));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("`git commit -m x`");
		expect(result?.reason).toMatch(/no UI|config/);
		expect(result?.reason).not.toMatch(/[{}]/);
	});

	it("fails closed when the pipeline throws (FM-5)", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const result = await handleToolCall(bash("ls"), stubCtx("once", { titles: [], questions: [] }), stateFor(policy), {
			extract: () => {
				throw new Error("boom in the extractor");
			},
		});
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/\[gate\] internal error/);
	});

	it("names the subagent that caused a nested ask", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const state = stateFor(policy);
		state.subagentCalls.set("root", { role: "explore", task: "find the auth code" });
		const log: UiLog = { titles: [], questions: [] };
		const nested = { ...bash("grep secret src", "root/3"), parentToolCallId: "root/3" } as ToolCallEvent;
		await handleToolCall(nested, stubCtx("once", log), state);
		expect(log.titles[0]).toContain("explore");
		expect(log.titles[0]).toContain("find the auth code");
	});

	it("offers one wildcard rule for every grant scope", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const log: UiLog = { titles: [], questions: [] };
		await handleToolCall(bash("git commit -m x"), stubCtx("once", log), stateFor(policy));
		const labels = log.questions[0]!;
		expect(labels[2]).toBe("Allow `git commit *` for this session");
		expect(labels[3]).toBe(`Allow \`git commit *\` for this project (${fixture?.cwd})`);
		expect(labels[4]).toBe("Allow `git commit *` for all projects");
	});

	it("lets the call through and never asks again for a chained command once allowed for the session", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const grants: GrantRule[] = [];
		const state = stateFor(policy, grants);
		const log: UiLog = { titles: [], questions: [] };
		await handleToolCall(bash("npm run lint && git status --porcelain", "c1"), stubCtx("session", log), state);
		expect(grants.map((rule) => rule.pattern)).toEqual(["npm run *", "git status *"]);

		const updated = state.applied[0]!;
		const again = await handleToolCall(bash("npm run lint && git status --porcelain", "c2"), stubCtx("session", log), { ...state, policy: updated });
		expect(again).toBeUndefined();
		expect(log.titles).toHaveLength(1);
	});

	it("writes every segment of a chained command into the project config", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const log: UiLog = { titles: [], questions: [] };
		const written: string[][] = [];
		await handleToolCall(bash("npm run lint && git status --porcelain"), stubCtx("project", log), stateFor(policy), {
			appendPersisted: async (offer, scope) => {
				written.push([scope, ...offer.patterns]);
				return { ok: true, file: "written" };
			},
		});
		expect(written).toEqual([["project", "npm run *", "git status *"]]);
	});

	it("re-asks nothing after \"allow everything for this session\"", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const state = stateFor(policy);
		const log: UiLog = { titles: [], questions: [] };
		await handleToolCall(bash("git commit -m x", "c1"), stubCtx("all_session", log), state);
		expect(state.allowAll).toEqual({ until: null });

		const second = await handleToolCall(bash("npm publish", "c2"), stubCtx("all_session", log), state);
		expect(second).toBeUndefined();
		expect(log.titles).toHaveLength(1);
	});

	it("re-asks nothing inside the 5-minute window and asks again after it", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const state = stateFor(policy);
		const log: UiLog = { titles: [], questions: [] };
		let clock = 1_000_000;
		const deps = { now: () => clock };

		await handleToolCall(bash("git commit -m x", "c1"), stubCtx("once", log), state, deps);
		const timed = await handleToolCall(bash("git push", "c2"), stubCtx("all_timed", log), state, deps);
		expect(timed).toBeUndefined();
		expect(state.allowAll).toEqual({ until: 1_000_000 + 5 * 60 * 1000 });

		expect(await handleToolCall(bash("git fetch", "c3"), stubCtx("once", log), state, deps)).toBeUndefined();
		expect(log.titles).toHaveLength(2);

		clock += 5 * 60 * 1000 + 1;
		await handleToolCall(bash("git pull", "c4"), stubCtx("once", log), state, deps);
		expect(log.titles).toHaveLength(3);
	});

	it("\"allow everything\" never overrides a deny rule", async () => {
		const policy = policyWith({ bash: { "*": "ask", "git push *": "deny" } });
		const state = stateFor(policy);
		state.allowAll = { until: null };
		const log: UiLog = { titles: [], questions: [] };
		const result = await handleToolCall(bash("git push origin main"), stubCtx("once", log), state);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/^Blocked by policy/);
	});

	it("\"allow everything\" walks past a path outside the workspace and a hidden argument", async () => {
		const policy = policyWith({ "*": "ask", bash: { "*": "ask" }, path: { "*": "allow" }, external_directory: "ask" });
		const state = stateFor(policy);
		state.allowAll = { until: null };
		const log: UiLog = { titles: [], questions: [] };
		expect(await handleToolCall(bash("cat /etc/hosts"), stubCtx("once", log), state)).toBeUndefined();
		expect(log.titles).toHaveLength(0);
	});

	it("\"allow everything\" now covers the calls it used to except — the point of clicking it and walking away", async () => {
		const policy = policyWith({ "*": "allow", path: { "*": "allow" } });
		const state = stateFor(policy);
		state.allowAll = { until: null };
		const log: UiLog = { titles: [], questions: [] };

		const calls: ToolCallEvent[] = [
			bash(`cat ${fixture?.agentDir}/extensions/pi-gate/config.json`, "c1"), // the gate's own config
			tool("edit", { path: `${fixture?.agentDir}/extensions/pi-gate/policy.ts` }, "c2"), // the gate's own code
			bash(`echo x > ${fixture?.agentDir}/settings.json`, "c3"), // pi's settings
			tool("write", { path: `${fixture?.cwd}/.pi/extensions/pi-gate/config.json` }, "c4"), // project gate config
			bash(`echo x > ${fixture?.cwd}/.git/hooks/pre-commit`, "c5"), // code that runs as the user
		];
		for (const call of calls) {
			expect(await handleToolCall(call, stubCtx("once", log), state)).toBeUndefined();
		}
		expect(log.titles).toHaveLength(0);
	});

	it("\"allow everything\" holds even when no config file can be parsed", async () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, "{ this is not json");
		clearPolicyCache();
		const degraded = loadPolicy(fixture.cwd, true, fixture.agentDir);
		expect(degraded.degraded).toBe(true);

		const state = stateFor(degraded);
		const log: UiLog = { titles: [], questions: [] };
		// off: a config that cannot be read escalates every allow, so the call is asked about
		expect(await handleToolCall(bash("cat a.ts"), stubCtx("once", log), state)).toBeUndefined();
		expect(log.titles).toHaveLength(1);

		state.allowAll = { until: null };
		expect(await handleToolCall(bash("cat b.ts", "c2"), stubCtx("once", log), state)).toBeUndefined();
		expect(log.titles).toHaveLength(1);
	});

	it("\"allow everything\" needs no UI to be honoured — an overnight `pi -p` run must not stall", async () => {
		const policy = policyWith({ "*": "ask", path: { "*": "allow" }, external_directory: "ask", bash: { "*": "ask" } });
		const state = stateFor(policy);
		state.allowAll = { until: null };
		const log: UiLog = { titles: [], questions: [] };
		const headless = { ...stubCtx("once", log), hasUI: false } as ExtensionContext;
		expect(await handleToolCall(bash(`echo x > ${fixture?.agentDir}/settings.json`), headless, state)).toBeUndefined();
		expect(log.titles).toHaveLength(0);
	});

	it("the dialog note says what the mode actually does: nothing is excepted", () => {
		const note = allowAllNote({ until: null }, 0) ?? "";
		expect(note).toContain("nothing is asked about any more");
		expect(note).not.toMatch(/still ask/);
		expect(allowAllNote({ until: 10 }, 20)).toBeUndefined();
	});

	it("\"allow everything\" silences a protected read, which cannot reprogram the gate", async () => {
		const policy = policyWith({ "*": "allow", path: { "*": "allow" } });
		const state = stateFor(policy);
		state.allowAll = { until: null };
		const log: UiLog = { titles: [], questions: [] };
		const readSettings = { type: "tool_call", toolCallId: "c1", toolName: "read", input: { path: `${fixture?.agentDir}/settings.json` } } as ToolCallEvent;
		expect(await handleToolCall(readSettings, stubCtx("once", log), state)).toBeUndefined();
		expect(log.titles).toHaveLength(0);
	});

	it("makes an exact grant for a wrapper command stick — one click, then no more dialogs", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const grants: GrantRule[] = [];
		const state = stateFor(policy, grants);
		const log: UiLog = { titles: [], questions: [] };
		await handleToolCall(bash("npx vitest run", "c1"), stubCtx("session", log), state);
		expect(grants.map((rule) => rule.pattern)).toEqual(["npx vitest run"]);

		const updated = state.applied[0]!;
		expect(await handleToolCall(bash("npx vitest run", "c2"), stubCtx("session", log), { ...state, policy: updated })).toBeUndefined();
		expect(log.titles).toHaveLength(1);
	});

	it("applies the policy changed by an earlier grant to later calls", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const granted = withSessionGrants(policy, [{ surface: "bash", pattern: "ls", action: "allow" }]);
		const log: UiLog = { titles: [], questions: [] };
		const result = await handleToolCall(bash("ls"), stubCtx("once", log), stateFor(granted));
		expect(result).toBeUndefined();
		expect(log.titles).toHaveLength(0);
	});
});
