/**
 * The two questions one call can raise — what it does (its own surface) and where it goes (a path) —
 * asked separately, each with a grant that really closes it. Regression cover for the bug where a shell
 * call that touched a path outside the workspace could not be allowed by any click: the only offer was
 * the command rule, which can never answer a location ask.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { clearPolicyCache, evaluate, loadPolicy, type Policy, withSessionGrants } from "../policy.ts";
import { extract } from "../inspect.ts";
import { toGrantRules } from "../grants.ts";
import { handleToolCall, type GateState } from "../handle.ts";
import { CHOICES, type Choice } from "../prompt.ts";
import { makeFixture, writeGlobalConfig, type Fixture } from "./fixture.ts";
import type { GrantRule } from "../schema.ts";

let fixture: Fixture | undefined;

/** The user's real config shape: every CLI whitelisted, `external_directory` still asking. */
const WHITELISTED_CLIS = {
	enabled: true,
	reviewLog: false,
	promptTimeoutMs: 0,
	permission: {
		"*": "ask",
		read: "allow",
		write: "allow",
		edit: "allow",
		grep: "allow",
		find: "allow",
		ls: "allow",
		path: { "*": "allow", "*.env": "deny" },
		external_directory: "ask",
		bash: { "*": "ask" },
		subagent: "allow",
	},
	grants: {
		global: ["ls", "cat", "cd", "head", "tail"].map((cli) => ({ surface: "bash", pattern: `${cli} *`, action: "allow" })),
	},
};

function setup(gate: Record<string, unknown>): Policy {
	fixture = makeFixture();
	writeGlobalConfig(fixture, { gate });
	clearPolicyCache();
	return loadPolicy(fixture.cwd, true, fixture.agentDir);
}

function decisionFor(policy: Policy, toolName: string, input: Record<string, unknown>) {
	return evaluate(extract(toolName, input, policy.cwd, { callId: "t" }), policy);
}

const sh = (command: string, callId = "c1"): ToolCallEvent =>
	({ type: "tool_call", toolCallId: callId, toolName: "bash", input: { command } }) as ToolCallEvent;

interface UiLog {
	titles: string[];
	choices: string[];
}

