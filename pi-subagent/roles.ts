/**
 * The three roles (plan step 10). Hard-coded on purpose: a model-chosen child allowlist would be a
 * privilege-escalation primitive, and config-driven roles add a dynamic enum for no capability gain.
 */

import type { SubagentRoleName } from "../pi-gate/schema.ts";

export type RoleName = SubagentRoleName;

export interface Role {
	name: RoleName;
	description: string;
	/** Appended to the child system prompt (see prompt.ts). */
	prompt: string;
	/**
	 * Tool names the child may reach. `"*"` means "whatever the parent can call right now", which is
	 * already filtered by pi-gate, so gate denials propagate to children for free.
	 */
	allowTools: readonly string[];
	maxTurns: number;
	timeoutMinutes: number;
}

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

export const ROLES: Record<RoleName, Role> = {
	explore: {
		name: "explore",
		description: "Read-only survey of a code base or system",
		prompt: "Answer with file paths, line numbers and short quotes. Prefer grep/find over reading whole files.",
		allowTools: READ_ONLY_TOOLS,
		maxTurns: 20,
		timeoutMinutes: 10,
	},
	"general-purpose": {
		name: "general-purpose",
		description: "Multi-step task with the parent's full tool set",
		prompt: "You may edit files. Keep changes minimal and report exactly what you changed.",
		allowTools: ["*"],
		maxTurns: 40,
		timeoutMinutes: 20,
	},
	review: {
		name: "review",
		description: "Critique of existing code, plans or diffs",
		prompt: "Report findings only; never modify anything. Lead with the most severe issue and cite file:line.",
		allowTools: READ_ONLY_TOOLS,
		maxTurns: 15,
		timeoutMinutes: 10,
	},
};

export const ROLE_ORDER: readonly RoleName[] = ["explore", "general-purpose", "review"];

/**
 * The role an unnamed call gets (`subagent.defaultRole` decides; this is the built-in).
 * `general-purpose` is not an escalation — its tool list is the parent's own, and the parent's gate still
 * judges every nested call — whereas defaulting to a read-only role would silently refuse the edits a
 * delegated task often turns out to need.
 */
export const DEFAULT_ROLE_NAME: RoleName = "general-purpose";

let configuredDefault: RoleName = DEFAULT_ROLE_NAME;

/**
 * Remember the config's `defaultRole` for the renderers: `renderCall` gets args and a theme, never a
 * session ctx, so it cannot read the config to say which role an unnamed call actually got. `index.ts`
 * refreshes this where it already loads the config (`before_agent_start`, then each call).
 */
export function setConfiguredDefaultRole(name: RoleName): void {
	configuredDefault = name;
}

export function configuredDefaultRole(): RoleName {
	return configuredDefault;
}

const ALIASES: Record<string, RoleName> = {
	general: "general-purpose",
	generalpurpose: "general-purpose",
	general_purpose: "general-purpose",
	gp: "general-purpose",
	survey: "explore",
	critique: "review",
};

/**
 * The canonical role a word names, or `undefined` when the word is not a role word at all (including
 * "", a non-string, and an unknown name). The distinction is the point: an unknown name must stay
 * untouched so the schema rejects it and the model is told the allowed values, while a missing one is what
 * the configured default role is for.
 */
export function canonicalRole(input: unknown): RoleName | undefined {
	if (typeof input !== "string") return undefined;
	const key = input.trim().toLowerCase().replace(/[\s_-]+/g, "");
	if (!key) return undefined;
	return ROLE_ORDER.find((name) => name.replace(/[\s_-]+/g, "") === key) ?? ALIASES[key];
}

/** Case- and separator-tolerant role lookup; unknown names are an error, never a fallback. */
export function resolveRole(input: string): Role | undefined {
	const name = canonicalRole(input);
	return name ? ROLES[name] : undefined;
}

/**
 * The role one call actually runs: the model's word when it named a role, the human's configured default
 * when it did not. Nothing here reads the task text — the model is the only party that knows the intent, so
 * if it declined to choose, a keyword guess about capabilities would be a decision nobody made.
 */
export function resolveCallRole(input: unknown, fallback: RoleName): { role: Role; roleDefaulted: boolean } {
	const name = canonicalRole(input);
	return name ? { role: ROLES[name], roleDefaulted: false } : { role: ROLES[fallback], roleDefaulted: true };
}
