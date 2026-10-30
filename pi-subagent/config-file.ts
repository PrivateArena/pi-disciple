/**
 * Subagent limits (plan step 20).
 *
 * Intentionally a second, self-contained reader of the same two config files: it imports only *types* from
 * `pi-gate/schema.ts`, which vanish at runtime, so deleting `pi-gate` leaves `subagent` working with the
 * limits from the same file. No gate policy code is reachable from here.
 *
 * The config vocabulary it mirrors from `pi-gate/schema.ts` — the inherit words of `subagent.model`, the
 * ceilings, the role-id pattern and the `subagent.roles` shape rules — is re-typed below rather than
 * imported, and `__tests__/config-parity.test.ts` fails if the two readers ever disagree.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { applyRoleConfig, canonicalRole, DEFAULT_ROLE_NAME, type AppliedRoleConfig, type RoleTable } from "./roles.ts";
import type { RoleConfig, RoleConfigMap, SubagentLimits } from "../pi-gate/schema.ts";

export type { SubagentLimits };

/** Mirror of `schema.ts::MODEL_INHERIT_WORDS` — values of `subagent.model` that mean "no pin". */
export const MODEL_INHERIT_WORDS: readonly string[] = ["inherit", "inherited", "session", "parent", "default"];
/** Mirror of `schema.ts::ROLE_TURNS_CEILING` / `ROLE_TIMEOUT_CEILING_MINUTES`. */
export const ROLE_TURNS_CEILING = 200;
export const ROLE_TIMEOUT_CEILING_MINUTES = 120;
/** Mirror of `schema.ts::isRoleId`. */
export const ROLE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export const DEFAULT_LIMITS: SubagentLimits = {
	enabled: true,
	defaultRole: DEFAULT_ROLE_NAME,
	delegationPrompt: true,
	maxTurns: 30,
	timeoutMinutes: 20,
	maxResultBytes: 65536,
	keepTranscripts: 20,
};

export interface LoadedLimits {
	limits: SubagentLimits;
	/**
	 * Which file supplied each non-default value. `/subagentc` shows it, so a pinned model, a tightened
	 * `maxTurns` or a new role can be traced to the global file or the project file without opening both.
	 */
	origins: Partial<Record<keyof SubagentLimits, string>>;
	/** The role table `limits.roles` describes: built-ins edited by config, plus any new roles. */
	effectiveRoles: RoleTable;
	/** Per-role source file, so `/subagentc roles` can say where a role came from. */
	roleOrigins: Record<string, string>;
	files: string[];
	errors: string[];
}

const KEYS: readonly (keyof SubagentLimits)[] = ["maxTurns", "timeoutMinutes", "maxResultBytes", "keepTranscripts"];

/**
 * Read the numeric limits, the `enabled` switch, the `model` pin, the default role, the delegation prompt
 * switch and the `roles` table; anything else in the section is ignored. A malformed value contributes an
 * error and leaves that field at its previous value, so a typo tightens nothing and cannot disable the tool.
 */

const cache = new Map<string, { stamp: string; loaded: LoadedLimits }>();

