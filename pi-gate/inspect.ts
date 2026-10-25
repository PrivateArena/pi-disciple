/**
 * Turns a `tool_call` event into the facts the policy evaluates (plan step 4).
 *
 * A fact set has two parts: the *tool surface* (`bash` values are the individual command segments,
 * `read` values are the path spellings, an unknown tool's values are a compact rendering of its
 * arguments) and `paths`, every spelling of every path the call touches — including shell redirect
 * targets, which are the only way a bash call writes outside its own surface. The cross-cutting
 * `path` and `external_directory` surfaces are derived from `paths` by `policy.ts`.
 */

import { displaySnippet, normaliseCommand, pathSpellings, peelEnvPrefix, segmentCommands, tokenize } from "./match.ts";

export interface Facts {
	toolName: string;
	callId: string;
	parentCallId?: string;
	cwd: string;
	/** The tool's own surface plus any extractor-specific extra surfaces. */
	surfaces: Array<[surface: string, values: string[]]>;
	/** Every spelling of every path the call touches. */
	paths: string[];
	preview: string;
}

export type Extractor = (
	input: Record<string, unknown>,
	cwd: string,
) => {
	surfaces: Array<[surface: string, values: string[]]>;
	paths: string[];
	/** Verbatim call text for the dialog; defaults to the fact values joined with `&&`. */
	preview?: string;
};

const SHELL_TOOLS: readonly string[] = ["bash", "powershell"];
const PATH_PARAM_NAMES = [
	"path",
	"paths",
	"file",
	"files",
	"file_path",
	"filePath",
	"dir",
	"directory",
	"cwd",
	"source",
	"destination",
];

/** `>`/`>>`/`<`/`2>`/`&>` targets. */
const REDIRECT_RE = /(?:\d*&?>{1,2}|<{1,2})\s*("[^"]*"|'[^']*'|[^\s;|&()<>]+)/g;

export function looksLikePath(token: string): boolean {
	if (!token) return false;
	if (/^([/\\]|~[/\\]|\.\.?[/\\]|\$HOME[/\\])/.test(token)) return true;
	if (token.includes("/")) return true;
	return /^\.{0,2}[A-Za-z0-9_.+-]*\.[A-Za-z][A-Za-z0-9]*$/.test(token);
}

