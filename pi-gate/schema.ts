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

/**
 * A role id: one of the built-in names, or a name a human added under `subagent.roles`.
 *
 * Config-defined roles are still human-authored — only the *name list* became dynamic, never the tool
 * list a model may ask for, so the plan's objection ("a model-chosen child allowlist is a
 * privilege-escalation primitive") is untouched: the model picks a name, the config decides what it means.
 */
export type SubagentRoleId = SubagentRoleName | string;

/** One entry of `subagent.roles`: a partial edit of a built-in role, or the definition of a new one. */
export interface RoleConfig {
	/** Label shown by `/subagentc roles` and in the `<delegation>` prompt section. */
	description?: string;
	/** Instruction appended to the child system prompt, beside the built-in role's own line. */
	prompt?: string;
	/** Tool names the child may reach; `"*"` means the parent's callable set. Required for a *new* role. */
	tools?: string[];
	/** Clamped later by the session-wide `subagent.maxTurns`. */
	maxTurns?: number;
	timeoutMinutes?: number;
}

export type RoleConfigMap = Record<string, RoleConfig>;

/** A role id a config file may use: lowercase, starts with a letter, short enough to render in a prompt. */
const ROLE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function isRoleId(value: unknown): value is string {
	return typeof value === "string" && ROLE_ID_PATTERN.test(value.trim());
}