function stubCtx(choice: Choice, log: UiLog): ExtensionContext {
	return {
		cwd: fixture?.cwd ?? "/repo",
		hasUI: true,
		mode: "tui",
		signal: new AbortController().signal,
		isProjectTrusted: () => true,
		ui: {
			select: async (title: string, options: string[]) => {
				log.titles.push(title);
				log.choices.push(choice);
				return options[CHOICES.indexOf(choice)];
			},
			input: async () => "",
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

afterEach(() => {
	fixture?.cleanup();
	fixture = undefined;
	clearPolicyCache();
});

describe("the location question of a shell call", () => {
	it("separates an allowed command from the outside path it reads", () => {
		const policy = setup(WHITELISTED_CLIS);
		const decision = decisionFor(policy, "bash", { command: "cat /media/jang/free/CraftGang/config.json 2>&1 | head -200" });
		expect(decision.stages.map((stage) => `${stage.stage}:${stage.action}`)).toEqual(["command:allow", "location:ask"]);
		// The command question is not asked again; only the location is on the table.
		expect(decision.grant?.surface).toBe("external_directory");
	});

	it("offers the containing folder, so one click whitelists the outside directory", () => {
		const policy = setup(WHITELISTED_CLIS);
		const call = { command: "cat /media/jang/free/CraftGang/config.json" };
		const offer = decisionFor(policy, "bash", call).grant!;
		expect(offer.patterns).toEqual(["/media/jang/free/CraftGang/*"]);

		const granted = withSessionGrants(policy, toGrantRules(offer));
		expect(decisionFor(granted, "bash", call).action).toBe("allow");
		// The whole folder, not just the file that was looked at once.
		expect(decisionFor(granted, "bash", { command: "cat /media/jang/free/CraftGang/other.json" }).action).toBe("allow");
		// A sibling folder nobody granted still asks.
		expect(decisionFor(granted, "bash", { command: "cat /media/jang/free/Else/config.json" }).action).toBe("ask");
	});

	it("asks both questions for an unwhitelisted command, in order, and closes both", () => {
		const policy = setup(WHITELISTED_CLIS);
		const call = { command: "zsearch -q hi /media/jang/free/CraftGang/x" };
		const decision = decisionFor(policy, "bash", call);
		expect(decision.stages.map((stage) => `${stage.stage}:${stage.action}`)).toEqual(["command:ask", "location:ask"]);

		const afterCommand = withSessionGrants(policy, toGrantRules(decision.stages[0]!.grant!));
		expect(decisionFor(afterCommand, "bash", call).stages.map((stage) => `${stage.stage}:${stage.action}`)).toEqual(["command:allow", "location:ask"]);

		const afterFolder = withSessionGrants(afterCommand, toGrantRules(decisionFor(afterCommand, "bash", call).grant!));
		expect(decisionFor(afterFolder, "bash", call).action).toBe("allow");
	});

	it("tells a headless run about both rules, not just the command", () => {
		const policy = setup(WHITELISTED_CLIS);
		const state = stateFor(policy);
		const headless = { ...stubCtx("once", { titles: [], choices: [] }), hasUI: false, mode: "print" } as ExtensionContext;
		return handleToolCall(sh("zsearch -q hi /media/jang/free/CraftGang/config.json"), headless, state).then((result) => {
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("`zsearch *`");
			expect(result?.reason).toContain("`/media/jang/free/CraftGang/*`");
			expect(result?.reason).toContain("`bash` and `external_directory` sections");
		});
	});
});

describe("the two dialogs, end to end", () => {
	it("asks about the command first, then about the location, and lets the call run", async () => {
		const policy = setup({ ...WHITELISTED_CLIS, grants: { global: [] } });
		const grants: GrantRule[] = [];
		const state = stateFor(policy, grants);
		const log: UiLog = { titles: [], choices: [] };

		expect(await handleToolCall(sh("zsearch -q hi /media/jang/free/CraftGang/x", "c1"), stubCtx("session", log), state)).toBeUndefined();
		expect(log.titles).toHaveLength(2);
		expect(log.titles[0]).toContain("question 1 of 2");
		expect(log.titles[1]).toContain("bash · location");
		expect(log.titles[1]).toContain("question 2 of 2");
		// Command rules on the command surface, the folder on the boundary surface — nothing cross-written.
		expect(grants).toEqual([
			{ surface: "bash", pattern: "zsearch *", action: "allow" },
			{ surface: "external_directory", pattern: "/media/jang/free/CraftGang/*", action: "allow" },
		]);
	});

	it("asks only the location question when the command is already whitelisted", async () => {
		const policy = setup(WHITELISTED_CLIS);
		const state = stateFor(policy);
		const log: UiLog = { titles: [], choices: [] };
		expect(await handleToolCall(sh("cat /media/jang/free/CraftGang/config.json"), stubCtx("once", log), state)).toBeUndefined();
		expect(log.titles).toHaveLength(1);
		expect(log.titles[0]).toContain("bash · location");
		expect(log.titles[0]).not.toContain("question");
	});

	it("stops asking once the outside folder is whitelisted — the point of the whole exercise", async () => {
		const policy = setup(WHITELISTED_CLIS);
		const grants: GrantRule[] = [];
		const state = stateFor(policy, grants);
		const log: UiLog = { titles: [], choices: [] };

		expect(await handleToolCall(sh("cat /media/jang/free/CraftGang/config.json", "c1"), stubCtx("session", log), state)).toBeUndefined();
		expect(log.titles).toHaveLength(1);
		expect(grants).toEqual([{ surface: "external_directory", pattern: "/media/jang/free/CraftGang/*", action: "allow" }]);

		// Next file in that folder, on the policy the click produced: no question left to ask.
		const applied = state.applied.at(-1)!;
		expect(await handleToolCall(sh("cat /media/jang/free/CraftGang/next.json", "c2"), stubCtx("session", log), { ...state, policy: applied })).toBeUndefined();
		expect(log.titles).toHaveLength(1);
	});

	it("blocks the whole call when the human refuses the location question", async () => {
		const policy = setup(WHITELISTED_CLIS);
		const state = stateFor(policy);
		const log: UiLog = { titles: [], choices: [] };
		const ctx = {
			...stubCtx("session", log),
			ui: {
				...stubCtx("session", log).ui,
				select: async (title: string, options: string[]) => {
					log.titles.push(title);
					// yes to the command, no to the outside path.
					return options[CHOICES.indexOf(log.titles.length === 1 ? "session" : "abort")];
				},
			},
		} as unknown as ExtensionContext;
		const result = await handleToolCall(sh("zsearch -q hi /media/jang/free/CraftGang/x"), ctx, state);
		expect(result?.block).toBe(true);
		expect(log.titles).toHaveLength(2);
	});
});

describe("protected paths stay narrow but grantable", () => {
	it("offers the exact command, never `cat *`, for a read of the gate's own config", () => {
		const policy = setup(WHITELISTED_CLIS);
		const guarded = `${fixture!.agentDir}/extensions/pi-gate/config.json`;
		const decision = decisionFor(policy, "bash", { command: `cat ${guarded} 2>&1 | head -200` });
		expect(decision.stages[0]!.grant!.patterns).toEqual([`cat ${guarded} 2>&1`, `head -200`]);

		const afterCommand = withSessionGrants(policy, toGrantRules(decision.stages[0]!.grant!));
		const second = decisionFor(afterCommand, "bash", { command: `cat ${guarded} 2>&1 | head -200` });
		expect(second.stages.map((stage) => `${stage.stage}:${stage.action}`)).toEqual(["command:allow", "location:ask"]);
		// The boundary rule names the one file, not the folder that holds the gate's code.
		expect(second.stages[1]!.grant!.patterns).toEqual([guarded]);

		const afterBoth = withSessionGrants(afterCommand, toGrantRules(second.stages[1]!.grant!));
		expect(decisionFor(afterBoth, "bash", { command: `cat ${guarded} 2>&1 | head -200` }).action).toBe("allow");
	});

	it("does not let that read grant reach writing the same file", () => {
		const policy = setup(WHITELISTED_CLIS);
		const guarded = `${fixture!.agentDir}/extensions/pi-gate/config.json`;
		const read = decisionFor(policy, "bash", { command: `cat ${guarded}` });
		const granted = withSessionGrants(policy, toGrantRules(read.grant!));
		const write = decisionFor(granted, "edit", { path: guarded, oldText: "a", newText: "b" });
		expect(write.action).toBe("ask");
		// …and its own offer is the exact file on its own surface, which is what makes one click enough.
		expect(write.grant?.patterns).toEqual([guarded]);
		expect(write.grant?.surface).toBe("edit");

		const afterClick = withSessionGrants(granted, toGrantRules(write.grant!));
		expect(decisionFor(afterClick, "edit", { path: guarded, oldText: "a", newText: "b" }).action).toBe("allow");
	});
});
