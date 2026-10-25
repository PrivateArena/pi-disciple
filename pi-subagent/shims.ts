/**
 * Shim tools (plan step 12) — the security hinge of the whole design.
 *
 * The child session registers a shim for every tool its role may use, under the *built-in tool's
 * own name*, so pi's registry replaces the built-in with the shim (customTools override built-ins by
 * name). Each shim forwards to the parent's `ExtensionToolContext.executeTool()`, which runs the call
 * "through the same validation, hooks, and permission checks as model-issued calls" — so the parent's
 * `tool_call` handlers (pi-gate) see it with `parentToolCallId = <subagentCallId>/<n>`, and a denial
 * arrives at the child's model as an `isError` result. No permission code exists in this extension.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Role } from "./roles.ts";
import type { SubagentLimits } from "../pi-gate/schema.ts";

export interface ShimHost {
	/** Id of the parent's `subagent` tool call; nested calls get `<this>/<n>`. */
	parentCallId: string;
	executeTool: ExtensionToolContext["executeTool"];
	/** Observes every nested call for progress reporting and the 256-call ceiling. */
	onNestedCall?: (toolName: string) => void;
}

/**
 * pi records at most this many nested calls per model-issued call (`NESTED_CALL_LIMITS.maxCalls`);
 * beyond it the record is dropped, so the child is told to conclude instead of looping blindly (FM-13).
 */
export const NESTED_CALL_CEILING = 256;

/** One tail promise per child run: every nested call is dequeued strictly in order (FM-4). */
export function createQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(fn, fn);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}

/**
 * Tools a child must never reach, whatever the role says: `subagent` (recursion) and `codemode` /
 * `tool_search` (they reach registered tools by name, bypassing the role's allowlist).
 */
export const FORBIDDEN_CHILD_TOOLS: readonly string[] = ["subagent", "codemode", "tool_search"];

export function isDeniedByLimit(name: string, _limits?: SubagentLimits): boolean {
	return FORBIDDEN_CHILD_TOOLS.includes(name);
}

/** Role filter: `"*"` means every parent-callable tool except {@link FORBIDDEN_CHILD_TOOLS}. */
export function isAllowedForRole(name: string, role: Role): boolean {
	if (isDeniedByLimit(name)) return false;
	return role.allowTools.includes("*") || role.allowTools.includes(name);
}

export function buildShims(
	tools: readonly AgentTool[],
	role: Role,
	host: ShimHost,
	_limits?: SubagentLimits,
): ToolDefinition[] {
	const queue = createQueue();
	const shims: ToolDefinition[] = [];
	for (const tool of tools) {
		const name = tool.name;
		if (isDeniedByLimit(name) || !isAllowedForRole(name, role)) continue;
		shims.push(makeShim(tool, name, host, queue));
	}
	if (shims.length === 0) {
		// FM-1: an empty shim set would leave the child with the real built-in tools.
		throw new Error(`pi-subagent: role "${role.name}" resolved to no tools (nothing is callable in the parent session)`);
	}
	const missing = shims.filter((shim) => !tools.some((tool) => tool.name === shim.name));
	if (missing.length) throw new Error(`pi-subagent: shim source lost for ${missing.map((t) => t.name).join(", ")}`);
	return shims;
}

function makeShim(tool: AgentTool, name: string, host: ShimHost, queue: <T>(fn: () => Promise<T>) => Promise<T>): ToolDefinition {
	return {
		name,
		label: tool.label ?? name,
		description: tool.description,
		parameters: tool.parameters,
		// Nested calls are serialised by the queue anyway; declaring it keeps pi's own scheduler honest.
		executionMode: "sequential",
		execute: (_toolCallId, args, signal, onUpdate) =>
			queue(async () => {
				host.onNestedCall?.(name);
				const outcome = await host.executeTool(name, args, { signal, onUpdate });
				const result: AgentToolResult<unknown> = outcome.result ?? { content: [{ type: "text", text: "" }], details: undefined };
				// A blocked or failing nested call comes back as `isError`, never as a rejection (A2).
				return outcome.isError ? { ...result, isError: true } : result;
			}),
	};
}
