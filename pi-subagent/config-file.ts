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
	files: string[];
	errors: string[];
}

const KEYS: readonly (keyof SubagentLimits)[] = ["maxTurns", "timeoutMinutes", "maxResultBytes", "keepTranscripts"];

/** Read the numeric limits plus the `enabled` switch; anything else in the section is ignored. */

const cache = new Map<string, { stamp: string; loaded: LoadedLimits }>();

export function loadSubagentLimits(cwd: string, trusted: boolean, agentDir: string = getAgentDir()): LoadedLimits {
	const paths = [join(agentDir, "extensions", "pi-gate", "config.json")];
	if (trusted) paths.push(join(cwd, CONFIG_DIR_NAME, "extensions", "pi-gate", "config.json"));
	const stamp = paths.map((file) => `${file}=${safeMtime(file)}`).join("|");
	const hit = cache.get("limits");
	if (hit && hit.stamp === stamp) return hit.loaded;

	const loaded: LoadedLimits = { limits: { ...DEFAULT_LIMITS }, files: [], errors: [] };
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
		}
		if (section.enabled !== undefined) {
			if (typeof section.enabled === "boolean") loaded.limits = { ...loaded.limits, enabled: section.enabled };
			else loaded.errors.push(`${file}: subagent.enabled must be a boolean, ignored`);
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
		const json = JSON.parse(text) as unknown;
		const section = (json as { subagent?: unknown })?.subagent;
		return section && typeof section === "object" && !Array.isArray(section) ? (section as Record<string, unknown>) : {};
	} catch (error) {
		errors.push(`${file}: invalid JSON, using default limits (${(error as Error).message})`);
		return undefined;
	}
}

function safeMtime(file: string): number {
	try {
		return existsSync(file) ? statSync(file).mtimeMs : 0;
	} catch {
		return 0;
	}
}
