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

/**
 * The model-facing declaration of the `subagent` tool (`subagent.tool`): pi's three registration strings, which
 * the shipped defaults hard-code. Absent, or with nothing usable in it, means the shipped text exactly.
 *
 * Each value may use the placeholders of {@link SUBAGENT_TOOL_PROMPT_TOKENS}, which are filled from the
 * *effective* role table on every request — so a role added under `subagent.roles` reaches the tool description,
 * the parameter list and the `<rules>` bullets without any of them being written twice. An unknown placeholder is
 * an error rather than literal text, because `{{role}}` sent to the model is a typo nobody reads.
 */
export interface SubagentToolPrompt {
	/** The tool `description`: the field a model weighs when it chooses a tool. */
	description?: string;
	/** The one-line `promptSnippet` of the `<available_tools>` list; a tool without one is not listed at all. */
	promptSnippet?: string;
	/** The `promptGuidelines` bullets this tool appends to `<rules>`. */
	promptGuidelines?: string[];
}

/** The keys of a `subagent.tool` block, in the order the parser reports them. */
export const SUBAGENT_TOOL_PROMPT_KEYS = ["description", "promptSnippet", "promptGuidelines"] as const satisfies readonly (keyof SubagentToolPrompt)[];

/** The placeholders `subagent.tool` text may use; filled by `pi-subagent/tool-declaration.ts`. */
export const SUBAGENT_TOOL_PROMPT_TOKENS = ["roles", "roleNames", "defaultRole"] as const;

/** One `{{token}}` occurrence, and whether this vocabulary answers to it. */
export function unknownToolPromptToken(text: string): string | undefined {
	for (const match of text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)) {
		if (!(SUBAGENT_TOOL_PROMPT_TOKENS as readonly string[]).includes(match[1]!)) return match[0];
	}
	return undefined;
}

/**
 * Parse one `subagent.tool` block. Never throws; a bad field contributes one error and is dropped, so a typo in
 * the description cannot delete the tool's guidance wholesale. Mirror: `pi-subagent/config-contract/tool-prompt.ts`.
 */
export function parseToolPromptConfig(raw: unknown, where: string, errors: string[]): SubagentToolPrompt | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!isRecord(raw)) {
		errors.push(`${where}: subagent.tool must be an object of ${SUBAGENT_TOOL_PROMPT_KEYS.join(", ")}, ignored`);
		return undefined;
	}
	const out: SubagentToolPrompt = {};
	for (const [key, value] of Object.entries(raw)) {
		if (isDocKey(key)) continue; // an unread note may not become a config error
		if (!(SUBAGENT_TOOL_PROMPT_KEYS as readonly string[]).includes(key)) {
			errors.push(`${where}: subagent.tool.${key} is not a tool prompt key (${SUBAGENT_TOOL_PROMPT_KEYS.join(", ")}), ignored`);
			continue;
		}
		if (key === "promptGuidelines") {
			if (!Array.isArray(value) || !value.length || value.some((line) => typeof line !== "string" || !line.trim())) {
				errors.push(`${where}: subagent.tool.promptGuidelines must be a non-empty array of non-empty strings, ignored`);
				continue;
			}
			const kept: string[] = [];
			value.forEach((line, index) => {
				const token = unknownToolPromptToken(String(line));
				if (token) errors.push(`${where}: subagent.tool.promptGuidelines[${index}] uses unknown token "${token}" (known: ${SUBAGENT_TOOL_PROMPT_TOKENS.map((name) => `{{${name}}}`).join(", ")}), ignored`);
				else kept.push(String(line).trim());
			});
			if (kept.length) out.promptGuidelines = kept;
			continue;
		}
		const text = value;
		if (typeof text !== "string" || !text.trim()) {
			errors.push(`${where}: subagent.tool.${key} must be a non-empty string, ignored`);
			continue;
		}
		const token = unknownToolPromptToken(text);
		if (token) {
			errors.push(`${where}: subagent.tool.${key} uses unknown token "${token}" (known: ${SUBAGENT_TOOL_PROMPT_TOKENS.map((name) => `{{${name}}}`).join(", ")}), ignored`);
			continue;
		}
		if (key === "description") out.description = text.trim();
		else out.promptSnippet = text.trim();
	}
	return Object.keys(out).length ? out : undefined;
}

