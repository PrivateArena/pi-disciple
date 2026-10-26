/**
 * Subagent limits (plan step 20).
 *
 * Intentionally a second, self-contained reader of the same two config files: it imports only a
 * *type* from `pi-gate/schema.ts`, which vanishes at runtime, so deleting `pi-gate` leaves
 * `subagent` working with the limits from the same file. No gate policy code is reachable from here.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubagentLimits } from "../pi-gate/schema.ts";

export type { SubagentLimits };

export const DEFAULT_LIMITS: SubagentLimits = { enabled: true, maxTurns: 30, timeoutMinutes: 20, maxResultBytes: 20000, keepTranscripts: 20 };

export interface LoadedLimits {
	limits: SubagentLimits;
	/**
	 * Which file supplied each non-default value. `/subagentc` shows it, so a pinned model or a tightened
	 * `maxTurns` can be traced to the global file or the project file without opening both.
	 */
	origins: Partial<Record<keyof SubagentLimits, string>>;
	files: string[];
	errors: string[];
}

const KEYS: readonly (keyof SubagentLimits)[] = ["maxTurns", "timeoutMinutes", "maxResultBytes", "keepTranscripts"];

/**
 * Read the numeric limits, the `enabled` switch and the `model` pin; anything else in the section is
 * ignored. A malformed value contributes an error and leaves that field at its previous value, so a
 * typo tightens nothing and cannot disable the tool.
 */

const cache = new Map<string, { stamp: string; loaded: LoadedLimits }>();

export function loadSubagentLimits(cwd: string, trusted: boolean, agentDir: string = getAgentDir()): LoadedLimits {
	const paths = [join(agentDir, "extensions", "pi-gate", "config.json")];
	if (trusted) paths.push(join(cwd, CONFIG_DIR_NAME, "extensions", "pi-gate", "config.json"));
	const stamp = paths.map((file) => `${file}=${safeMtime(file)}`).join("|");
	const hit = cache.get("limits");
	if (hit && hit.stamp === stamp) return hit.loaded;

	const loaded: LoadedLimits = { limits: { ...DEFAULT_LIMITS }, origins: {}, files: [], errors: [] };
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
			if (typeof section.model === "string" && section.model.trim()) {
				loaded.limits = { ...loaded.limits, model: section.model.trim() };
				loaded.origins.model = file;
			} else loaded.errors.push(`${file}: subagent.model must be a non-empty string like "provider/id", ignored`);
		}
	}
	cache.set("limits", { stamp, loaded });
	return loaded;
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
		return existsSync(file) ? statSync(file).mtimeMs : 0;
	} catch {
		return 0;
	}
}

/**
 * Remove `//` and block comments outside string literals. Verbatim copy of `pi-gate/config-file.ts`
 * (same reasoning as `DEFAULT_LIMITS` above: importing the gate module would make this reader
 * depend on gate code it must not reach).
 */
export function stripJsonComments(text: string): string {
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