/** A role id is matched case- and separator-insensitively, so fold before comparing. */
export function foldRoleId(value: string): string {
	return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/** Beyond these the shipped ceilings stop being sane: `maxTurns` x parallel calls must stay under 256 (FM-13). */
export const ROLE_TURNS_CEILING = 200;
export const ROLE_TIMEOUT_CEILING_MINUTES = 120;

/**
 * Values of `subagent.model` that mean "no pin, inherit the session model".
 *
 * They exist because the shipped config is strict JSON with no comment syntax: without a word for
 * "unset" the key could not be shown to a human at all, and a placeholder id would either pin every
 * child to a model or warn on every session start.
 */
export const MODEL_INHERIT_WORDS: readonly string[] = ["inherit", "inherited", "session", "parent", "default"];

export interface ModelValue {
	/** The pin to resolve, or `undefined` when the child inherits the session model. */
	model?: string;
	/** Set when the text named no model, so the caller reports the exact value it tried. */
	error?: string;
}

/** Read one `subagent.model` value: an inherit word clears the pin, anything else becomes the reference. */
export function parseModelValue(value: unknown): ModelValue {
	if (typeof value !== "string" || !value.trim()) return { error: "must be a non-empty string like \"provider/id\", or one of " + MODEL_INHERIT_WORDS.join(", ") };
	const text = value.trim();
	const word = text.toLowerCase();
	if (MODEL_INHERIT_WORDS.includes(word)) return {};
	if (text.startsWith("/") || text.startsWith(":")) return { error: `"${text}" is not a usable model reference` };
	return { model: text };
}

export interface SubagentLimits {
	/** Master switch for the `subagent` tool (`subagent.enabled`). */
	enabled: boolean;
	maxTurns: number;
	timeoutMinutes: number;
	/**
	 * How much of the child's report goes to the *model* (`subagent.maxResultBytes`). The report is the
	 * artifact the delegation paid for, so this is a safety bound, not a budget to spend: up to this size the
	 * report arrives whole, and beyond it the head is returned and the complete report is written next to the
	 * child's transcript as `<id>.report.md`, which the result names. Keep it above any report you would
	 * legitimately ask for — the fallback costs a file read, and re-reading the transcript costs more.
	 */
	maxResultBytes: number;
	keepTranscripts: number;
	/**
	 * Pin the child's model: `provider/id` (pi's CLI form), `provider:id`, or a bare `id`.
	 * Unset means the child inherits the model the session is on, and so does one of
	 * {@link MODEL_INHERIT_WORDS} — which is how the shipped config shows the key without pinning it.
	 * Human-authored config only — the tool itself still takes no model parameter.
	 */
	model?: string;
	/**
	 * The role a call gets when the model does not name one (`subagent.defaultRole`).
	 *
	 * `general-purpose` is the shipped default because it is not an escalation: its tool list is "whatever
	 * the parent can call right now", and every nested call is gated by the parent's policy anyway. Set it
	 * to `explore` to make unnamed delegations read-only, i.e. least privilege by default.
	 */
	defaultRole: SubagentRoleId;
	/**
	 * Role definitions from `subagent.roles`: edits of the three built-ins and any new roles. Absent means
	 * the built-in table exactly (`pi-subagent/roles.ts::applyRoleConfig`).
	 */
	roles?: RoleConfigMap;
	/**
	 * Add the `delegation` system prompt section ("when to hand work to a child") to runs of this session
	 * (`subagent.delegationPrompt`). Without it the only guidance the model gets is the tool's own
	 * description and two `<rules>` bullets, which is why the tool goes unused.
	 */
	delegationPrompt: boolean;
	/**
	 * Ask the human, once per run, when a child reaches its turn or time budget (`subagent.askToExtend`).
	 * The budgets are per-role guesses, and the common failure is a delegation that turns out bigger than the
	 * role guessed: the dialog hands the run more turns and minutes, or ends it as it always was. Anything other
	 * than an explicit "Extend" choice — Esc, a dialog nobody answered, no UI — enforces the ceiling unchanged.
	 */
	askToExtend: boolean;
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
	maxResultBytes: 65536,
	keepTranscripts: 20,
	askToExtend: true,
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

/**
 * Parse one `subagent.roles` map. Never throws; a bad entry contributes an error and no rule, so a typo in
 * one role cannot change the others. Shape only: the built-in merge and the forbidden-tool strip live in
 * `pi-subagent/roles.ts`, the one place that knows what a role is.
 */
export function parseRolesConfig(raw: unknown, where: string, errors: string[]): RoleConfigMap | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!isRecord(raw)) {
		errors.push(`${where}: subagent.roles must be an object of role names, ignored`);
		return undefined;
	}
	const out: RoleConfigMap = {};
	const folded = new Map<string, string>();
	for (const [key, value] of Object.entries(raw)) {
		if (!isRoleId(key)) {
			errors.push(`${where}: subagent.roles key "${key}" must match ${ROLE_ID_PATTERN}, ignored`);
			continue;
		}
		const id = key.trim();
		const fold = foldRoleId(id);
		const clash = folded.get(fold);
		if (clash) {
			errors.push(`${where}: subagent.roles "${id}" collides with "${clash}" (role names ignore case, spaces, - and _), ignored`);
			continue;
		}
		folded.set(fold, id);
		if (!isRecord(value)) {
			errors.push(`${where}: subagent.roles.${id} must be an object, ignored`);
			continue;
		}
		const entry: RoleConfig = {};
		for (const textKey of ["description", "prompt"] as const) {
			const text = value[textKey];
			if (text === undefined) continue;
			if (typeof text !== "string" || !text.trim()) errors.push(`${where}: subagent.roles.${id}.${textKey} must be a non-empty string, ignored`);
			else entry[textKey] = text.trim();
		}
		if (value.tools !== undefined) {
			if (!Array.isArray(value.tools) || !value.tools.length || value.tools.some((name) => typeof name !== "string" || !name.trim())) {
				errors.push(`${where}: subagent.roles.${id}.tools must be a non-empty array of tool names, ignored`);
			} else entry.tools = value.tools.map((name) => (name as string).trim());
		}
		for (const [numberKey, ceiling] of [
			["maxTurns", ROLE_TURNS_CEILING],
			["timeoutMinutes", ROLE_TIMEOUT_CEILING_MINUTES],
		] as const) {
			const numberValue = value[numberKey];
			if (numberValue === undefined) continue;
			if (typeof numberValue !== "number" || !Number.isFinite(numberValue) || numberValue <= 0 || numberValue > ceiling) {
				errors.push(`${where}: subagent.roles.${id}.${numberKey} must be a number in 1..${ceiling}, ignored`);
				continue;
			}
			entry[numberKey] = Math.floor(numberValue);
		}
		out[id] = entry;
	}
	return Object.keys(out).length ? out : undefined;
}

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
		const parsed = parseModelValue(raw.model);
		if (parsed.error) errors.push(`${where}: subagent.model ${parsed.error}, ignored`);
		else if (parsed.model !== undefined) limits.model = parsed.model;
	}
	if (raw.defaultRole !== undefined) {
		// A config-defined role name is legal here, so a bare `isRoleId` word is accepted and checked against
		// the effective table by the caller that has one (`pi-subagent/config-file.ts`).
		const name = typeof raw.defaultRole === "string" ? normalizeRoleWord(raw.defaultRole) : undefined;
		if (name) limits.defaultRole = name;
		else if (isRoleId(raw.defaultRole)) limits.defaultRole = raw.defaultRole.trim().toLowerCase();
		else errors.push(`${where}: subagent.defaultRole must name a role (${SUBAGENT_ROLE_WORDS.join(", ")}), ignored`);
	}
	const roles = parseRolesConfig(raw.roles, where, errors);
	if (roles) limits.roles = roles;
	if (raw.delegationPrompt !== undefined) {
		if (typeof raw.delegationPrompt === "boolean") limits.delegationPrompt = raw.delegationPrompt;
		else errors.push(`${where}: subagent.delegationPrompt must be a boolean, ignored`);
	}
	if (raw.askToExtend !== undefined) {
		if (typeof raw.askToExtend === "boolean") limits.askToExtend = raw.askToExtend;
		else errors.push(`${where}: subagent.askToExtend must be a boolean, ignored`);
	}
	return { limits, errors };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
