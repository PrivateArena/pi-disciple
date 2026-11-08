/**
 * child-messages.ts — reading the messages a child left behind: what a (possibly partial) assistant message
 * carries, how much of the context window the last response occupied, whether the run died on a provider
 * error, what its report is, and what it cost.
 *
 * Every function here is pure — messages in, an answer out — so the transcript can be re-read by a test or a
 * renderer without a session. Split out of `child.ts`, which keeps re-exporting `totalUsage` as its facade
 * (that was the only public name) and imports the rest.
 *
 * `lastAssistantText` and `lastAssistantError` are deliberately two functions rather than one: they scan
 * differently, because they answer different questions. A report is whichever past assistant turn actually said
 * something, so the text keeps going; a provider failure only condemns a run that ended on it, so the error
 * verdict is read off the last assistant message alone.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Which content kinds an (possibly partial) assistant message carries. */
export function contentShape(message: AgentMessage): { text: boolean; toolCall: boolean } {
	const shape = { text: false, toolCall: false };
	if (message.role !== "assistant") return shape;
	for (const part of message.content) {
		if (part.type === "toolCall") shape.toolCall = true;
		else if (part.type === "text" && part.text.trim()) shape.text = true;
	}
	return shape;
}

/** Tokens the last assistant response occupied, from its reported usage. */
export function contextTokens(message: AgentMessage): number {
	if (message.role !== "assistant") return 0;
	const usage = message.usage;
	if (!usage) return 0;
	return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

/** The last assistant message carries the provider failure (`stopReason: "error"`) when a run dies quietly. */
export function lastAssistantError(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "assistant") continue;
		const stop = (message as { stopReason?: string; errorMessage?: string }).stopReason;
		if (stop === "error") return (message as { errorMessage?: string }).errorMessage ?? "the model returned an error response";
		return undefined;
	}
	return undefined;
}

export function lastAssistantText(messages: readonly AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();
		if (text) return text;
	}
	return "";
}

export function totalUsage(messages: readonly AgentMessage[]): Usage | undefined {
	const blank: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let seen = false;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = message.usage;
		if (!usage) continue;
		seen = true;
		blank.input += usage.input;
		blank.output += usage.output;
		blank.cacheRead += usage.cacheRead;
		blank.cacheWrite += usage.cacheWrite;
		blank.totalTokens += usage.totalTokens;
		blank.cost.input += usage.cost.input;
		blank.cost.output += usage.cost.output;
		blank.cost.cacheRead += usage.cost.cacheRead;
		blank.cost.cacheWrite += usage.cost.cacheWrite;
		blank.cost.total += usage.cost.total;
	}
	return seen ? blank : undefined;
}
