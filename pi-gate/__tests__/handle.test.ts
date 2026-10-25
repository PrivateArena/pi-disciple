import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { handleToolCall, type GateState } from "../handle.ts";
import { clearPolicyCache, loadPolicy, type Policy, withSessionGrants } from "../policy.ts";
import { optionLabels } from "../prompt.ts";
import { gateDoc, makeFixture, writeGlobalConfig, type Fixture } from "./fixture.ts";
import type { GrantRule } from "../schema.ts";

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

function stubCtx(policyChoice: string | undefined | "undefined", log: UiLog): ExtensionContext {
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
				return policyChoice === "undefined" ? undefined : options[Number(policyChoice)] ?? undefined;
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
		subagentCalls: new Map(),
		policyChanged: (next) => applied.push(next),
		applied,
	};
}

const bash = (command: string, callId = "c1"): ToolCallEvent =>
	({ type: "tool_call", toolCallId: callId, toolName: "bash", input: { command } }) as ToolCallEvent;

afterEach(() => {
	fixture?.cleanup();
	fixture = undefined;
	clearPolicyCache();
});

describe("ask outcomes", () => {
	it("lets the call through on allow once", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const log: UiLog = { titles: [], questions: [] };
		const result = await handleToolCall(bash("git commit -m x"), stubCtx("0", log), stateFor(policy));
		expect(result).toBeUndefined();
		expect(log.titles).toHaveLength(1);
		expect(log.titles[0]).toContain("git commit -m x");
	});

	it("blocks on abort with a reason the model can act on", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const log: UiLog = { titles: [], questions: [] };
		const result = await handleToolCall(bash("rm -rf build"), stubCtx("4", log), stateFor(policy));
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/Blocked by the user/);
		expect(result?.reason).toContain("rm -rf build");
	});

	it("passes an abort-with-reason instruction verbatim", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const log: UiLog = { titles: [], questions: [] };
		const result = await handleToolCall(bash("rm -rf build"), stubCtx("5", log), stateFor(policy));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("use the make target instead");
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
		await handleToolCall(bash("git commit -m x", "c1"), stubCtx("1", log), state);
		expect(grants).toHaveLength(1);
		expect(state.applied).toHaveLength(1);

		const updated = state.applied[0]!;
		expect(updated.rules.some((rule) => rule.scope === "grants.session")).toBe(true);
		const second = await handleToolCall(bash("git commit -m x", "c2"), stubCtx("1", log), { ...state, policy: updated });
		expect(second).toBeUndefined();
		expect(log.titles).toHaveLength(1);
	});

	it("writes a project grant to the project config", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const log: UiLog = { titles: [], questions: [] };
		const written: string[] = [];
		const state = stateFor(policy);
		await handleToolCall(bash("git commit -m x"), stubCtx("2", log), state, {
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
		const result = await handleToolCall(bash("rm -rf /"), stubCtx("0", log), stateFor(policy));
		expect(result?.block).toBe(true);
		expect(log.titles).toHaveLength(0);
		expect(result?.reason).toMatch(/Denied by policy/);
	});

	it("blocks without a UI and names the exact fix (FM-12)", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const ctx = { ...stubCtx("0", { titles: [], questions: [] }), hasUI: false, mode: "print" } as ExtensionContext;
		const result = await handleToolCall(bash("git commit -m x"), ctx, stateFor(policy));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain('"git commit -m x"');
		expect(result?.reason).toMatch(/no UI|config/);
	});

	it("fails closed when the pipeline throws (FM-5)", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const result = await handleToolCall(bash("ls"), stubCtx("0", { titles: [], questions: [] }), stateFor(policy), {
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
		await handleToolCall(nested, stubCtx("0", log), state);
		expect(log.titles[0]).toContain("explore");
		expect(log.titles[0]).toContain("find the auth code");
	});

	it("offers the exact command for persisted scopes and a wildcard for the session", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const log: UiLog = { titles: [], questions: [] };
		await handleToolCall(bash("git commit -m x"), stubCtx("0", log), stateFor(policy));
		const labels = optionLabels(
			{
				grant: { surface: "bash", patterns: ["git commit *"], label: "git commit *", persisted: false },
				persistedGrant: { surface: "bash", patterns: ["git commit -m x"], label: "git commit -m x", persisted: true },
				facts: { toolName: "bash", preview: "x", callId: "c", cwd: fixture?.cwd ?? "/repo", surfaces: [["bash", ["git commit -m x"]]], paths: [] },
				checks: [],
				floors: [],
				action: "ask",
			},
			fixture?.cwd ?? "/repo",
		);
		expect(labels[1]).toContain("git commit *");
		expect(labels[2]).toContain("git commit -m x");
		expect(labels[0]).toBe("Allow once");
	});

	it("applies the policy changed by an earlier grant to later calls", async () => {
		const policy = policyWith({ bash: { "*": "ask" } });
		const granted = withSessionGrants(policy, [{ surface: "bash", pattern: "ls", action: "allow" }]);
		const log: UiLog = { titles: [], questions: [] };
		const result = await handleToolCall(bash("ls"), stubCtx("0", log), stateFor(granted));
		expect(result).toBeUndefined();
		expect(log.titles).toHaveLength(0);
	});
});
