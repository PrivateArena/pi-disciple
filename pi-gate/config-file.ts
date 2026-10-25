/**
 * Config file location and reading, shared in shape by both extensions (plan step 19).
 *
 * Pure data: no state, no policy, no pi-gate imports — `pi-subagent` uses it without `pi-gate`
 * being installed (step 20).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Both extensions read one file per scope; the gate also writes its grants into it (step 6). */
export const EXTENSION_CONFIG_SLUG = "pi-gate";

/** `<agentDir>/extensions/pi-gate/config.json`, honouring PI_CODING_AGENT_DIR. */
export function getGlobalConfigFile(agentDir: string = getAgentDir()): string {
	return join(agentDir, "extensions", EXTENSION_CONFIG_SLUG, "config.json");
}

/** `<cwd>/.pi/extensions/pi-gate/config.json` — only read for a trusted cwd (FM-6). */
export function getProjectConfigFile(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "extensions", EXTENSION_CONFIG_SLUG, "config.json");
}

export interface ConfigFileRead {
	file: string;
	/** Parsed document, or `undefined` when the file is missing or unparseable. */
	json: unknown;
	mtimeMs: number;
	/** Set when the file was missing, unparseable, or needed comment stripping. */
	error?: string;
}

export function readConfigFile(file: string): ConfigFileRead {
	let mtimeMs = 0;
	let text: string;
	try {
		if (!existsSync(file)) return { file, json: undefined, mtimeMs: 0, error: `${file} does not exist` };
		mtimeMs = statSync(file).mtimeMs;
		text = readFileSync(file, "utf8");
	} catch (error) {
		return { file, json: undefined, mtimeMs, error: `${file}: ${(error as Error).message}` };
	}
	const trimmed = text.trim();
	if (!trimmed) return { file, json: undefined, mtimeMs };
	try {
		return { file, json: JSON.parse(trimmed), mtimeMs };
	} catch {
		// Tolerate hand-written JSONC comments, but warn: a grants write re-serialises the file.
		const stripped = stripJsonComments(trimmed);
		try {
			return { file, json: JSON.parse(stripped), mtimeMs, error: `${file}: comments were stripped on read and will be lost on the next grants write` };
		} catch (error) {
			return { file, json: undefined, mtimeMs, error: `${file}: invalid JSON (${(error as Error).message})` };
		}
	}
}

export function configFileMtime(file: string): number {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Seed a missing config file with the shipped default text (step 2: "missing file → defaults, and a
 * copy of the shipped config is created"). Never overwrites, and never throws.
 */
export function writeDefaultConfig(file: string, text: string): { created: boolean; error?: string } {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, { encoding: "utf8", flag: "wx" });
		return { created: true };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return { created: false };
		return { created: false, error: (error as Error).message };
	}
}

/** Remove `//` and block comments outside string literals. */
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
