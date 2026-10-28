/**
 * Config document types and tolerant parsers, shared by pi-gate and pi-subagent (plan step 2).
 *
 * The two extensions read the same `config.json` file(s) but only ever import this module's types
 * and pure parsers — never each other (see the plan's ownership boundary).
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

export interface GateConfig {
	enabled: boolean;
	reviewLog: boolean;
	/** 0 waits forever; any timeout or dismiss resolves to abort, never to allow. */
	promptTimeoutMs: number;
	permission: Record<string, Action | Record<string, Action>>;
}

/**
 * Role names, as a literal union here so this file keeps importing nothing: `pi-subagent/roles.ts`
 * makes this its `RoleName`, and a drift test in `roles.test.ts` pins the union to the roles that
 * actually exist. A *human* writes these in the config; the model never chooses them from config.
 */
export type SubagentRoleName = "explore" | "general-purpose" | "review";

export interface SubagentLimits {
	/** Master switch for the `subagent` tool (`subagent.enabled`). */
	enabled: boolean;
	maxTurns: number;
	timeoutMinutes: number;
	maxResultBytes: number;
	keepTranscripts: number;
	/**
	 * Pin the child's model: `provider/id` (pi's CLI form), `provider:id`, or a bare `id`.
	 * Unset means the child inherits the model the session is on. Human-authored config only —
	 * the tool itself still takes no model parameter.
	 */
	model?: string;
	/**
	 * The role a call gets when the model does not name one (`subagent.defaultRole`).
	 *
	 * `general-purpose` is the shipped default because it is not an escalation: its tool list is "whatever
	 * the parent can call right now", and every nested call is gated by the parent's policy anyway. Set it
	 * to `explore` to make unnamed delegations read-only, i.e. least privilege by default.
	 */
	defaultRole: SubagentRoleName;
	/**
	 * Add the `delegation` system prompt section ("when to hand work to a child") to runs of this session
	 * (`subagent.delegationPrompt`). Without it the only guidance the model gets is the tool's own
	 * description and two `<rules>` bullets, which is why the tool goes unused.
	 */
	delegationPrompt: boolean;
}

/** Matches the shipped default config block in the plan (step 17). */
export const DEFAULT_GATE_CONFIG: GateConfig = {
	enabled: true,
	reviewLog: false,
	promptTimeoutMs: 0,
	permission: {
		"*": "ask",
		read: "allow",
		// Inside the workspace the agent may create and change files without a prompt: the `path`
		// rules, the `external_directory` floor and the protected-path floor still bound it.
		write: "allow",
		edit: "allow",
		grep: "allow",
		find: "allow",
		ls: "allow",
		path: {
			"*": "allow",
			"*.env": "deny",
			"*.env.*": "deny",
			"*.env.example": "allow",
			"*.pem": "deny",
			"*.key": "deny",
			"*id_rsa*": "deny",
		},
		external_directory: "ask",
		bash: { "*": "ask" },
		// The subagent tool itself has no side effects; its nested calls are gated individually.
		// (Deviation from the plan's shipped block, which left it at the "*": "ask" default.)
		subagent: "allow",
	},
};

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
	enabled: true,
	defaultRole: "general-purpose",
	delegationPrompt: true,
	maxTurns: 30,
	timeoutMinutes: 20,
	maxResultBytes: 20000,
	keepTranscripts: 20,
};

/** Ordered permission entries of a `gate.permission` map (insertion order is the rule order). */
export function flattenPermission(permission: GateConfig["permission"]): PermissionEntry[] {
	const out: PermissionEntry[] = [];
	for (const [surface, value] of Object.entries(permission)) {
		if (isAction(value)) {
			out.push({ surface, pattern: "*", action: value });
		} else if (value && typeof value === "object") {
			for (const [pattern, action] of Object.entries(value)) {
				if (isAction(action)) out.push({ surface, pattern, action });
			}
		}
	}
	return out;
}

export interface ParsedGateConfig {
	config: Partial<GateConfig>;
	entries: PermissionEntry[];
	grants: { global: GrantRule[]; project: GrantRule[] };
	errors: string[];
}

/**
 * Parse the `gate` section of one config file. Never throws: unknown keys, wrong types and invalid
 * actions are returned in `errors` and contribute no rule (the caller notifies and fails closed).
 */