/**
 * One rung of the "more rope?" dialog: the turns and minutes a human hands out together. Config writes them as
 * `{ "turns": 40, "minutes": 10 }`; the ladder itself and what a spent budget does with a rung live in
 * `pi-subagent/ceiling.ts`, which owns the shipped rungs.
 */
export interface ExtendOption {
	turns: number;
	minutes: number;
}

/**
 * The most rungs the dialog may offer. Its list is pi's `select`, and the ceiling's own rule is that a question
 * nobody could answer grants nothing (FM-11) — so a ladder long enough to scroll its options off the screen is
 * that failure by construction, and the surplus is reported and dropped rather than shown.
 */
export const MAX_EXTEND_OPTIONS = 8;

/**
 * The turn count one written rung may name — wider than {@link ROLE_TURNS_CEILING}, because a role budget is
 * written once by whoever edits the file, while the largest rung a watching human clicks is theirs to size, and the
 * point of writing a big one is a delegation bigger than any role guessed. Minutes stay inside what a role may be
 * configured to spend, so no rung can be both huge and endless. Mirror:
 * `pi-subagent/config-contract/extend-options.ts`.
 */
export const EXTEND_TURNS_CEILING = 1000;

/**
 * Both figures written: turns inside {@link EXTEND_TURNS_CEILING}, minutes inside what a role budget may be
 * configured to spend.
 */
function parseExtendRung(value: unknown, label: string, errors: string[]): ExtendOption | undefined {
	if (!isRecord(value)) {
		errors.push(`${label} must be { turns, minutes }, ignored`);
		return undefined;
	}
	const rung: ExtendOption = { turns: 0, minutes: 0 };
	for (const [key, ceiling] of [
		["turns", EXTEND_TURNS_CEILING],
		["minutes", ROLE_TIMEOUT_CEILING_MINUTES],
	] as const) {
		const numberValue = value[key];
		if (typeof numberValue !== "number" || !Number.isFinite(numberValue) || numberValue <= 0 || numberValue > ceiling) {
			errors.push(`${label}.${key} must be a number in 1..${ceiling}, ignored`);
			return undefined;
		}
		rung[key] = Math.floor(numberValue);
	}
	return rung;
}

/**
 * Parse one `subagent.extendOptions` array. Never throws; a bad rung is one error and no rung, so a typo cannot
 * silently remove the whole ladder. A written array *replaces* the shipped ladder — see
 * `pi-subagent/ceiling.ts::resolveExtensionSteps`. Mirror: `pi-subagent/config-contract/extend-options.ts`.
 */
export function parseExtendOptions(raw: unknown, where: string, errors: string[]): ExtendOption[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!Array.isArray(raw) || !raw.length) {
		errors.push(`${where}: subagent.extendOptions must be a non-empty array of { turns, minutes }, ignored`);
		return undefined;
	}
	const out: ExtendOption[] = [];
	raw.forEach((value, index) => {
		const rung = parseExtendRung(value, `${where}: subagent.extendOptions[${index}]`, errors);
		if (rung) out.push(rung);
	});
	return out.length ? out : undefined;
}

/**
 * Parse one `subagent.disableExtendTurns` array: the `turns` values of rungs to drop, shipped or config-written.
 * Never throws; a bad entry is one error and no removal.
 */
