/**
 * The tool declaration the model actually sees (plan step 15's text, made config-driven).
 *
 * Three strings decide whether a model delegates: the tool `description` (the field it weighs when it picks a
 * tool), the one-line `promptSnippet` of `<available_tools>`, and the `promptGuidelines` bullets pi appends to
 * `<rules>`. They shipped as literals in `index.ts`, which meant a role added under `subagent.roles` was callable
 * but invisible: the prose named only the built-ins. So the prose is now built from the *effective role table*,
 * and `subagent.tool` may reword it, with the same placeholders, from the config file.
 *
 * The placeholders are the point, not the overrides: `{{roles}}`, `{{roleNames}}` and `{{defaultRole}}` are filled
 * from the table on every request, so the role list can never drift from the roles that exist — the failure a
 * hand-written list in either place produces. Both lists are bounded ({@link MAX_LISTED_ROLES}) because they ride
 * in prompt text; a name the bound left out is still callable, and `execute` answers an unknown one by listing every
 * role that exists.
 *
 * Pure string building; `index.ts` decides when to rebuild it and where to put it. Same shape as `delegation.ts`.
 */

import type { SubagentToolPrompt } from "../pi-gate/schema.ts";
import { MAX_LISTED_ROLES, type RoleId, type RoleTable } from "./roles.ts";
import { TOOL_PROMPT_KEYS } from "./config-contract/tool-prompt.ts";

/** What one placeholder expands to for this table. */
export interface ToolPromptTokens {
	/** The effective table, built-ins first. */
	roles: RoleTable;
	/** The role an unnamed call gets, so the prose never contradicts `subagent.defaultRole`. */
	defaultRole: RoleId;
}

/** The rendered declaration, ready for `pi.registerTool` / `prepareLoadout` / the prompt options. */
export interface ToolDeclaration {
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	/**
	 * The `role` parameter's description. It can only ever be rendered at load — a registered schema is fixed for
	 * the process — so it names no default role and no per-role meaning: those two travel in the channels that
	 * *are* refreshed, and a schema that contradicted them would be worse than a schema that is merely generic.
	 */
	roleParameterDescription: string;
}

export const DEFAULT_TOOL_PROMPT: { description: string; promptSnippet: string; promptGuidelines: string[] } = {
	description:
		"Run a one-shot child session in an isolated context and wait for its answer. The child shares none of this conversation, and only " +
		"its final report comes back: the searching, reading and bulky output it produced never enters your context. That is what it is for. " +
		"Reach for it when an answer needs more than about three reads or greps, when a command's output is bulky and only its verdict matters, " +
		"for a bounded change you can describe completely, and for a review of work you just did — not for a single read or edit you can do " +
		"yourself. One child at a time; the call blocks until it finishes. The child's tool calls go through this session's permission checks, so a " +
		"denial reaches the child as an error. Roles: {{roles}}.",
	promptSnippet: "Delegate open-ended search, surveys, bulky command output or a bounded sub-task to an isolated child session (saves context)",
	promptGuidelines: [
		"Prefer subagent(role, task) over reading many files inline: the child's report costs one message, its searches never enter your context",
		"The child sees none of this conversation: name every path, symbol and command in the task text, and say what shape the report should take",
		"role: {{roleNames}}; an unnamed call gets {{defaultRole}}",
	],
};

/** The `role` parameter, spelling out the names it accepts — see {@link ToolDeclaration} for what it must not say. */
export const DEFAULT_ROLE_PARAMETER_DESCRIPTION =
	"Role name, one of {{roleNames}}. Omit it for the configured default role, which the tool description names. Any other name is refused, and the error lists " +
	"the roles that exist. The table is subagent.roles in the config, so the description's list is the one in force right now.";

/** pi's own normalization of prompt text (`agent-session.js::_normalizePromptSnippet`): one line, single-spaced. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** `explore = Read-only survey of a code base or system, review` — a clause per role, the name alone where it has no description. */
function roleClauses(roles: RoleTable): string {
	const named = Object.values(roles).map((role) => (role.description ? `${role.name} = ${role.description}` : role.name));
	const rest = named.length - MAX_LISTED_ROLES;
	const shown = named.slice(0, MAX_LISTED_ROLES);
	if (rest > 0) shown.push(`and ${rest} more role(s) in subagent.roles`);
	return shown.join(", ");
}

/** `explore, general-purpose, review` — bounded, because it rides in prompt text and in a schema alike. */
function roleNames(roles: RoleTable): string {
	const named = Object.keys(roles);
	const rest = named.length - MAX_LISTED_ROLES;
	const shown = named.slice(0, MAX_LISTED_ROLES);
	if (rest > 0) shown.push(`and ${rest} more`);
	return shown.join(", ");
}

/** Fill the placeholders of one text against this table. Unknown tokens are the parser's problem, not ours. */
export function expandToolTokens(text: string, { roles, defaultRole }: ToolPromptTokens): string {
	const values: Record<string, string> = {
		roles: roleClauses(roles),
		roleNames: roleNames(roles),
		defaultRole,
	};
	return text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) => values[name] ?? whole);
}

/** The shipped text, with only the fields the config actually wrote replaced — a reword never silences a field. */
function withOverrides(overrides: SubagentToolPrompt | undefined): typeof DEFAULT_TOOL_PROMPT {
	const out = { ...DEFAULT_TOOL_PROMPT };
	for (const key of TOOL_PROMPT_KEYS) {
		const value = overrides?.[key];
		if (key === "promptGuidelines") {
			const kept = Array.isArray(value) ? value.filter((line) => typeof line === "string" && line.trim().length > 0) : [];
			if (kept.length) out.promptGuidelines = kept;
			continue;
		}
		if (typeof value === "string" && value.trim()) out[key] = value;
	}
	return out;
}

/**
 * The declaration for one run: the config's text where it wrote any, the shipped text where it did not, and every
 * placeholder filled from the table this run will actually use. Never throws, whatever the config handed it.
 */
export function buildToolDeclaration(tokens: ToolPromptTokens, overrides: SubagentToolPrompt | undefined = undefined): ToolDeclaration {
	const source = withOverrides(overrides);
	return {
		description: expandToolTokens(source.description, tokens),
		promptSnippet: oneLine(expandToolTokens(source.promptSnippet, tokens)),
		promptGuidelines: source.promptGuidelines.map((line) => oneLine(expandToolTokens(line, tokens))),
		roleParameterDescription: expandToolTokens(DEFAULT_ROLE_PARAMETER_DESCRIPTION, tokens),
	};
}