export function parseGateConfig(raw: unknown, where: string): ParsedGateConfig {
	const errors: string[] = [];
	const config: Partial<GateConfig> = {};
	const grants: ParsedGateConfig["grants"] = { global: [], project: [] };

	if (raw === undefined || raw === null) return { config, entries: [], grants, errors };
	const wrapped = isRecord(raw) && "gate" in raw ? raw.gate : raw;
	if (wrapped === undefined || wrapped === null) return { config, entries: [], grants, errors };
	if (typeof wrapped !== "object" || Array.isArray(wrapped)) {
		errors.push(`${where}: "gate" must be an object`);
		return { config, entries: [], grants, errors };
	}

	const doc = wrapped as Record<string, unknown>;
	if (doc.enabled !== undefined) {
		if (typeof doc.enabled === "boolean") config.enabled = doc.enabled;
		else errors.push(`${where}: gate.enabled must be a boolean, ignored`);
	}
	if (doc.reviewLog !== undefined) {
		if (typeof doc.reviewLog === "boolean") config.reviewLog = doc.reviewLog;
		else errors.push(`${where}: gate.reviewLog must be a boolean, ignored`);
	}
	if (doc.promptTimeoutMs !== undefined) {
		if (typeof doc.promptTimeoutMs === "number" && Number.isFinite(doc.promptTimeoutMs) && doc.promptTimeoutMs >= 0) {
			config.promptTimeoutMs = Math.floor(doc.promptTimeoutMs);
		} else {
			errors.push(`${where}: gate.promptTimeoutMs must be a number >= 0, ignored`);
		}
	}

	const entries: PermissionEntry[] = [];
	if (doc.permission !== undefined) {
		if (!isRecord(doc.permission)) {
			errors.push(`${where}: gate.permission must be an object, ignored`);
		} else {
			for (const [surface, value] of Object.entries(doc.permission)) {
				if (isAction(value)) {
					entries.push({ surface, pattern: "*", action: value });
				} else if (isRecord(value)) {
					for (const [pattern, action] of Object.entries(value)) {
						if (isAction(action)) entries.push({ surface, pattern, action });
						else errors.push(`${where}: gate.permission.${surface}["${pattern}"] is not an action, ignored`);
					}
				} else {
					errors.push(`${where}: gate.permission.${surface} must be "allow"|"ask"|"deny" or a pattern map, ignored`);
				}
			}
		}
		config.permission = doc.permission as GateConfig["permission"];
	}

	if (doc.grants !== undefined) {
		if (!isRecord(doc.grants)) {
			errors.push(`${where}: gate.grants must be an object, ignored`);
		} else {
			grants.global = parseGrantList(doc.grants.global, `${where}: gate.grants.global`, errors);
			grants.project = parseGrantList(doc.grants.project, `${where}: gate.grants.project`, errors);
		}
	}

	return { config, entries, grants, errors };
}

function parseGrantList(raw: unknown, where: string, errors: string[]): GrantRule[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		errors.push(`${where} must be an array, ignored`);
		return [];
	}
	const out: GrantRule[] = [];
	raw.forEach((item, i) => {
		if (!isRecord(item) || typeof item.surface !== "string" || typeof item.pattern !== "string" || !isAction(item.action)) {
			errors.push(`${where}[${i}] must be {surface, pattern, action}, ignored`);
			return;
		}
		out.push({ surface: item.surface, pattern: item.pattern, action: item.action });
	});
	return out;
}

export interface ParsedSubagentConfig {
	limits: Partial<SubagentLimits>;
	errors: string[];
}

const SUBAGENT_NUMBER_KEYS = ["maxTurns", "timeoutMinutes", "maxResultBytes", "keepTranscripts"] as const satisfies readonly (keyof SubagentLimits)[];

const SUBAGENT_ROLE_WORDS: readonly SubagentRoleName[] = ["explore", "general-purpose", "review"];

/** Case- and separator-tolerant role lookup for config text (mirrors `pi-subagent/roles.ts`). */
function normalizeRoleWord(input: string): SubagentRoleName | undefined {
	const key = input.trim().toLowerCase().replace(/[\s_-]+/g, "");
	return SUBAGENT_ROLE_WORDS.find((name) => name.replace(/[\s_-]+/g, "") === key);
}

/** Parse the `subagent` section of one config file. Never throws. */
export function parseSubagentConfig(raw: unknown, where = "config"): ParsedSubagentConfig {
	const errors: string[] = [];
	const limits: Partial<SubagentLimits> = {};
	if (raw === undefined || raw === null) return { limits, errors };
	if (!isRecord(raw)) {
		errors.push(`${where}: "subagent" must be an object`);
		return { limits, errors };
	}
	for (const key of SUBAGENT_NUMBER_KEYS) {
		const value = raw[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			errors.push(`${where}: subagent.${key} must be a positive number, ignored`);
			continue;
		}
		limits[key] = Math.floor(value);
	}
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") limits.enabled = raw.enabled;
		else errors.push(`${where}: subagent.enabled must be a boolean, ignored`);
	}
	if (raw.model !== undefined) {
		if (typeof raw.model === "string" && raw.model.trim()) limits.model = raw.model.trim();
		else errors.push(`${where}: subagent.model must be a non-empty string like "provider/id", ignored`);
	}
	if (raw.defaultRole !== undefined) {
		const name = typeof raw.defaultRole === "string" ? normalizeRoleWord(raw.defaultRole) : undefined;
		if (name) limits.defaultRole = name;
		else errors.push(`${where}: subagent.defaultRole must name a role (${SUBAGENT_ROLE_WORDS.join(", ")}), ignored`);
	}
	if (raw.delegationPrompt !== undefined) {
		if (typeof raw.delegationPrompt === "boolean") limits.delegationPrompt = raw.delegationPrompt;
		else errors.push(`${where}: subagent.delegationPrompt must be a boolean, ignored`);
	}
	return { limits, errors };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
