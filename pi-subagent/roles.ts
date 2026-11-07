/**
 * The role table (plan step 10), and the config merge that makes it extensible.
 *
 * The three built-ins are hard-coded; `subagent.roles` in the config may then *edit* any field of them or
 * add new roles. What stayed non-configurable is the thing the plan called a privilege-escalation
 * primitive: a *model*-chosen tool list. A model still only ever names a role — the tool takes no `tools`
 * parameter — and every name in the table is human-authored, then filtered by `FORBIDDEN_CHILD_TOOLS` and
 * by the parent's own callable tools, and each nested call is gated by the parent's policy. Editing the
 * config is itself floored to `ask`: `PROTECTED_PATH_GLOBS` covers `~/.pi/agent/**` and
 * `<cwd>/.pi/extensions/**`, so the model cannot quietly add a role to itself.
 */

import type { RoleConfigMap, SamplingConfig, SamplingValue, SubagentRoleId, SubagentRoleName, ThinkingLevelWord } from "../pi-gate/schema.ts";
import { FORBIDDEN_CHILD_TOOLS } from "./shims.ts";

export type RoleName = SubagentRoleName;
/** A role id: a built-in name, or one added by `subagent.roles`. */
export type RoleId = SubagentRoleId;

export interface Role {
	name: RoleId;
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
	/**
	 * Request-body sampling parameters for a child on this role, merged over the model's own defaults from
	 * `models.json`. Empty means "say nothing": the model's params and the server's defaults stand. Applied by
	 * `sampling.ts`, and only the OpenAI-compatible APIs read it — the same limit pi has, not one of ours.
	 */
	sampling?: SamplingConfig;
	/** The same, for one thinking level only; merged over {@link sampling} for that level. */
	samplingByThinkingLevel?: Partial<Record<ThinkingLevelWord, SamplingConfig>>;
	/**
	 * The child's thinking level. `undefined` means inherit the parent session's, which is the shipped
	 * behaviour; a set level is *requested*, and pi clamps it to what the model supports.
	 */
	thinkingLevel?: ThinkingLevelWord;
}

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;

