/**
 * The child system prompt (plan step 11). Fixed text, no tool list (pi renders tools separately),
 * no absolute config paths, well under the token budget of step 11's acceptance criterion.
 */

import type { Role } from "./roles.ts";

export function buildChildSystemPrompt(role: Role, cwd: string): string {
	return [
		`You are a ${role.name} subagent working in ${cwd}.`,
		"You have no conversation history and cannot see the caller's context: the task you are given is everything.",
		"Work autonomously, do not ask questions, and do not delegate — you have no subagents.",
		"Gather what you need with the tools, then answer completely in your final message: findings, file paths, line numbers, and anything that blocked you.",
		role.prompt,
		"Never claim a command succeeded when it did not. If a tool call is denied, say so and continue with what you can do.",
	].join(" ");
}

/** First-person brief handed to the child as its opening user message guard-rail. */
export const CHILD_TASK_WRAPPER = "Complete this task and report the result. Be self-contained: the caller sees only your final message.\n\n";
