/**
 * Subagent limits (plan step 20).
 *
 * Intentionally a second, self-contained reader of the same two config files: it imports only *types* from
 * `pi-gate/schema.ts`, which vanish at runtime, so deleting `pi-gate` leaves `subagent` working with the
 * limits from the same file. No gate policy code is reachable from here.
 *
 * The config vocabulary it mirrors from `pi-gate/schema.ts` — the inherit words of `subagent.model`, the
 * ceilings, the role-id pattern and the `subagent.roles` shape rules — lives one concern per module under
 * `config-contract/` rather than being imported from `pi-gate`, and `__tests__/config-parity.test.ts` fails if
 * the two readers ever disagree.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { applyRoleConfig, canonicalRole, DEFAULT_ROLE_NAME, type AppliedRoleConfig, type RoleTable } from "./roles.ts";
import type { RoleConfigMap, SubagentLimits, SubagentToolPrompt } from "../pi-gate/schema.ts";
import { readModelValue } from "./config-contract/model-pin.ts";
import { isRoleId, normaliseRoleId } from "./config-contract/role-names.ts";
import { readRoles } from "./config-contract/roles-table.ts";
import { readToolPrompt } from "./config-contract/tool-prompt.ts";
import { readBoolean } from "./config-contract/tolerant-parse.ts";

export type { SubagentLimits, SubagentToolPrompt };

/**
 * The facade over the `config-contract/` package: the *vocabulary* of the `subagent` section — the
 * `subagent.model` inherit words, the role-id rules and role ceilings, the thinking-level words and the
 * `subagent.roles` shape rules — now lives one concern per module under `config-contract/`, while this module
 * keeps what is about the *file*: which scopes it reads, in which order, cached on mtime, each error prefixed
 * with the file that said it. Everything this module exported before is still reachable from here, and nothing
 * under `config-contract/` imports this file.
 */
export { MODEL_INHERIT_WORDS } from "./config-contract/model-pin.ts";
export { ROLE_ID_PATTERN, ROLE_TIMEOUT_CEILING_MINUTES, ROLE_TURNS_CEILING } from "./config-contract/role-names.ts";
export { THINKING_LEVEL_WORDS } from "./config-contract/sampling-bag.ts";
export { TOOL_PROMPT_KEYS, TOOL_PROMPT_TOKENS } from "./config-contract/tool-prompt.ts";
/** Mirrors `EXTENSION_CONFIG_SLUG` in `pi-gate/config-file.ts`; the directory is named for the package, not for one extension. */
export const EXTENSION_CONFIG_SLUG = "pi-disciple";

export const DEFAULT_LIMITS: SubagentLimits = {
	enabled: true,
	defaultRole: DEFAULT_ROLE_NAME,
	delegationPrompt: true,
	maxTurns: 30,
	timeoutMinutes: 20,
	maxResultBytes: 65536,
	keepTranscripts: 20,
	askToExtend: true,
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
	/**
	 * Per-field source of the `subagent.tool` rewording. Per key because the block itself merges per key — a
	 * project file that reworded only the snippet must not be credited with the global `description`.
	 */
	toolOrigins: Partial<Record<keyof SubagentToolPrompt, string>>;
	files: string[];
	errors: string[];
}

const KEYS: readonly (keyof SubagentLimits)[] = ["maxTurns", "timeoutMinutes", "maxResultBytes", "keepTranscripts"];

/**
 * Read the numeric limits, the `enabled` switch, the `model` pin, the default role, the delegation prompt
 * switch, the ceiling-extension switch, the `roles` table and the `tool` declaration; anything else in the
 * section is ignored. A malformed value contributes an error and leaves that field at its previous value, so a
 * typo tightens nothing and cannot disable the tool.
 */

const cache = new Map<string, { stamp: string; loaded: LoadedLimits }>();

export function loadSubagentLimits(cwd: string, trusted: boolean, agentDir: string = getAgentDir()): LoadedLimits {
	const paths = [join(agentDir, "extensions", EXTENSION_CONFIG_SLUG, "config.json")];
	if (trusted) paths.push(join(cwd, CONFIG_DIR_NAME, "extensions", EXTENSION_CONFIG_SLUG, "config.json"));
	const stamp = paths.map((file) => `${file}=${safeMtime(file)}`).join("|");
	const hit = cache.get("limits");
	if (hit && hit.stamp === stamp) return hit.loaded;

	const loaded: LoadedLimits = {
		limits: { ...DEFAULT_LIMITS },
		origins: {},
		effectiveRoles: {} as RoleTable,
		roleOrigins: {},
		toolOrigins: {},
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
		const enabled = readBoolean(section, "enabled", `${file}: subagent.enabled`, loaded.errors);
		if (enabled !== undefined) {
			loaded.limits = { ...loaded.limits, enabled };
			loaded.origins.enabled = file;
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
		const tool = readToolPrompt(section.tool, file, loaded.errors);
		if (tool) {
			// Per key, last file wins — the same merge `roles` uses, so a project file may reword one string.
			const merged: SubagentToolPrompt = { ...loaded.limits.tool };
			if (tool.description !== undefined) {
				merged.description = tool.description;
				loaded.toolOrigins.description = file;
			}
			if (tool.promptSnippet !== undefined) {
				merged.promptSnippet = tool.promptSnippet;
				loaded.toolOrigins.promptSnippet = file;
			}
			if (tool.promptGuidelines !== undefined) {
				merged.promptGuidelines = tool.promptGuidelines;
				loaded.toolOrigins.promptGuidelines = file;
			}
			loaded.limits = { ...loaded.limits, tool: merged };
		}
		const askToExtend = readBoolean(section, "askToExtend", `${file}: subagent.askToExtend`, loaded.errors);
		if (askToExtend !== undefined) {
			loaded.limits = { ...loaded.limits, askToExtend };
			loaded.origins.askToExtend = file;
		}
		const delegationPrompt = readBoolean(section, "delegationPrompt", `${file}: subagent.delegationPrompt`, loaded.errors);
		if (delegationPrompt !== undefined) {
			loaded.limits = { ...loaded.limits, delegationPrompt };
			loaded.origins.delegationPrompt = file;
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