export const ROLES: Record<RoleName, Role> = {
	explore: {
		name: "explore",
		description: "Read-only survey of a code base or system",
		prompt: "Answer with file paths, line numbers and short quotes. Prefer grep/find over reading whole files.",
		allowTools: READ_ONLY_TOOLS,
		maxTurns: 20,
		timeoutMinutes: 20,
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
		timeoutMinutes: 20,
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

let configuredDefault: RoleId = DEFAULT_ROLE_NAME;

/**
 * Remember the config's `defaultRole` for the renderers: `renderCall` gets args and a theme, never a
 * session ctx, so it cannot read the config to say which role an unnamed call actually got. `index.ts`
 * refreshes this where it already loads the config (`before_agent_start`, then each call).
 */
export function setConfiguredDefaultRole(name: RoleId): void {
	configuredDefault = name;
}

export function configuredDefaultRole(): RoleId {
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

/** Case- and separator-tolerant lookup in the built-in table; unknown names are an error, never a fallback. */
export function resolveRole(input: string): Role | undefined {
	const name = canonicalRole(input);
	return name ? ROLES[name] : undefined;
}

/** An effective role table, keyed by role id, built-ins first in their shipped order. */
export type RoleTable = Record<string, Role>;

export interface AppliedRoleConfig {
	roles: RoleTable;
	/** What a config entry could not mean, so `/subagentc` can show it instead of guessing. */
	warnings: string[];
	/** Role ids the config added (not built-ins). */
	added: string[];
	/** Built-in role ids the config touched. */
	edited: string[];
}

/** Names a config list asked for that a child may never reach, whatever the role says. */
function sanitiseTools(tools: readonly string[]): { keep: string[]; dropped: string[] } {
	const keep: string[] = [];
	const dropped: string[] = [];
	for (const name of tools) (FORBIDDEN_CHILD_TOOLS.includes(name) ? dropped : keep).push(name);
	return { keep, dropped };
}

/** What a new role falls back to when the entry does not say: the least-privileged built-in's *budgets*. */
const NEW_ROLE_BUDGETS = { maxTurns: ROLES.explore.maxTurns, timeoutMinutes: ROLES.explore.timeoutMinutes };

/** A role a config added: no built-in text to inherit, so an undescribed one is not listed to the model. */
function newRoleBase(key: string): Role {
	return { name: key, description: "", prompt: "", allowTools: [], ...NEW_ROLE_BUDGETS };
}

/**
 * Role params over built-in params, per key. A role that says nothing about sampling keeps no field at all,
 * so an untouched built-in stays exactly the object `roles.ts` declares — and a child runs on the model's own
 * params rather than on an empty bag that would say the same thing.
 */
function mergeSampling(base: SamplingConfig | undefined, override: SamplingConfig | undefined): SamplingConfig | undefined {
	const merged = { ...base, ...override };
	return Object.keys(merged).length ? merged : undefined;
}

function mergeSamplingByLevel(
	base: Partial<Record<ThinkingLevelWord, SamplingConfig>> | undefined,
	override: Partial<Record<ThinkingLevelWord, SamplingConfig>> | undefined,
): Partial<Record<ThinkingLevelWord, SamplingConfig>> | undefined {
	const out: Partial<Record<ThinkingLevelWord, SamplingConfig>> = { ...base };
	for (const [level, block] of Object.entries(override ?? {}) as [ThinkingLevelWord, SamplingConfig][]) {
		out[level] = { ...out[level], ...block };
	}
	return Object.keys(out).length ? out : undefined;
}

/**
 * Body fields pi writes itself, and which `samplingParams` therefore *overrides* rather than supplements
 * (pi merges the bag last, over the finished request). They stay legal — a human may mean `stop` or
 * `max_tokens` — but overriding `model` from a sampling bag would move the child onto another model while the
 * card keeps naming the one the session picked, and overriding a thinking switch cancels the same role's own
 * `thinkingLevel`. Which thinking field pi writes depends on the endpoint's `compat.thinkingFormat`
 * (`pi-ai/dist/api/openai-completions.js`): `reasoning_effort` is the generic one, `enable_thinking` is what a
 * Qwen-format endpoint is sent, `thinking` / `reasoning` / `chat_template_kwargs` / `chat_template_args` are the
 * other spellings, and `thinking_token_budget` is the budget field. Naming any of them is said where the config
 * is settled, not discovered on the wire.
 */
const PI_OWNED_BODY_FIELDS = [
	"model",
	"messages",
	"tools",
	"stream",
	"max_tokens",
	"max_completion_tokens",
	"reasoning_effort",
	"enable_thinking",
	"thinking",
	"reasoning",
	"chat_template_kwargs",
	"chat_template_args",
	"thinking_token_budget",
];

/**
 * Soft checks over everything a role's request block says — the flat bag and every level block, since a
 * per-level override is as capable of both as the flat one. Warnings, never refusals: the endpoint is not ours
 * to legislate for, and `temperature` outside 0..2 is a typo on OpenAI, vLLM, llama.cpp and SGLang alike.
 */
function samplingSanityWarnings(key: string, role: { sampling?: SamplingConfig; samplingByThinkingLevel?: Record<string, SamplingConfig | undefined> }): string[] {
	const blocks: [string, SamplingConfig][] = [["sampling", role.sampling ?? {}]];
	for (const [level, block] of Object.entries(role.samplingByThinkingLevel ?? {})) blocks.push([`samplingByThinkingLevel.${level}`, block ?? {}]);
	const warnings: string[] = [];
	for (const [path, block] of blocks) {
		for (const [field, low, high] of [
			["temperature", 0, 2],
			["top_p", 0, 1],
		] as const) {
			const value: SamplingValue | undefined = block[field];
			if (typeof value === "number" && (value < low || value > high)) {
				warnings.push(`subagent.roles.${key}.${path}.${field} is ${value}, outside the usual ${low}..${high} — sending it anyway`);
			}
		}
		for (const field of Object.keys(block)) {
			if (PI_OWNED_BODY_FIELDS.includes(field)) {
				warnings.push(`subagent.roles.${key}.${path}.${field} overrides a field pi sets itself: the request will carry it, and the card still names the session's model and thinking level`);
			}
		}
	}
	return warnings;
}

/**
 * The table one run actually uses: the three built-ins, edited by `subagent.roles`, plus new roles.
 *
 * Every field is optional, so an entry saying only `{ "maxTurns": 8 }` tightens that role and keeps its
 * tools, description and prompt. A *new* role must name its `tools`: an implicit `"*"` would make adding a
 * role an escalation by accident. `prompt` replaces the built-in line rather than appending, so
 * `/subagentc roles` shows one line per role and a rewrite is never a surprise.
 */
export function applyRoleConfig(config: RoleConfigMap | undefined): AppliedRoleConfig {
	const roles: RoleTable = {};
	for (const name of ROLE_ORDER) roles[name] = ROLES[name];
	const warnings: string[] = [];
	const added: string[] = [];
	const edited: string[] = [];
	for (const [key, entry] of Object.entries(config ?? {})) {
		const base = roles[key] ?? newRoleBase(key);
		const isNew = !ROLES[key as RoleName];
		if (isNew && !entry.tools?.length) {
			warnings.push(`subagent.roles.${key} names a new role but no "tools", so it was dropped`);
			continue;
		}
		const tools = entry.tools ? sanitiseTools(entry.tools) : undefined;
		if (tools?.dropped.length) warnings.push(`subagent.roles.${key}.tools drops ${tools.dropped.join(", ")}: a child may never reach them`);
		if (tools && !tools.keep.length) {
			warnings.push(`subagent.roles.${key}.tools names nothing a child may reach, so the role was dropped`);
			continue;
		}
		roles[key] = {
			...base,
			name: key,
			description: entry.description ?? base.description,
			prompt: entry.prompt ?? base.prompt,
			allowTools: tools?.keep ?? base.allowTools,
			maxTurns: entry.maxTurns ?? base.maxTurns,
			timeoutMinutes: entry.timeoutMinutes ?? base.timeoutMinutes,
			sampling: mergeSampling(base.sampling, entry.sampling),
			samplingByThinkingLevel: mergeSamplingByLevel(base.samplingByThinkingLevel, entry.samplingByThinkingLevel),
			thinkingLevel: entry.thinkingLevel ?? base.thinkingLevel,
		};
		warnings.push(...samplingSanityWarnings(key, roles[key] ?? {}));
		(isNew ? added : edited).push(key);
	}
	return { roles, warnings, added, edited };
}

/** The id a word names in this table, folding case/separators and the built-in aliases first. */
export function lookupRoleId(roles: RoleTable, input: unknown): string | undefined {
	if (typeof input !== "string") return undefined;
	const builtIn = canonicalRole(input);
	if (builtIn) return builtIn;
	const key = input.trim().toLowerCase().replace(/[\s_-]+/g, "");
	if (!key) return undefined;
	return Object.keys(roles).find((name) => name.toLowerCase().replace(/[\s_-]+/g, "") === key);
}

/**
 * The role one call actually runs: the model's word when it named a role, the human's configured default
 * when it named none. Nothing here reads the task text — the model is the only party that knows the intent, so
 * if it declined to choose, a keyword guess about capabilities would be a decision nobody made.
 *
 * `role` comes back `undefined` when the word names no role in the effective table; the caller then reports
 * the names that do.
 */
export function resolveCallRole(input: unknown, fallback: RoleId, roles: RoleTable = ROLES): { role: Role | undefined; roleDefaulted: boolean } {
	const named = lookupRoleId(roles, input);
	if (named) return { role: roles[named], roleDefaulted: false };
	const blank = typeof input !== "string" || !input.trim();
	const fallbackName = lookupRoleId(roles, fallback) ?? fallback;
	// A word that names no role is refused, not guessed. The schema used to stop it before this line; now that
	// the table is config-driven the refusal has to live here, because running some role the model never asked
	// for — one with more tools, or fewer — is the failure this tool must never have.
	return blank ? { role: roles[fallbackName], roleDefaulted: true } : { role: undefined, roleDefaulted: false };
}
