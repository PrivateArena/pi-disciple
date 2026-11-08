/**
 * The output guard (`guard.ts`): the tool call the model wrote as text instead of making.
 *
 * Two halves, and both matter. The positive half is the shapes a broken emission really takes — including the
 * transcript that motivated the guard. The negative half is what the guard must *not* fire on, because a false
 * positive costs the same thing the guard saves: a turn the model did not intend to spend.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import {
	activeRuleIds,
	assistantText,
	builtinRuleIds,
	createGuardBudget,
	detectMalformedCall,
	GUARD_MESSAGE_TYPE,
	guardTurnEnd,
	refillGuardBudget,
	reminderText,
	resetGuardCounters,
	resetGuardSession,
	stripCode,
	type GuardTurnState,
} from "../guard.ts";
import { clearPolicyCache, loadPolicy, type Policy } from "../policy.ts";
import { GUARD_BUILTIN_RULE_IDS, parseGuardConfig, DEFAULT_GUARD_CONFIG, type GuardConfig } from "../schema.ts";

/** What the guard runs with when a file wrote only what the test names. */
function parse(raw: unknown, errors: string[] = []): GuardConfig {
	return { ...DEFAULT_GUARD_CONFIG, ...parseGuardConfig(raw, "test", errors) };
}
import { makeFixture, writeGlobalConfig, writeProjectConfig, type Fixture } from "./fixture.ts";

let fixture: Fixture | undefined;

function guardPolicy(guard: unknown, extra: Record<string, unknown> = {}): Policy {
	fixture = makeFixture();
	writeGlobalConfig(fixture, { gate: { enabled: true, permission: { "*": "allow" }, guard, ...extra } });
	clearPolicyCache();
	return loadPolicy(fixture.cwd, true, fixture.agentDir);
}

const CONFIG = DEFAULT_GUARD_CONFIG;

function detect(text: string, options: Partial<GuardConfig> & { thinking?: string; toolNames?: string[] } = {}) {
	const { thinking = "", toolNames = ["bash", "read", "edit", "write", "grep", "subagent"], ...rest } = options;
	const config: GuardConfig = { ...CONFIG, ...rest, rules: rest.rules ?? [], disableRules: rest.disableRules ?? [] };
	return detectMalformedCall({ text, thinking, toolNames: new Set(toolNames.map((n) => n.toLowerCase())), config });
}

// ---------------------------------------------------------------------------
// the shapes that are a leaked call
// ---------------------------------------------------------------------------

