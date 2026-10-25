/**
 * The wiring in `index.ts` — the only place the "allow everything" switch actually lives.
 *
 * `handle.ts` is tested against a state object it owns; the real extension builds a *fresh* `GateState`
 * per `tool_call`, so the switch survives only through the `allowAllChanged` → closure round trip. That
 * hop is what a human clicks and then judges by the next call, so it is covered here end to end.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import piGate from "../index.ts";
import { clearPolicyCache } from "../policy.ts";
import { gateDoc, makeFixture, writeGlobalConfig, type Fixture } from "./fixture.ts";

let fixture: Fixture | undefined;

/** Dialog option indices, as the human counts them. */
const ONCE = 0;
const ALL_SESSION = 6;
const ALL_TIMED = 7;

interface StubPi {
	pi: ExtensionAPI;
	emit: (event: string, ctx: ExtensionContext, payload: object) => Promise<unknown>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
	statuses: (string | undefined)[];
	notices: string[];
}

function stubPi(): StubPi {
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => Promise<unknown>>>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const statuses: (string | undefined)[] = [];
	const notices: string[] = [];
	const pi = {
		on: (event: string, handler: (event: never, ctx: ExtensionContext) => Promise<unknown>) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => undefined;
		},
		registerFlag: () => undefined,
		getFlag: () => false,
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
		getActiveTools: () => ["bash", "read", "edit"],
		getAllTools: () => [{ name: "bash" }, { name: "read" }, { name: "edit" }],
		setActiveTools: () => undefined,
	} as unknown as ExtensionAPI;
	return {
		pi,
		commands,
		statuses,
		notices,
		emit: async (event, ctx, payload) => {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = await handler(payload as never, ctx);
			return result;
		},
	};
}

function stubCtx(choice: number, log: { titles: string[] }, stub: StubPi): ExtensionContext {
	return {
		cwd: fixture?.cwd ?? "/repo",
		mode: "tui",
		hasUI: true,
		signal: new AbortController().signal,
		isProjectTrusted: () => true,
		ui: {
			select: async (title: string, options: string[]) => {
				log.titles.push(title);
				return options[choice];
			},
			input: async () => "x",
			notify: (message: string) => stub.notices.push(message),
			setStatus: (_key: string, text?: string) => stub.statuses.push(text),
		},
	} as unknown as ExtensionContext;
}

const call = (toolName: string, input: Record<string, unknown>, callId: string): ToolCallEvent =>
	({ type: "tool_call", toolCallId: callId, toolName, input }) as ToolCallEvent;

const ASK_ALL: unknown = { "*": "ask", path: { "*": "allow" }, bash: { "*": "ask" }, external_directory: "ask" };

/** Boot the real extension on a temp agent dir + project, and start one session. */
async function boot(permission: unknown = ASK_ALL): Promise<{ stub: StubPi; log: { titles: string[] } }> {
	fixture = makeFixture();
	writeGlobalConfig(fixture, gateDoc(permission));
	clearPolicyCache();
	const stub = stubPi();
	piGate(stub.pi);
	const log = { titles: [] as string[] };
	await stub.emit("session_start", stubCtx(ONCE, log, stub), { type: "session_start" });
	return { stub, log };
}

/** One gated tool call, answered with `choice`. */
async function answer(stub: StubPi, log: { titles: string[] }, choice: number, event: ToolCallEvent): Promise<unknown> {
	return stub.emit("tool_call", stubCtx(choice, log, stub), event);
}

afterEach(() => {
	fixture?.cleanup();
	fixture = undefined;
	clearPolicyCache();
});

describe("extension wiring keeps the switch it was given", () => {
	it("carries allow-everything across calls, to calls that are not the one it was clicked on", async () => {
		const { stub, log } = await boot();
		await answer(stub, log, ALL_SESSION, call("bash", { command: "git commit -m x" }, "c1"));
		expect(log.titles).toHaveLength(1);
		expect(stub.notices.join("\n")).toContain("allow-everything is ON");

		for (const [id, command] of [["c2", "npm publish"], ["c3", "npx vitest run"], ["c4", "rm -rf build"], ["c5", "cat /etc/hosts"]] as const) {
			expect(await answer(stub, log, ONCE, call("bash", { command }, id))).toBeUndefined();
		}
		expect(await answer(stub, log, ONCE, call("edit", { path: "src/a.ts" }, "c6"))).toBeUndefined();
		expect(log.titles).toHaveLength(1);
		expect(stub.statuses.at(-1)).toContain("allow-everything: session");
	});

	it("still asks for the gate's own config, and says why, while everything else is silenced", async () => {
		const { stub, log } = await boot();
		await answer(stub, log, ALL_SESSION, call("bash", { command: "ls" }, "c1"));
		expect(log.titles).toHaveLength(1);

		// reading pi's config is silenced; editing the gate's own config is not
		expect(await answer(stub, log, ONCE, call("read", { path: `${fixture?.agentDir}/settings.json` }, "c2"))).toBeUndefined();
		expect(log.titles).toHaveLength(1);
		expect(await answer(stub, log, ONCE, call("edit", { path: `${fixture?.agentDir}/extensions/pi-gate/config.json` }, "c3"))).toBeUndefined();
		expect(log.titles).toHaveLength(2);
		expect(log.titles[1]).toContain("protected_path");
		expect(log.titles[1]).toContain("allow-everything is ON");
	});

	it("closes the timed window on its own", async () => {
		const { stub, log } = await boot();
		await answer(stub, log, ALL_TIMED, call("bash", { command: "ls" }, "c1"));
		expect(log.titles).toHaveLength(1);
		expect(await answer(stub, log, ONCE, call("bash", { command: "pwd" }, "c2"))).toBeUndefined();
		expect(log.titles).toHaveLength(1);
		expect(stub.statuses.at(-1)).toMatch(/allow-everything: \d+s/);
	});

	it("clears the switch on a new session", async () => {
		const { stub, log } = await boot();
		await answer(stub, log, ALL_SESSION, call("bash", { command: "ls" }, "c1"));
		expect(log.titles).toHaveLength(1);
		await stub.emit("session_start", stubCtx(ONCE, log, stub), { type: "session_start", reason: "new" });
		await answer(stub, log, ONCE, call("bash", { command: "pwd" }, "c2"));
		expect(log.titles).toHaveLength(2);
	});

	it("turns the switch back off from /gate allow off", async () => {
		const { stub, log } = await boot();
		await answer(stub, log, ALL_SESSION, call("bash", { command: "ls" }, "c1"));
		expect(log.titles).toHaveLength(1);
		await stub.commands.get("gate")?.handler("allow off", stubCtx(ONCE, log, stub));
		await answer(stub, log, ONCE, call("bash", { command: "pwd" }, "c2"));
		expect(log.titles).toHaveLength(2);
	});

	it("shows the full call in the dialog title, never a truncation marker", async () => {
		const { stub, log } = await boot();
		const command = `echo ${"p".repeat(400)} && cat pi-gate/prompt.ts && echo ${"q".repeat(400)}`;
		await answer(stub, log, ONCE, call("bash", { command }, "c1"));
		expect(log.titles[0]).toContain(command);
		expect(log.titles[0]).not.toContain("truncated");
	});
});
