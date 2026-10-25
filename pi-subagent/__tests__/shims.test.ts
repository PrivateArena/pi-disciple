import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import { buildShims, createQueue, FORBIDDEN_CHILD_TOOLS, isDeniedByLimit, NESTED_CALL_CEILING } from "../shims.ts";
import { ROLES } from "../roles.ts";
import type { ShimHost } from "../shims.ts";

const tool = (name: string, extra: Partial<AgentTool> = {}): AgentTool =>
	({
		name,
		label: name,
		description: `the ${name} tool`,
		parameters: { type: "object", properties: { path: { type: "string" } } },
		execute: async () => ({ content: [{ type: "text", text: name }], details: undefined }),
		...extra,
	}) as unknown as AgentTool;

const parentTools = [tool("read"), tool("write"), tool("bash"), tool("edit"), tool("grep"), tool("subagent"), tool("codemode")];

function outcome(text: string, isError = false): AgentToolCallOutcome {
	return { toolCall: { type: "toolCall", id: "x", name: "read", arguments: {} }, result: { content: [{ type: "text", text }], details: undefined }, isError } as unknown as AgentToolCallOutcome;
}

afterEach(() => vi.useRealTimers());

describe("buildShims", () => {
	it("copies name, description and parameter schema verbatim", () => {
		const host: ShimHost = { parentCallId: "P", executeTool: async () => outcome("ok") };
		const shims = buildShims(parentTools, ROLES["general-purpose"], host);
		const read = shims.find((shim) => shim.name === "read");
		expect(read?.description).toBe("the read tool");
		expect(read?.parameters).toBe(parentTools[0]?.parameters);
		expect(read?.executionMode).toBe("sequential");
	});

	it("never exposes a nested delegation or escape hatch", () => {
		const host: ShimHost = { parentCallId: "P", executeTool: async () => outcome("ok") };
		const names = buildShims(parentTools, ROLES["general-purpose"], host).map((shim) => shim.name);
		for (const forbidden of FORBIDDEN_CHILD_TOOLS) expect(names).not.toContain(forbidden);
		expect(isDeniedByLimit("subagent")).toBe(true);
	});

	it("restricts a read-only role to its declared tools", () => {
		const host: ShimHost = { parentCallId: "P", executeTool: async () => outcome("ok") };
		const names = buildShims(parentTools, ROLES.explore, host).map((shim) => shim.name).sort();
		expect(names).toEqual(["bash", "grep", "read"]);
	});

	it("throws rather than handing the child the real built-ins (FM-1)", () => {
		const host: ShimHost = { parentCallId: "P", executeTool: async () => outcome("ok") };
		expect(() => buildShims([tool("subagent")], ROLES.explore, host)).toThrow(/no tools/);
	});

	it("forwards the tool call to the parent pipeline and keeps the denial reason", async () => {
		const executeTool = vi.fn(async () => outcome('[gate] Blocked by the user: rm -rf build. Do not retry it.', true));
		const host: ShimHost = { parentCallId: "P", executeTool };
		const shim = buildShims(parentTools, ROLES.explore, host).find((s) => s.name === "bash")!;
		const result = await shim.execute("child-id", { command: "rm -rf build" }, undefined, undefined, {} as never);
		expect(executeTool).toHaveBeenCalledWith("bash", { command: "rm -rf build" }, expect.objectContaining({}));
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text?: string })?.text).toMatch(/\[gate\] Blocked by the user/);
	});

	it("counts nested calls for the 256 ceiling", async () => {
		const seen: string[] = [];
		const host: ShimHost = { parentCallId: "P", executeTool: async () => outcome("ok"), onNestedCall: (name) => seen.push(name) };
		const shims = buildShims(parentTools, ROLES.explore, host);
		await shims[0]!.execute("c", {}, undefined, undefined, {} as never);
		await shims[1]!.execute("c", {}, undefined, undefined, {} as never);
		expect(seen).toEqual(["read", "bash"]);
		expect(NESTED_CALL_CEILING).toBe(256);
	});
});

describe("createQueue", () => {
	it("serialises concurrent tool executions in submission order", async () => {
		const events: string[] = [];
		const queue = createQueue();
		const slow = (label: string, ms: number) => queue(async () => {
			events.push(`start ${label}`);
			await new Promise((resolve) => setTimeout(resolve, ms));
			events.push(`end ${label}`);
			return label;
		});
		const results = await Promise.all([slow("a", 20), slow("b", 1), slow("c", 5)]);
		expect(results).toEqual(["a", "b", "c"]);
		expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
	});

	it("keeps the queue alive after a rejection", async () => {
		const queue = createQueue();
		await expect(queue(async () => { throw new Error("nope"); })).rejects.toThrow("nope");
		await expect(queue(async () => "still working")).resolves.toBe("still working");
	});
});

describe("child options", () => {
	it("lists every shim name in the tool allowlist", () => {
		const host: ShimHost = { parentCallId: "P", executeTool: async () => outcome("ok") };
		const shims = buildShims(parentTools, ROLES["general-purpose"], host);
		const options: CreateAgentSessionOptions = { tools: shims.map((shim) => shim.name), customTools: shims };
		expect(options.tools).toEqual(["read", "write", "bash", "edit", "grep"]);
		expect(options.customTools).toHaveLength(shims.length);
	});
});