export function loadSubagentLimits(cwd: string, trusted: boolean, agentDir: string = getAgentDir()): LoadedLimits {
	const paths = [join(agentDir, "extensions", "pi-gate", "config.json")];
	if (trusted) paths.push(join(cwd, CONFIG_DIR_NAME, "extensions", "pi-gate", "config.json"));
	const stamp = paths.map((file) => `${file}=${safeMtime(file)}`).join("|");
	const hit = cache.get("limits");
	if (hit && hit.stamp === stamp) return hit.loaded;

	const loaded: LoadedLimits = {
		limits: { ...DEFAULT_LIMITS },
		origins: {},
		effectiveRoles: {} as RoleTable,
		roleOrigins: {},
		files: [],
		errors: [],
	};
	for (const file of paths) {
		const section = readSubagentSection(file, loaded.errors);
		if (section === undefined) continue;
		loaded.files.push(file);
		for (const key of KEYS) {
			const value = section[key];
			if (value === undefined) continue;
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
				loaded.errors.push(`${file}: subagent.${key} must be a positive number, ignored`);
				continue;
			}
			loaded.limits = { ...loaded.limits, [key]: Math.floor(value) };
			loaded.origins[key] = file;
		}
		if (section.enabled !== undefined) {
			if (typeof section.enabled === "boolean") {
				loaded.limits = { ...loaded.limits, enabled: section.enabled };
				loaded.origins.enabled = file;
			} else loaded.errors.push(`${file}: subagent.enabled must be a boolean, ignored`);
		}
		if (section.model !== undefined) {
			const pin = readModelValue(section.model);
			if (pin.error) loaded.errors.push(`${file}: subagent.model ${pin.error}, ignored`);
			// An inherit word is an explicit "no pin", so it clears the key instead of leaving a stale value.
			else if (pin.model === undefined) {
				loaded.limits = { ...loaded.limits, model: undefined };
				delete loaded.origins.model;
			} else {
				loaded.limits = { ...loaded.limits, model: pin.model };
				loaded.origins.model = file;
			}
		}
		if (section.defaultRole !== undefined) {
			// Human-authored, so alias spellings count ("gp", "survey") and a name that a `roles` block defines
			// is legal; whether it names a role is settled once the whole table exists, in `finish`.
			const name = canonicalRole(section.defaultRole) ?? (isRoleId(section.defaultRole) ? normaliseRoleId(section.defaultRole) : undefined);
			if (name) {
				loaded.limits = { ...loaded.limits, defaultRole: name };
				loaded.origins.defaultRole = file;
			} else loaded.errors.push(`${file}: subagent.defaultRole must name a role, ignored`);
		}
		const roles = readRoles(section.roles, file, loaded.errors);
		if (roles) {
			const merged: RoleConfigMap = { ...loaded.limits.roles };
			for (const [key, entry] of Object.entries(roles)) {
				merged[key] = { ...merged[key], ...entry };
				loaded.roleOrigins[key] = file;
			}
			loaded.limits = { ...loaded.limits, roles: merged };
			loaded.origins.roles = file;
		}
		if (section.delegationPrompt !== undefined) {
			if (typeof section.delegationPrompt === "boolean") {
				loaded.limits = { ...loaded.limits, delegationPrompt: section.delegationPrompt };
				loaded.origins.delegationPrompt = file;
			} else loaded.errors.push(`${file}: subagent.delegationPrompt must be a boolean, ignored`);
		}
	}
	finish(loaded);
	cache.set("limits", { stamp, loaded });
	return loaded;
}

/**
 * Settle the assembled document against the table it describes: an unspellable `defaultRole` and a new role
 * that arrived without `tools` are each reported once, here, rather than at every call.
 */
function finish(loaded: LoadedLimits): void {
	const applied: AppliedRoleConfig = applyRoleConfig(loaded.limits.roles);
	loaded.errors.push(...applied.warnings.map((warning) => `subagent.roles: ${warning}`));
	loaded.effectiveRoles = applied.roles;
	const name = loaded.limits.defaultRole;
	if (applied.roles[name] === undefined) {
		loaded.errors.push(`subagent.defaultRole "${name}" names no role (${Object.keys(applied.roles).join(", ")}), using "${DEFAULT_ROLE_NAME}"`);
		loaded.limits = { ...loaded.limits, defaultRole: DEFAULT_ROLE_NAME };
		delete loaded.origins.defaultRole;
	}
}

/** `subagent.model`: an inherit word means "no pin" — that is what lets the shipped config show the key. */
function readModelValue(value: unknown): { model?: string; error?: string } {
	if (typeof value !== "string" || !value.trim())
		return { error: `must be a non-empty string like "provider/id", or one of ${MODEL_INHERIT_WORDS.join(", ")}` };
	const text = value.trim();
	if (MODEL_INHERIT_WORDS.includes(text.toLowerCase())) return {};
	if (text.startsWith("/") || text.startsWith(":")) return { error: `"${text}" is not a usable model reference` };
	return { model: text };
}

function isRoleId(value: unknown): value is string {
	return typeof value === "string" && ROLE_ID_PATTERN.test(value.trim());
}

function normaliseRoleId(value: string): string {
	return value.trim().toLowerCase();
}

