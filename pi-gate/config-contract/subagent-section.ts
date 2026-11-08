/**
 * The `subagent` section: `SubagentLimits`, its shipped default, the model pin, the `roles` table parser
 * and the section parser both extensions read (plan step 2, split out of `schema.ts`).
 */

import { isDocKey, isRecord } from "./action-vocabulary.ts";
import { readBoolean } from "./tolerant-parse.ts";
import {
	ROLE_ID_PATTERN,
	ROLE_TIMEOUT_CEILING_MINUTES,
	ROLE_TURNS_CEILING,
	foldRoleId,
	isRoleId,
	type RoleConfig,
	type RoleConfigMap,
	type SubagentRoleId,
	type SubagentRoleName,
} from "./role-vocabulary.ts";
import { parseRoleSampling } from "./sampling-vocabulary.ts";

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
		// A `==` key inside the role table is the file's own documentation convention (see `==commented`), so it
		// must be inert here too: an unread note may not report an error, because an error makes the config
		// `degraded` and floors every call in the session.
		if (isDocKey(key)) continue;
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
		const sampling = parseRoleSampling(value, id, where, errors);
		if (sampling.sampling) entry.sampling = sampling.sampling;
		if (sampling.samplingByThinkingLevel) entry.samplingByThinkingLevel = sampling.samplingByThinkingLevel;
		if (sampling.thinkingLevel) entry.thinkingLevel = sampling.thinkingLevel;
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
	const enabled = readBoolean(raw, "enabled", `${where}: subagent.enabled`, errors);
	if (enabled !== undefined) limits.enabled = enabled;
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
	const delegationPrompt = readBoolean(raw, "delegationPrompt", `${where}: subagent.delegationPrompt`, errors);
	if (delegationPrompt !== undefined) limits.delegationPrompt = delegationPrompt;
	const askToExtend = readBoolean(raw, "askToExtend", `${where}: subagent.askToExtend`, errors);
	if (askToExtend !== undefined) limits.askToExtend = askToExtend;
	return { limits, errors };
}