describe("guard: detecting a call written as text", () => {
	it("catches the reported transcript: an envelope whose body died at a bare '<'", () => {
		// Verbatim from a qwen3.8-flash-next turn that ended with stopReason "stop" and no tool call.
		const text = "<tool_call>\n<\n</function>\n</tool_call>";
		const hit = detect(text);
		expect(hit?.rules).toContain("call-tag");
		expect(hit?.evidence).toContain("<tool_call>");
		expect(reminderText(hit!, false)).toMatch(/nothing ran/);
	});

	it("catches an XML envelope naming the tool and its parameters", () => {
		const hit = detect('Let me read that.\n<tool_call>\n<function=read>\n<parameter=path>src/a.ts</parameter>\n</function>\n</tool_call>');
		expect(hit?.rules).toContain("call-tag");
	});

	it("catches the <invoke name=…> dialect", () => {
		expect(detect('<invoke name="bash"><parameter=command>ls -la</parameter></invoke>')?.rules).toContain("call-tag");
	});

	it("catches an antml-namespaced parameter block", () => {
		expect(detect("<antml:function_calls>\n<antml:invoke name=\"read\">\n<antml:parameter name=\"path\">x.ts</antml:parameter>")?.rules).toContain("call-tag");
	});

	it("catches a call cut off inside its own tag", () => {
		const hit = detect("Writing the file now.\n<tool_cal");
		expect(hit?.rules).toContain("call-fragment");
	});

	it("catches a message that stops at the '<' that opens the next tag", () => {
		expect(detect('{"name": "edit", "arguments": {"path": "a.ts"}} and then <')?.rules.length ?? 0).toBeGreaterThan(0);
	});

	it("catches a tag named after one of the session's own tools", () => {
		expect(detect("<bash command=\"npm test\"></bash>")?.rules).toContain("tool-name-tag");
		expect(detect("<read path=\"src/a.ts\">")?.rules).toContain("tool-name-tag");
	});

	it("catches a message that ends on an open tag", () => {
		expect(detect("Reading the file now:\n<tool_call>")?.rules).toContain("call-tag");
	});

	it("catches a closing tag nobody opened", () => {
		expect(detect("and that is the plan.\n</tool_call>")?.rules).toContain("call-tag");
	});

	it("catches a JSON call that ends the message", () => {
		const hit = detect('Sure — calling it now: {"name": "bash", "arguments": {"command": "npm test"}}');
		expect(hit?.rules).toContain("json-call");
	});

	it("catches OpenAI's nested function envelope written as text", () => {
		expect(detect('{"type": "function", "function": {"name": "edit", "arguments": {"path": "a.ts"}}}')?.rules).toContain("json-call");
	});

	it("catches a truncated JSON call", () => {
		const hit = detect('Now I will run it. {"name": "bash", "arguments": {"command": "grep -rn "guard" pi-gate/g');
		expect(hit?.rules).toContain("json-call-truncated");
		expect(reminderText(hit!, true)).toMatch(/cut off/);
	});

	it("catches a raw call token of the model's protocol", () => {
		expect(detect("<|tool_call|>bash <|args|> npm test")?.rules).toContain("special-token");
		expect(detect("working on it: [tool_call]")?.rules).toContain("special-token");
	});

	it("catches a chat-template token left in the open", () => {
		expect(detect("and the next step is:\n<|im_start|>assistant\n")?.rules).toContain("chat-template-token");
	});

	it("catches reasoning that stops on the markup when the message has no text", () => {
		const hit = detect("", { thinking: 'The file needs one edit. Now emitting\n<parameter name="path">a.ts</parameter>' });
		expect(hit?.rules).toContain("call-in-thinking");
	});

	it("reports every rule that fired, not only the first", () => {
		const hit = detect("<tool_call>\n<\n</function>\n</tool_call>\n<|tool_call|>");
		expect(hit?.rules).toEqual(expect.arrayContaining(["call-tag", "special-token"]));
	});

	it("keeps the evidence short, single-line and redacted where redaction applies", () => {
		const hit = detect(`{"name": "bash", "arguments": {"command": "export API_KEY=super-secret-123 && ${"x".repeat(400)}"}}`);
		expect(hit?.evidence.length).toBeLessThanOrEqual(160 + " […truncated]".length);
		expect(hit?.evidence).not.toMatch(/\n/);
		expect(hit?.evidence).toContain("<redacted>");
		expect(hit?.evidence).not.toContain("super-secret");
	});
});

// ---------------------------------------------------------------------------
// the shapes that are not
// ---------------------------------------------------------------------------