/** Mirror of `pi-gate/schema.ts::parseRolesConfig`, error-for-error. */
function readRoles(raw: unknown, file: string, errors: string[]): RoleConfigMap | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!isRecordish(raw)) {
		errors.push(`${file}: subagent.roles must be an object of role names, ignored`);
		return undefined;
	}
	const out: RoleConfigMap = {};
	const folded = new Map<string, string>();
	for (const [key, value] of Object.entries(raw)) {
		if (!isRoleId(key)) {
			errors.push(`${file}: subagent.roles key "${key}" must match ${ROLE_ID_PATTERN}, ignored`);
			continue;
		}
		const id = normaliseRoleId(key);
		const fold = id.replace(/[\s_-]+/g, "");
		const clash = folded.get(fold);
		if (clash) {
			errors.push(`${file}: subagent.roles "${id}" collides with "${clash}" (role names ignore case, spaces, - and _), ignored`);
			continue;
		}
		folded.set(fold, id);
		if (!isRecordish(value)) {
			errors.push(`${file}: subagent.roles.${id} must be an object, ignored`);
			continue;
		}
		const entry: RoleConfig = {};
		for (const textKey of ["description", "prompt"] as const) {
			const text = value[textKey];
			if (text === undefined) continue;
			if (typeof text !== "string" || !text.trim()) errors.push(`${file}: subagent.roles.${id}.${textKey} must be a non-empty string, ignored`);
			else entry[textKey] = text.trim();
		}
		if (value.tools !== undefined) {
			if (!Array.isArray(value.tools) || !value.tools.length || value.tools.some((name) => typeof name !== "string" || !name.trim())) {
				errors.push(`${file}: subagent.roles.${id}.tools must be a non-empty array of tool names, ignored`);
			} else entry.tools = value.tools.map((name) => (name as string).trim());
		}
		for (const [numberKey, ceiling] of [
			["maxTurns", ROLE_TURNS_CEILING],
			["timeoutMinutes", ROLE_TIMEOUT_CEILING_MINUTES],
		] as const) {
			const numberValue = value[numberKey];
			if (numberValue === undefined) continue;
			if (typeof numberValue !== "number" || !Number.isFinite(numberValue) || numberValue <= 0 || numberValue > ceiling) {
				errors.push(`${file}: subagent.roles.${id}.${numberKey} must be a number in 1..${ceiling}, ignored`);
				continue;
			}
			entry[numberKey] = Math.floor(numberValue);
		}
		out[id] = entry;
	}
	return Object.keys(out).length ? out : undefined;
}

function isRecordish(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSubagentSection(file: string, errors: string[]): Record<string, unknown> | undefined {
	let text: string;
	try {
		if (!existsSync(file)) return undefined;
		text = readFileSync(file, "utf8").trim();
	} catch (error) {
		errors.push(`${file}: ${(error as Error).message}`);
		return undefined;
	}
	if (!text) return undefined;
	try {
		return pickSection(JSON.parse(text), errors, undefined);
	} catch {
		// Same JSONC tolerance as pi-gate/config-file.ts: a hand-written config with comments must not
		// silently degrade the subagent to defaults.
		try {
			return pickSection(JSON.parse(stripJsonComments(text)), errors, `${file}: comments were stripped on read (pi-subagent never writes this file)`);
		} catch (error) {
			errors.push(`${file}: invalid JSON, using default limits (${(error as Error).message})`);
			return undefined;
		}
	}
}

function pickSection(json: unknown, errors: string[], warning: string | undefined): Record<string, unknown> | undefined {
	if (warning) errors.push(warning);
	const section = (json as { subagent?: unknown })?.subagent;
	return section && typeof section === "object" && !Array.isArray(section) ? (section as Record<string, unknown>) : {};
}

function safeMtime(file: string): number {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

function stripJsonComments(text: string): string {
	let out = "";
	let inString = false;
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (inString) {
			out += c;
			if (c === "\\" && i + 1 < text.length) out += text[++i];
			else if (c === quote) inString = false;
			continue;
		}
		if (c === '"' || c === "'") {
			inString = true;
			quote = c;
			out += c;
			continue;
		}
		if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		if (c === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
			continue;
		}
		out += c;
	}
	return out;
}
