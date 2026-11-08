/**
 * Turns a `tool_call` event into the facts the policy evaluates (plan step 4).
 *
 * A fact set has two parts: the *tool surface* (`bash` values are the individual command segments,
 * `read` values are the path spellings, an unknown tool's values are a compact rendering of its
 * arguments) and `paths`, every spelling of every path the call touches — including shell redirect
 * targets, which are the only way a bash call writes outside its own surface. The cross-cutting
 * `path` and `external_directory` surfaces are derived from `paths` by `policy.ts`.
 *
 * The third question a call can raise is *where it connects* (plan step B): the `network` surface holds
 * the host facts, produced by `network.ts` for shell segments and by a parameter-name scan for the
 * unknown/MCP tools that take a `url`. It rides in `surfaces` rather than in a new `Facts` field: a
 * surface is data, and adding a field per surface would make every new question a schema change.
 */

import { pathSpellings } from "./pattern/path-spellings.ts";
import { normaliseCommand } from "./pattern/shell-commands.ts";
import { peelEnvPrefix, segmentCommands, tokenize } from "./pattern/shell-segmentation.ts";
import { displaySnippet } from "./render/text.ts";
import { pushUnique } from "./ordered-unique.ts";
import { isLoopbackHost, looksLikeUrl, networkTargets, parseNetworkTarget } from "./network.ts";

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

/**
 * The parameter names an unknown/MCP tool uses for a remote target (plan step B2) — the mirror of
 * {@link PATH_PARAM_NAMES}. A tool that takes a `url` can leave the machine, and the gate may never
 * have heard of the tool, so the parameter name is all there is to go on.
 */
export const NETWORK_PARAM_NAMES = ["url", "uri", "endpoint", "href"];

/** `>`/`>>`/`<`/`2>`/`&>` targets. */
const REDIRECT_RE = /(?:\d*&?>{1,2}|<{1,2})\s*("[^"]*"|'[^']*'|[^\s;|&()<>]+)/g;

/**
 * True for a token that names a file on this machine.
 *
 * A URL and an scp-style remote are **not** files (plan step D1): before this exclusion,
 * `https://aliyuncs.com/x` contained a `/` and so became a cwd-relative `path` fact — a location rule
 * the human could neither read nor satisfy, which also hid the fact that matters, the host. Everything
 * else here is unchanged: this is still a syntactic guess about an argv token, not a filesystem probe.
 */
export function looksLikePath(token: string): boolean {
	if (!token) return false;
	if (looksLikeUrl(token)) return false;
	// `user@host:/path` — a file on *another* machine, so not a path this filesystem has a rule about.
	if (/^[^/\\@]+(?::[^@/]*)?@[^/\\@]+:/.test(token)) return false;
	if (/^([/\\]|~[/\\]|\.\.?[/\\]|\$HOME[/\\])/.test(token)) return true;
	if (token.includes("/")) return true;
	return /^\.{0,2}[A-Za-z0-9_.+-]*\.[A-Za-z][A-Za-z0-9]*$/.test(token);
}

export function redirectTargets(seg: string): string[] {
	const out: string[] = [];
	for (const match of seg.matchAll(REDIRECT_RE)) {
		const target = (match[1] ?? "").replace(/^["']|["']$/g, "");
		// A URL after `>` is not a file: `cat x > https://evil.com/y` writes a file called `https:/evil.com/y`
		// on no system, and resolving it against the cwd produced a *path* fact that no rule could have meant.
		// The host is the fact, and `networkTargets` reports it (step D).
		if (!target || target.startsWith("(") || target === "/dev/null" || looksLikeUrl(target)) continue;
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

/** Host facts, deduped, in the order the call spelled them (plan step B2: `networkTargets` per segment). */
function hostFacts(segments: string[]): string[] {
	const out: string[] = [];
	for (const seg of segments) {
		for (const host of networkTargets(seg, "")) pushUnique(out, host);
	}
	return out;
}

const shellExtractor = (surface: string): Extractor => (input, cwd) => {
	const command = stringParam(input, "command") ?? "";
	const segments = segmentCommands(command).map(normaliseCommand);
	const values = segments.length ? segments : command.trim() ? [normaliseCommand(command)] : [];
	const paths = [...new Set(segments.flatMap((seg) => shellPathTokens(seg, cwd)))];
	const hosts = hostFacts(segments);
	// The dialog shows the operators the human actually wrote (`|`, `;`, `||`), not a lossy `&&` join.
	const preview = values.length ? normaliseCommand(command) : undefined;
	return { surfaces: [[surface, values], ["network", hosts]], paths, preview };
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

/**
 * Host facts from a tool's own parameters, for the tools this project has never heard of. A
 * `fetch`-shaped MCP tool names nothing the shell extractors would ever see.
 *
 * Both shapes are scanned: the `scheme://` URL, and the bare `example.com/data` argument a client
 * library takes (its host is still what the call reaches, which is what this surface is about).
 */
function scanNetworkParams(input: Record<string, unknown>): string[] {
	const tokens: string[] = [];
	for (const name of NETWORK_PARAM_NAMES) {
		const value = input[name];
		if (typeof value === "string") tokens.push(...value.split(/\s+/));
		else if (Array.isArray(value)) {
			for (const item of value) if (typeof item === "string") tokens.push(...item.split(/\s+/));
		}
	}
	const out: string[] = [];
	for (const token of tokens) {
		const target = parseNetworkTarget(token);
		if (!target || isLoopbackHost(target.host)) continue;
		pushUnique(out, target.host);
	}
	return out;
}

/** Unknown tools (MCP, future built-ins): surface = tool name, paths from a parameter name scan. */
export const defaultExtractor: Extractor = (input, cwd) => {
	const scalars = Object.entries(input).filter(([, value]) => value === null || typeof value !== "object");
	const rendered = scalars.length ? JSON.stringify(Object.fromEntries(scalars)) : "";
	return {
		surfaces: [[(input.toolName as string) ?? "call", rendered ? [rendered] : []], ["network", scanNetworkParams(input)]],
		paths: scanPathParams(input, cwd),
	};
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
		for (const value of values) pushUnique(bucket, value);
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