describe("guard: what it must never fire on", () => {
	it("ignores a call example inside a fenced block", () => {
		expect(detect("The broken emission looks like this:\n\n```\n<tool_call>\n<\n</function>\n```\n\nand the fix is in guard.ts.")?.rules).toBeUndefined();
	});

	it("ignores an inline-code mention of the markup", () => {
		expect(detect("We should detect `<tool_call>` and `<invoke name=` in the text channel.")?.rules).toBeUndefined();
	});

	it("ignores one balanced tag named in a sentence", () => {
		expect(detect("The model wrote a tool_call element and Pi ignored it, because <tool_call> is only markup.")?.rules).toBeUndefined();
	});

	it("ignores ordinary HTML and comparisons", () => {
		expect(detect("Use `<div>` for the wrapper, and remember that `a < b` in CSS means specificity.")?.rules).toBeUndefined();
		expect(detect("The plan: if 5 < 6 we ship.\n\nDone — nothing else to run.")?.rules).toBeUndefined();
	});

	it("ignores a message about this very guard", () => {
		const text = [
			"The line `\"text\":\"<tool_call>\\n<\\n</function>\\n</tool_call>\"` is malformed,",
			"so we want a rule matching `<tool_call>` and `<parameter name=`.",
		].join("\n");
		expect(detect(text)).toBeUndefined();
	});

	it("ignores a balanced JSON object that is not a call", () => {
		expect(detect('The config is now {"enabled": true, "action": "remind"}')?.rules).toBeUndefined();
	});

	it("ignores a truncated quote that is not call-shaped", () => {
		expect(detect("The settings block reads: {\"theme\": \"dark\", \"language\": \"en\" (cut off by the reader)")?.rules).toBeUndefined();
	});

	it("ignores a tool-name tag with no arguments and no body", () => {
		expect(detect("Wrap the value in <read> tags if you like, but it changes nothing.")?.rules).toBeUndefined();
	});

	it("ignores a table of prose that happens to name tools", () => {
		expect(detect("<table><tr><td>read</td><td>the file</td></tr><tr><td>bash</td><td>the tests</td></tr></table>")?.rules).toBeUndefined();
	});

	it("ignores angle-bracket addresses", () => {
		expect(detect("Contact <support@example.com> and CC <team@example.com>, then stop.")?.rules).toBeUndefined();
	});

	it("keeps reading a report that was cut off inside a code fence", () => {
		expect(detect("Here is the component:\n\n```tsx\nexport function App() {\n  return <div>hello")?.rules).toBeUndefined();
	});

	it("ignores a config example at the end of a message, even with an \"action\" key", () => {
		expect(detect('Set the block to:\n\n{"enabled": true, "action": "remind", "maxReminders": 3}')?.rules).toBeUndefined();
	});

	it("ignores thinking that discusses calls when the message answers properly", () => {
		const thinking = 'I should call read, then edit, emitting <tool_call> with a <parameter name="path">.';
		expect(detect("Done — all 546 tests pass.", { thinking })?.rules).toBeUndefined();
	});

	it("ignores a message that quotes the guard's own reminder", () => {
		expect(detect("The note read: Malformed tool call: a tool call was written as markup — and that is fixed.")?.rules).toBeUndefined();
	});

	it("ignores a sentence that ends on a bare '<'", () => {
		expect(detect("Compare the sizes: the big one is <")?.rules).toBeUndefined();
	});

	it("still reads a leak sitting inside an unterminated fence", () => {
		// An emission cut off mid-message stops *inside* a fence, so an unclosed fence is not documentation.
		expect(detect("The emission looks like:\n```\n<tool_call>\n<function=read>\n<parameter=path>a")?.rules).toContain("call-tag");
	});

	it("still reads a stray <parameter name=…> with no envelope", () => {
		expect(detect('Setting the path:\n<parameter name="path">src/a.ts')?.rules).toContain("call-tag");
	});

	it("still reads an OpenAI-style nested envelope with its tail cut off", () => {
		expect(detect('{"function": {"name": "bash", "arguments": {"command": "np')?.rules).toContain("json-call-truncated");
	});

	it("looks only at the tail it is configured to read", () => {
		const padding = "x".repeat(CONFIG.scanTailChars + 500);
		expect(detect(`${padding}\n\nAnswer: the work is complete.`)?.rules).toBeUndefined();
	});

	it("respects matchToolNames: false", () => {
		expect(detect("<bash command=\"npm test\"></bash>", { matchToolNames: false })?.rules).toBeUndefined();
	});

	it("respects checkEmptyThinking: false", () => {
		const options = { checkEmptyThinking: false, thinking: 'Now emitting\n<parameter name="path">a.ts</parameter>' };
		expect(detect("", options)).toBeUndefined();
	});
});

