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
		"Gather what you need with the tools, then report in your final message: findings, file paths, line numbers, and what blocked you.",
		// One line for the two ways a child's answer turns into a non-answer, both of them observed: a call put on
		// the text channel, which runs nothing and ends the turn, and a run that stops on a sentence about its next
		// step. The word budget is step 11's; `call-text.ts` and `final-report.ts` enforce both when the model does not.
		"Make every tool call through the tool interface, never as text; end with a report of what you did, never a next step.",
		role.prompt,
		"Never claim a command succeeded when it did not; if a call is denied, say so and continue.",
	].join(" ");
}

/** First-person brief handed to the child as its opening user message guard-rail. */
export const CHILD_TASK_WRAPPER = "Complete this task and report the result. Be self-contained: the caller sees only your final message.\n\n";