export function redirectTargets(seg: string): string[] {
	const out: string[] = [];
	for (const match of seg.matchAll(REDIRECT_RE)) {
		const target = (match[1] ?? "").replace(/^["']|["']$/g, "");
		if (!target || target.startsWith("(") || target === "/dev/null") continue;
		out.push(target);
	}
	return out;
}

function stringParam(input: Record<string, unknown>, name: string): string | undefined {
	const value = input[name];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function scanPathParams(input: Record<string, unknown>, cwd: string): string[] {
	const out: string[] = [];
	for (const name of PATH_PARAM_NAMES) {
		const value = input[name];
		if (typeof value === "string") {
			for (const part of value.split(/\r?\n/)) out.push(...pathSpellings(part, cwd));
		} else if (Array.isArray(value)) {
			for (const item of value) if (typeof item === "string") out.push(...pathSpellings(item, cwd));
		}
	}
	return out;
}

/** Path-looking argument tokens of a shell segment, plus its redirect targets. */
function shellPathTokens(seg: string, cwd: string): string[] {
	const out: string[] = [];
	const tokens = tokenize(seg);
	for (let i = 1; i < tokens.length; i++) {
		const raw = tokens[i]!;
		if (/^[-<>|&]/.test(raw) || raw === "--") continue;
		if (!looksLikePath(raw)) continue;
		out.push(...pathSpellings(raw, cwd));
	}
	for (const target of redirectTargets(seg)) out.push(...pathSpellings(target, cwd));
	return out;
}

const shellExtractor = (surface: string): Extractor => (input, cwd) => {
	const command = stringParam(input, "command") ?? "";
	const segments = segmentCommands(command).map(normaliseCommand);
	const values = segments.length ? segments : command.trim() ? [normaliseCommand(command)] : [];
	const paths = [...new Set(segments.flatMap((seg) => shellPathTokens(seg, cwd)))];
	// The dialog shows the operators the human actually wrote (`|`, `;`, `||`), not a lossy `&&` join.
	const preview = values.length ? normaliseCommand(command) : undefined;
	return { surfaces: [[surface, values]], paths, preview };
};

const pathToolExtractor = (surface: string, fallbackPath?: string): Extractor => (input, cwd) => {
	const raw = stringParam(input, "path") ?? stringParam(input, "file") ?? fallbackPath;
	const spellings = raw ? pathSpellings(raw, cwd) : [];
	return { surfaces: [[surface, spellings.length ? spellings : ["(no path)"]]], paths: spellings };
};

/** grep/find gate on their search pattern, and still touch a directory. */
const searchExtractor = (surface: string): Extractor => (input, cwd) => {
	const pattern = stringParam(input, "pattern") ?? "(no pattern)";
	const dir = stringParam(input, "path") ?? cwd;
	return { surfaces: [[surface, [pattern]]], paths: [...pathSpellings(dir, cwd), ...scanPathParams(input, cwd)] };
};

export const EXTRACTORS: Record<string, Extractor> = {
	bash: shellExtractor("bash"),
	powershell: shellExtractor("powershell"),
	read: pathToolExtractor("read"),
	write: pathToolExtractor("write"),
	edit: pathToolExtractor("edit"),
	grep: searchExtractor("grep"),
	find: searchExtractor("find"),
	ls: pathToolExtractor("ls", "."),
};

/** Unknown tools (MCP, future built-ins): surface = tool name, paths from a parameter name scan. */
export const defaultExtractor: Extractor = (input, cwd) => {
	const scalars = Object.entries(input).filter(([, value]) => value === null || typeof value !== "object");
	const rendered = scalars.length ? JSON.stringify(Object.fromEntries(scalars)).slice(0, 500) : "";
	return { surfaces: [[(input.toolName as string) ?? "call", rendered ? [rendered] : []]], paths: scanPathParams(input, cwd) };
};

export function extract(
	toolName: string,
	input: Record<string, unknown> | undefined,
	cwd: string,
	call: { callId: string; parentCallId?: string },
): Facts {
	const extractor = EXTRACTORS[toolName] ?? defaultExtractor;
	const extracted = extractor(input ?? {}, cwd);
	const surfaces = new Map<string, string[]>();
	for (const [surface, values] of extracted.surfaces) {
		const key = surface === "call" ? toolName : surface;
		const bucket = surfaces.get(key) ?? [];
		for (const value of values) if (!bucket.includes(value)) bucket.push(value);
		surfaces.set(key, bucket);
	}
	if (!surfaces.has(toolName)) surfaces.set(toolName, []);
	const paths = [...new Set(extracted.paths)];
	// The dialog must show the whole call, not one segment of it (§10 A2).
	const whole = extracted.preview ?? surfaces.get(toolName)?.join(" && ") ?? `${toolName} ${JSON.stringify(input ?? {})}`;
	const preview = displaySnippet(whole);
	return {
		toolName,
		callId: call.callId,
		parentCallId: call.parentCallId,
		cwd,
		surfaces: [...surfaces.entries()].filter(([, values]) => values.length > 0),
		paths,
		preview,
	};
}

/** The segments of a shell fact, `[]` for any other tool. */
export function shellSegments(facts: Facts): string[] {
	if (!SHELL_TOOLS.includes(facts.toolName)) return [];
	return facts.surfaces.find(([surface]) => surface === facts.toolName)?.[1] ?? [];
}

export function isShellTool(toolName: string): boolean {
	return SHELL_TOOLS.includes(toolName);
}

/** Env-prefix assignments stripped from a segment, so the dialog can show what was peeled. */
export function segmentEnvPrefix(seg: string): string[] {
	return peelEnvPrefix(seg).stripped;
}