describe("guard: configuration is the veto", () => {
	it("lets a disabled rule through", () => {
		expect(detect("<tool_call>\n<\n</function>\n</tool_call>", { disableRules: ["call-tag", "call-fragment"] })?.rules).toBeUndefined();
	});

	it("lets a human pattern veto the whole turn", () => {
		expect(detect(BROKEN, { allowPatterns: ["*tool_call*"] })).toBeUndefined();
		expect(detect(BROKEN, { allowPatterns: ["re:tool_call|invoke"] })).toBeUndefined();
		expect(detect(BROKEN, { allowPatterns: ["re:nothing-here"] })).toBeDefined();
	});

	it("runs a configured rule of the human's own", () => {
		const hit = detect("STEP 1: run the bash tool please", { rules: [{ id: "please-run", pattern: "*run the bash tool*" }] });
		expect(hit?.rules).toContain("please-run");
		expect(reminderText(hit!, false)).toMatch(/STEP 1/);
	});

	it("matches a configured re: rule unanchored", () => {
		expect(detect("final answer: 42", { rules: [{ id: "forty-two", pattern: "re:4\\d", label: "an odd answer" }] })?.label).toBe("an odd answer");
	});

	it("reports a rule id that shadows a built-in as a separate hit", () => {
		const errors: string[] = [];
		const guard = parse({ rules: [{ id: "call-tag", pattern: "*" }] }, errors);
		expect(guard.rules).toHaveLength(1);
		expect(errors.join("\n")).toMatch(/is a built-in guard rule/);
	});
});

// ---------------------------------------------------------------------------
// the pipeline
// ---------------------------------------------------------------------------

function turnEnd(over: Partial<TurnEndEvent> & { text?: string; thinking?: string } = {}): TurnEndEvent {
	const content: unknown[] = [];
	if (over.thinking) content.push({ type: "thinking", thinking: over.thinking });
	if (over.text !== undefined) content.push({ type: "text", text: over.text });
	return {
		type: "turn_end",
		turnIndex: 3,
		outcome: "completed",
		toolResults: [],
		messageEntryId: "entry-1",
		toolResultEntryIds: [],
		entries: [],
		continue: false,
		context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
		message: {
			role: "assistant",
			content,
			api: "openai-completions",
			provider: "local",
			model: "qwen3.8-flash-next",
			stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			timestamp: 0,
		},
		...over,
	} as unknown as TurnEndEvent;
}

interface Log {
	notices: string[];
	logged: unknown[];
}

function ctx(): { ctx: ExtensionContext; log: Log } {
	const log: Log = { notices: [], logged: [] };
	return {
		log: log,
		ctx: {
			cwd: fixture?.cwd ?? "/repo",
			mode: "tui",
			hasUI: true,
			signal: new AbortController().signal,
			isProjectTrusted: () => true,
			ui: {
				notify: (message: string) => log.notices.push(message),
				setStatus: () => undefined,
				select: async () => undefined,
				editor: async () => undefined,
			},
		} as unknown as ExtensionContext,
	};
}

function state(policy: Policy, budget = createGuardBudget()): GuardTurnState {
	return { policy, toolNames: new Set(["bash", "read", "edit"]), budget };
}

const BROKEN = "<tool_call>\n<\n</function>\n</tool_call>";

function run(policy: Policy, event: TurnEndEvent, budget = createGuardBudget()) {
	const { ctx: context, log } = ctx();
	const deps = { guardLog: async (_path: string, entry: unknown) => void log.logged.push(entry), logPath: () => "/tmp/guard.jsonl" };
	const result = guardTurnEnd(event, context, state(policy, budget), deps);
	return { result, log, budget };
}

