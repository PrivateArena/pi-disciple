/**
 * The gate's shared vocabulary: actions, scopes, the shape of a rule, and the two reader predicates
 * every other config module needs (plan step 2, split out of `schema.ts`).
 *
 * A leaf module — it imports nothing, so the whole config contract can sit on top of it.
 */

export type Action = "allow" | "ask" | "deny";

/** Precedence order, lowest first: later scopes override earlier ones (last matching pattern wins). */
export type Scope =
	| "builtin"
	| "global"
	| "project"
	| "grants.global"
	| "grants.project"
	| "grants.session";

export const SCOPE_PRECEDENCE: readonly Scope[] = [
	"builtin",
	"global",
	"project",
	"grants.global",
	"grants.project",
	"grants.session",
];

/** `deny > ask > allow`, used when combining the facts of one call (most restrictive wins). */
export const ACTION_SEVERITY: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };

export function isAction(value: unknown): value is Action {
	return value === "allow" || value === "ask" || value === "deny";
}

export function mostRestrictive(a: Action, b: Action): Action {
	return ACTION_SEVERITY[a] >= ACTION_SEVERITY[b] ? a : b;
}

/** One entry of a `gate.permission` surface map, in file order. */
export interface PermissionEntry {
	surface: string;
	/** `"*"` for the shorthand string form (`"read": "allow"`). */
	pattern: string;
	action: Action;
}

/** A persisted grant: `gate.grants.global` / `gate.grants.project` in a config file. */
export interface GrantRule {
	surface: string;
	pattern: string;
	action: Action;
}

/**
 * One `gate.hardDeny` entry: a deny the "allow everything" mode cannot swallow (plan step C).
 *
 * Deliberately **not** a {@link GrantRule} and never an `action` field: there is exactly one action, and
 * the absence of a knob is what makes the entry un-coercible by a dialog click. `surface` is optional
 * because the common case is "this thing, wherever it appears" — a host, a file, a command — and `"*"`
 * means every surface, including the cross-cutting `path` / `external_directory` / `network` ones.
 */
export interface HardDenyRule {
	surface?: string;
	pattern: string;
	/** Shown in the block text and the review log: why a human wrote the rule, for whoever hits it. */
	reason?: string;
}

/** A `==`-prefixed key is documentation in this file, so no layer of the gate may read it as config. */
export function isDocKey(key: string): boolean {
	return key.startsWith("==");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
