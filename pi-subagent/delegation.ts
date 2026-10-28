/**
 * The `delegation` system prompt section (opt-out with `subagent.delegationPrompt`).
 *
 * Why this file exists: a tool's own `description` is the only place the *reason* to call it can live,
 * and pi renders `promptGuidelines` as two flat bullets at the tail of `<rules>` next to the bash and read
 * tool's bullets. That is enough to tell a model *what* the tool is and never enough to make it reach for
 * the tool, which is why a blocking subagent tool goes unused while the model reads forty files inline.
 * pi renders a registered section as its own `<delegation>` block, so the *policy* — when to hand work to a
 * child, and what a child needs to be useful — gets stated where it is actually weighed.
 *
 * Pure string building; `index.ts` decides whether to inject it.
 */

import { ROLE_ORDER, ROLES, type RoleName } from "./roles.ts";

/** Section name in pi's structured system prompt (`^[a-z][a-z0-9_-]*$`). */
export const DELEGATION_SECTION = "delegation";

/** Rough ceiling for the section, asserted in tests: it is sent on every run that delegates. */
export const DELEGATION_WORD_BUDGET = 260;

export interface DelegationPromptInput {
	/** The role an unnamed call gets, from config, so the section never contradicts the tool. */
	defaultRole: RoleName;
}

/** One line per role, named the way the tool's enum names them. */
function roleLines(defaultRole: RoleName): string[] {
	return ROLE_ORDER.map((name) => {
		const role = ROLES[name];
		const tools = role.allowTools.includes("*") ? "may edit" : "reads only";
		return `- ${name}: ${role.description.toLowerCase()} (${tools})${name === defaultRole ? " — what an unnamed call gets" : ""}`;
	});
}

export function buildDelegationSection({ defaultRole }: DelegationPromptInput): string {
	return [
		"Delegate the work you would otherwise do by filling your own context.",
		"Reach for `subagent` when:",
		"- the answer needs more than about three reads or greps — \"how does X work\", \"who calls Y\", a directory you have not seen;",
		"- only a verdict matters, from bulky output — a test suite, a build, a long log, git history, a dependency tree;",
		"- a bounded change can be described completely: name the files, the constraints and how to verify it, then review what it reports;",
		"- the work deserves a second opinion: a plan, the diff you just wrote, a conclusion you are not certain of.",
		"Only a child's final report enters your context, never its searching. A wrong delegation costs one report; reading forty files costs the rest of the session.",
		"Do not delegate a single read or edit you can do yourself, work the user asked to watch, or the answer you give the user.",
		"To make a child useful:",
		"- it sees none of this conversation, so put every path, symbol, command and constraint in `task`;",
		"- say what to report back: file:line, a verdict plus evidence, the exact changes made;",
		"- the call blocks, and one runs at a time; the child's own calls go through this session's permission checks;",
		"- roles:",
		...roleLines(defaultRole).map((line) => `  ${line}`),
	].join("\n");
}

/** Word count of the section, for the budget test. */
export function delegationSectionWords(section: string): number {
	return section.split(/\s+/).filter(Boolean).length;
}