describe("guard: the turn_end pipeline", () => {
	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it("appends a reminder and asks for another turn", () => {
		const { result, log, budget } = run(guardPolicy(undefined), turnEnd({ text: BROKEN }));
		expect(result?.continue).toBe(true);
		const entry = result?.entries?.[0];
		expect(entry?.type).toBe("custom_message");
		expect(result?.entries).toHaveLength(1);
		if (entry?.type === "custom_message") {
			expect(entry.customType).toBe(GUARD_MESSAGE_TYPE);
			expect(entry.display).toBe(true);
			expect(JSON.stringify(entry.content)).toMatch(/harness's tool interface/);
		}
		expect(budget.reminders).toBe(1);
		expect(log.notices.join("\n")).toMatch(/reminded the agent/);
		expect(log.logged).toHaveLength(1);
	});

	it("does not remind the same message twice", () => {
		const policy = guardPolicy(undefined);
		const budget = createGuardBudget();
		expect(run(policy, turnEnd({ text: BROKEN }), budget).result?.continue).toBe(true);
		expect(run(policy, turnEnd({ text: BROKEN }), budget).result).toBeUndefined();
	});

	it("stops reminding once the budget is spent, and says so", () => {
		const policy = guardPolicy({ maxReminders: 2 });
		const budget = createGuardBudget();
		for (const id of ["a", "b", "c"]) {
			const { result, log } = run(policy, turnEnd({ text: BROKEN, messageEntryId: `entry-${id}` }), budget);
			if (id === "c") {
				expect(result).toBeUndefined();
				expect(log.notices.join("\n")).toMatch(/budget spent/);
			}
		}
		expect(budget.reminders).toBe(2);
	});

	it("a real tool call refills the budget", () => {
		const policy = guardPolicy({ maxReminders: 1 });
		const budget = createGuardBudget();
		expect(run(policy, turnEnd({ text: BROKEN, messageEntryId: "one" }), budget).result?.continue).toBe(true);
		expect(run(policy, turnEnd({ text: BROKEN, messageEntryId: "two" }), budget).result).toBeUndefined();
		refillGuardBudget(budget);
		expect(run(policy, turnEnd({ text: BROKEN, messageEntryId: "three" }), budget).result?.continue).toBe(true);
	});

	it("leaves an answer alone", () => {
		const { result, log } = run(guardPolicy(undefined), turnEnd({ text: "The guard is in `pi-gate/guard.ts` and the tests pass." }));
		expect(result).toBeUndefined();
		expect(log.notices).toHaveLength(0);
	});

	it("does not touch a turn that ran tools, an aborted turn, or an errored one", () => {
		const policy = guardPolicy(undefined);
		expect(run(policy, turnEnd({ text: BROKEN, toolResults: [{} as never] })).result).toBeUndefined();
		expect(run(policy, turnEnd({ text: BROKEN, outcome: "aborted" })).result).toBeUndefined();
		expect(run(policy, turnEnd({ text: BROKEN, outcome: "error" })).result).toBeUndefined();
		expect(run(policy, turnEnd({ text: BROKEN, message: { ...turnEnd().message, stopReason: "aborted" } as never })).result).toBeUndefined();
	});

	it("action notify reports to the human without continuing the run", () => {
		const { result, log, budget } = run(guardPolicy({ action: "notify" }), turnEnd({ text: BROKEN }));
		expect(result).toBeUndefined();
		expect(budget.reminders).toBe(0);
		expect(log.notices.join("\n")).toMatch(/noticed/);
		expect(log.logged[0]).toMatchObject({ action: "notify", kind: "malformed-tool-call" });
	});

	it("off means off", () => {
		expect(run(guardPolicy({ action: "off" }), turnEnd({ text: BROKEN })).log.notices).toHaveLength(0);
		expect(run(guardPolicy({ enabled: false }), turnEnd({ text: BROKEN })).log.notices).toHaveLength(0);
	});

	it("a session override beats the config, in both directions", () => {
		const budget = createGuardBudget();
		budget.action = "off";
		expect(run(guardPolicy(undefined), turnEnd({ text: BROKEN }), budget).log.notices).toHaveLength(0);
		const quiet = createGuardBudget();
		quiet.action = "remind";
		expect(run(guardPolicy({ action: "notify" }), turnEnd({ text: BROKEN }), quiet).result?.continue).toBe(true);
	});

	it("a session-disabled rule is not consulted", () => {
		const budget = createGuardBudget();
		budget.disabled.add("call-tag");
		budget.disabled.add("call-fragment");
		expect(run(guardPolicy(undefined), turnEnd({ text: BROKEN }), budget).result).toBeUndefined();
	});

	it("resets clear what they say they clear", () => {
		const budget = createGuardBudget();
		budget.reminders = 2;
		budget.seen.add("x");
		budget.disabled.add("call-tag");
		budget.action = "notify";
		resetGuardCounters(budget);
		expect(budget.reminders).toBe(0);
		expect(budget.seen.size).toBe(0);
		expect(budget.disabled.size).toBe(1);
		budget.reminders = 1;
		resetGuardSession(budget);
		expect(budget.disabled.size).toBe(0);
		expect(budget.action).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// config plumbing
// ---------------------------------------------------------------------------

describe("guard: config", () => {
	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it("ships a default that is on, reminds, and reads 4096 characters", () => {
		const policy = guardPolicy(undefined);
		expect(policy.config.guard).toMatchObject({ enabled: true, action: "remind", maxReminders: 3, scanTailChars: 4096, matchToolNames: true });
	});

	it("lists exactly the rule ids the parser will accept", () => {
		expect([...builtinRuleIds()].sort()).toEqual([...GUARD_BUILTIN_RULE_IDS].sort());
	});

	it("reports a rule id it does not know instead of silently doing nothing", () => {
		const errors: string[] = [];
		const guard = parse({ disableRules: ["call-tag", "nope"] }, errors);
		expect(guard.disableRules).toEqual(["call-tag"]);
		expect(errors.join("\n")).toMatch(/names "nope", which is not a built-in guard rule/);
	});

	it("refuses a bad pattern, a bad action and a bad budget, each on its own", () => {
		const errors: string[] = [];
		const guard = parse({ action: "yell", maxReminders: -1, scanTailChars: 10, rules: [{ id: "bad", pattern: "re:(a+)+" }, { pattern: "" }], allowPatterns: ["re:("] }, errors);
		expect(guard.action).toBe("remind");
		expect(guard.maxReminders).toBe(3);
		expect(guard.scanTailChars).toBe(4096);
		expect(guard.rules).toHaveLength(0);
		expect(guard.allowPatterns).toHaveLength(0);
		expect(errors).toHaveLength(6);
	});

	it("caps the scanned tail at the regex probe budget rather than blinding re: rules", () => {
		const errors: string[] = [];
		const guard = parse({ scanTailChars: 100_000 }, errors);
		expect(guard.scanTailChars).toBe(4096);
		expect(errors.join("\n")).toMatch(/capped/);
	});

	it("concatenates rule lists across the global and project files, last-wins on the scalars", () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, { gate: { permission: { "*": "allow" }, guard: { maxReminders: 5, rules: [{ id: "global-rule", pattern: "a*" }], allowPatterns: ["keep"] } } });
		writeProjectConfig(fixture, { gate: { guard: { action: "notify", rules: [{ id: "project-rule", pattern: "b*" }], allowPatterns: ["also-keep"], disableRules: ["call-tag"] } } });
		clearPolicyCache();
		const guard = loadPolicy(fixture.cwd, true, fixture.agentDir).config.guard;
		expect(guard.action).toBe("notify");
		expect(guard.maxReminders).toBe(5);
		expect(guard.rules.map((rule) => rule.id)).toEqual(["global-rule", "project-rule"]);
		expect(guard.allowPatterns).toEqual(["keep", "also-keep"]);
		expect(guard.disableRules).toEqual(["call-tag"]);
	});

	it("names the rules that are live, for /gatec", () => {
		const guard = guardPolicy({ disableRules: ["tool-name-tag"], rules: [{ id: "mine", pattern: "*" }] }).config.guard;
		const ids = activeRuleIds(guard, new Set(["special-token"]));
		expect(ids).not.toContain("tool-name-tag");
		expect(ids).not.toContain("special-token");
		expect(ids).toContain("call-tag");
		expect(ids).toContain("mine");
		expect(activeRuleIds({ ...guard, checkEmptyThinking: false })).not.toContain("call-in-thinking");
	});
});

describe("guard: helpers", () => {
	it("keeps an unterminated fence scannable, and drops a closed one", () => {
		expect(stripCode("```json\n{\"a\": 1}\n```")).not.toContain("a\": 1");
		expect(stripCode("```\n<tool_call>")).toContain("<tool_call>");
		expect(stripCode("use `code` here")).not.toContain("code");
	});

	it("reads the text blocks of a message and nothing else", () => {
		const event = turnEnd({ text: "one", thinking: "two" });
		expect(assistantText(event.message as never)).toBe("one");
	});
});
