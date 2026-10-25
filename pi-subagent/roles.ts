/**
 * The three roles (plan step 10). Hard-coded on purpose: a model-chosen child allowlist would be a
 * privilege-escalation primitive, and config-driven roles add a dynamic enum for no capability gain.
 */

export type RoleName = "explore" | "general-purpose" | "review";

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

const ALIASES: Record<string, RoleName> = {
	general: "general-purpose",
	generalpurpose: "general-purpose",
	general_purpose: "general-purpose",
	gp: "general-purpose",
	survey: "explore",
	critique: "review",
	code: "review",
};

/** Case- and separator-tolerant role lookup; unknown names are an error, never a fallback. */
export function resolveRole(input: string): Role | undefined {
	const key = input.trim().toLowerCase().replace(/[\s_-]+/g, "");
	const exact = ROLE_ORDER.find((name) => name.replace(/[\s_-]+/g, "") === key);
	const name = exact ?? ALIASES[key];
	return name ? ROLES[name] : undefined;
}