export function parseDisableExtendTurns(raw: unknown, where: string, errors: string[]): number[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!Array.isArray(raw) || !raw.length) {
		errors.push(`${where}: subagent.disableExtendTurns must be a non-empty array of turn counts, ignored`);
		return undefined;
	}
	const out: number[] = [];
	raw.forEach((value, index) => {
		const label = `${where}: subagent.disableExtendTurns[${index}]`;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > EXTEND_TURNS_CEILING) {
			errors.push(`${label} must be a number in 1..${EXTEND_TURNS_CEILING}, ignored`);
			return;
		}
		out.push(Math.floor(value));
	});
	return out.length ? out : undefined;
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
	 * Model-facing overrides of the tool's own declaration (`subagent.tool`): description, snippet, guideline
	 * bullets. Absent means the shipped text (`pi-subagent/tool-declaration.ts`).
	 */
	tool?: SubagentToolPrompt;
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
	 * The dialog's session menu is the one answer that outlives the run: a rung chosen there is applied to every
	 * later run without asking, by that same explicit choice (`pi-subagent/budget/session-budget.ts`), and it is
	 * never written to a file.
	 */
	askToExtend: boolean;
	/**
	 * Give a child that could not report one final, tool-less turn to do it in (`subagent.requireFinalReport`).
	 *
	 * Without it a run that was cut off mid-turn, or that wrote its next call as text and stopped, hands back the
	 * narration of a step it never took — and the parent cannot tell that from an answer. With it the child gets
	 * one more request, on the same session, with no tools left to narrate, so a message is its only move. The
	 * turn is bounded by its own grace window and never happens on a run a human stopped or a provider killed.
	 */
	requireFinalReport: boolean;
	/**
	 * Write one JSONL per child run to `subagent.debugLogDir` (default `<tmp>/pi-subagent`): the child's thinking,
	 * every nested call, every steer, the ceiling's decisions and the final report turn — the harness's side of a
	 * run, which the child's own transcript does not record. Off, nothing is written anywhere (`subagent.debugLog`).
	 */
	debugLog: boolean;
	/** Where those logs go. Absent means `<tmp>/pi-subagent`. */
	debugLogDir?: string;
	/**
	 * The rungs of the extension dialog (`subagent.extendOptions`), replacing the shipped ladder outright: what the
	 * file says is what the dialog offers, one entry per rung, smallest-first. Absent means the shipped ladder
	 * exactly (`pi-subagent/ceiling.ts::EXTENSION_STEPS`).
	 */
	extendOptions?: ExtendOption[];
	/**
	 * `turns` values of rungs to drop (`subagent.disableExtendTurns`), applied after {@link extendOptions} replaces
	 * the ladder — the drop lists concatenate across files, so a file that writes only drops can still remove a
	 * rung the other file's ladder added.
	 */
	disableExtendTurns?: number[];
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
	requireFinalReport: true,
	debugLog: true,
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
	const tool = parseToolPromptConfig(raw.tool, where, errors);
	if (tool) limits.tool = tool;
	const delegationPrompt = readBoolean(raw, "delegationPrompt", `${where}: subagent.delegationPrompt`, errors);
	if (delegationPrompt !== undefined) limits.delegationPrompt = delegationPrompt;
	const askToExtend = readBoolean(raw, "askToExtend", `${where}: subagent.askToExtend`, errors);
	if (askToExtend !== undefined) limits.askToExtend = askToExtend;
	const requireFinalReport = readBoolean(raw, "requireFinalReport", `${where}: subagent.requireFinalReport`, errors);
	if (requireFinalReport !== undefined) limits.requireFinalReport = requireFinalReport;
	const debugLog = readBoolean(raw, "debugLog", `${where}: subagent.debugLog`, errors);
	if (debugLog !== undefined) limits.debugLog = debugLog;
	if (raw.debugLogDir !== undefined) {
		if (typeof raw.debugLogDir !== "string" || !raw.debugLogDir.trim()) errors.push(`${where}: subagent.debugLogDir must be a non-empty path, ignored`);
		else limits.debugLogDir = raw.debugLogDir.trim();
	}
	const extendOptions = parseExtendOptions(raw.extendOptions, where, errors);
	if (extendOptions) limits.extendOptions = extendOptions;
	const disableExtendTurns = parseDisableExtendTurns(raw.disableExtendTurns, where, errors);
	if (disableExtendTurns) limits.disableExtendTurns = disableExtendTurns;
	return { limits, errors };
}
