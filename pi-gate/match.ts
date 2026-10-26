/**
 * Pure matching primitives for pi-gate (plan step 3).
 *
 * `segmentCommands()` is the only seam for a future real shell parser: everything else in the gate
 * consumes its output and never re-parses bash.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// glob matching
// ---------------------------------------------------------------------------

/**
 * `*` matches any characters including `/`, `?` matches exactly one character, `~` / `$HOME` are
 * expanded in the pattern. Matching is otherwise literal (no escape syntax by design: patterns are
 * hand-written in a small config file).
 *
 * A pattern ending in ` *` is the command-prefix form produced by {@link suggestBashPattern} and
 * also matches the bare prefix, so `git status *` covers a plain `git status`.
 */
export function wildcardMatch(pattern: string, value: string): boolean {
	const p = expandHome(pattern);
	if (p === "*") return true;
	if (p.endsWith(" *")) {
		const prefix = p.slice(0, -2);
		if (value === prefix || value.startsWith(`${prefix} `)) return true;
	}

	let pi = 0;
	let vi = 0;
	let starAt = -1;
	let starValueAt = 0;
	while (vi < value.length) {
		const pc = pi < p.length ? p[pi] : undefined;
		if (pc === "*") {
			starAt = pi;
			starValueAt = vi;
			pi++;
			continue;
		}
		if (pc === "?" || pc === value[vi]) {
			pi++;
			vi++;
			continue;
		}
		if (starAt >= 0) {
			pi = starAt + 1;
			starValueAt++;
			vi = starValueAt;
			continue;
		}
		return false;
	}
	while (p[pi] === "*") pi++;
	return pi === p.length;
}

export function expandHome(p: string): string {
	const home = homedir();
	if (p === "~") return home;
	if (p.startsWith("~/")) return resolve(home, p.slice(2));
	if (p === "$HOME") return home;
	if (p.startsWith("$HOME/")) return resolve(home, p.slice(6));
	return p;
}

/**
 * True when a rule's pattern *is* the value — the human named this exact call, not a class of calls.
 * That distinction is what makes a floor survivable: `npx vitest run` allowed by name is a decision,
 * `npx *` allowed is a shortcut over arbitrary code, and only the second one the floor must refuse.
 */
export function isExactRule(rule: { pattern: string }, value: string): boolean {
	if (rule.pattern === "*") return value === "*";
	return rule.pattern === value || expandHome(rule.pattern) === value;
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/**
 * Every spelling a path argument can take, so a rule cannot be dodged by `..`, a symlink or a
 * relative path: the lexical absolute path, and the realpath of its nearest existing ancestor.
 */
export function pathSpellings(p: string, cwd: string): string[] {
	const raw = p.trim();
	if (!raw) return [];
	const expanded = expandHome(raw);
	const lexical = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
	const out = new Set<string>([trimTrailingSlash(lexical)]);
	const real = realpathNearest(lexical);
	if (real) out.add(trimTrailingSlash(real));
	return [...out];
}

function trimTrailingSlash(p: string): string {
	return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
}

function realpathNearest(p: string): string | undefined {
	let cursor = p;
	const tail: string[] = [];
	for (let hops = 0; hops < 24; hops++) {
		try {
			if (existsSync(cursor)) return resolve(realpathSync(cursor), ...tail.reverse());
		} catch {
			/* fall through to the parent */
		}
		const parent = dirname(cursor);
		if (parent === cursor) return undefined;
		tail.push(basename(cursor));
		cursor = parent;
	}
	return undefined;
}

/** True when `child` is `parent` or below it (both must be absolute). */
export function isUnder(child: string, parent: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Path patterns also match the lowercased spelling, so `*.ENV` cannot dodge `*.env`.
 *
 * A directory pattern (`/x/y/*`, what {@link directoryPattern} writes) also matches `/x/y` itself: the
 * folder you allowed is the folder you can list, not only the files inside it.
 */
export function pathPatternMatches(pattern: string, spelling: string): boolean {
	if (wildcardMatch(pattern, spelling) || wildcardMatch(pattern, spelling.toLowerCase())) return true;
	const base = directoryOfPattern(expandHome(pattern));
	return base !== undefined && base === spelling;
}

/** The directory a `…/*` pattern names, or `undefined` for any other pattern. */
function directoryOfPattern(pattern: string): string | undefined {
	const match = /[/\\]\*+$/.exec(pattern);
	if (!match) return undefined;
	return trimTrailingSlash(pattern.slice(0, match.index));
}

/**
 * The folder-wide pattern for one path spelling: the directory that contains the file, plus `/*`.
 *
 * This is the unit a dialog grants for a file tool — the same granularity every other agent harness
 * uses for a sandbox escape, because "let it read this one config file" is not a decision a human
 * re-makes willingly for the next file in the same directory.
 */
export function directoryPattern(spelling: string): string {
	const clean = trimTrailingSlash(spelling);
	const dir = trimTrailingSlash(spelling.endsWith(sep) || isDirectory(clean) ? clean : dirname(clean));
	return `${dir.endsWith(sep) ? dir : dir + sep}*`;
}

function isDirectory(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * True when a rule names a specific class of things (`/secrets/*`, `git push *`) rather than a whole
 * surface (`"*"`, or the tool-name wildcard). A scoped rule is a decision about *this* location or
 * command class, which is what lets a folder grant answer an `external_directory` floor.
 */
export function isScopedRule(rule: { surface: string; pattern: string } | undefined): boolean {
	if (!rule) return false;
	return rule.surface !== "*" && rule.pattern !== "*" && rule.pattern !== "";
}

/**
 * Floor (FM-7): paths no `allow` rule or grant may resolve below — the gate's own config, pi's
 * config dir, and git hooks (which execute as the user). "Floor" means at least `ask`, not `deny`.
 */
export const PROTECTED_PATH_GLOBS: readonly string[] = ["*/.git/hooks/*", "*/.husky/*"];

/**
 * Agent-dir paths that are code or configuration — the ones whose contents run, or decide what runs.
 * Deliberately *not* the whole agent dir: `sessions/`, `logs/` and `tmp/` hold transcripts, and
 * flooring those made every transcript read an un-silenceable dialog under "allow everything".
 */
export const PROTECTED_AGENT_ENTRIES: readonly string[] = [
	"extensions/*",
	"bin/*",
	"npm/*",
	"git/*",
	"settings.json",
	"auth.json",
	"models.json",
	"models-store.json",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
];

export function protectedPathGlobs(cwd: string, agentDir: string): string[] {
	const agent = stripTrailing(agentDir);
	return [
		...PROTECTED_AGENT_ENTRIES.map((entry) => `${agent}/${entry}`),
		`${stripTrailing(cwd)}/.pi/extensions/*`,
		`${stripTrailing(cwd)}/.pi/settings.json`,
		...PROTECTED_PATH_GLOBS,
	];
}

function stripTrailing(p: string): string {
	return p.replace(/[/\\]+$/, "");
}

export function isProtectedPath(spellings: readonly string[], globs: readonly string[]): boolean {
	return spellings.some((s) => globs.some((g) => pathPatternMatches(g, s)));
}

/** A path is external when no spelling of it is under the session cwd. */
export function isExternalPath(spellings: readonly string[], cwd: string): boolean {
	if (spellings.length === 0) return false;
	return spellings.every((s) => !isUnder(s, resolve(cwd)));
}

// ---------------------------------------------------------------------------
// bash segmentation
// ---------------------------------------------------------------------------

/** Quote-aware split of a command line into every command it can run. */
export function segmentCommands(command: string): string[] {
	const src = command.replace(/\\\r?\n/g, " ");
	const segments: string[] = [];
	let buf = "";
	let quote: '"' | "'" | null = null;
	let parenDepth = 0;

	const flush = () => {
		const seg = buf.trim();
		if (seg) segments.push(seg);
		buf = "";
	};

	for (let i = 0; i < src.length; i++) {
		const c = src[i]!;

		if (quote) {
			buf += c;
			if (c === quote && src[i - 1] !== "\\") quote = null;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			buf += c;
			continue;
		}
		if (c === "\\") {
			buf += c;
			if (i + 1 < src.length) buf += src[++i];
			continue;
		}

		// Heredoc body: copied verbatim, never split.
		if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "(") {
			const next = consumeHeredoc(src, i);
			buf += src.slice(i, next);
			i = next - 1;
			continue;
		}
		// Process substitution `<(` / `>(`: copied verbatim, never split.
		if ((c === "<" || c === ">") && src[i + 1] === "(") {
			const next = consumeBalanced(src, i + 1);
			buf += src.slice(i, next);
			i = next - 1;
			continue;
		}

		if (c === "(") {
			parenDepth++;
			buf += c;
			continue;
		}
		if (c === ")") {
			parenDepth = Math.max(0, parenDepth - 1);
			buf += c;
			continue;
		}
		if (parenDepth > 0) {
			buf += c;
			continue;
		}

		const two = src.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			flush();
			i++;
			continue;
		}
		// File-descriptor redirects (`2>&1`, `<&`, `&>`) are not command separators.
		if (c === "&" && (src[i - 1] === ">" || src[i - 1] === "<" || src[i + 1] === ">" || src[i + 1] === "&")) {
			buf += c;
			continue;
		}
		if (c === ";" || c === "\n" || c === "|" || c === "&") {
			flush();
			continue;
		}
		buf += c;
	}
	flush();
	return segments;
}

/** Index just past the whole heredoc (header line + body + terminator line). */
function consumeHeredoc(src: string, start: number): number {
	let i = start + 2;
	if (src[i] === "-") i++;
	while (src[i] === " " || src[i] === "\t") i++;
	let delim = "";
	while (i < src.length && /[^\s|&;<>()]/.test(src[i]!)) delim += src[i++];
	if (!delim) return start + 2;
	const bare = delim.replace(/^['"`]|['"`]$/g, "");
	if (!bare) return start + 2;
	const lineEnd = src.indexOf("\n", i);
	if (lineEnd < 0) return src.length;
	const terminator = new RegExp(`^[ \t]*${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \t]*$`);
	let cursor = lineEnd + 1;
	while (cursor < src.length) {
		const next = src.indexOf("\n", cursor);
		const line = src.slice(cursor, next < 0 ? src.length : next);
		if (terminator.test(line)) return next < 0 ? src.length : next + 1;
		if (next < 0) break;
		cursor = next + 1;
	}
	return src.length;
}

/** `start` points at "("; returns the index after the matching ")". */
function consumeBalanced(src: string, start: number): number {
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		if (src[i] === "(") depth++;
		else if (src[i] === ")") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return src.length;
}

/** `FOO=1 BAR=x cmd …` → the command part plus the stripped assignment names. */
export function peelEnvPrefix(seg: string): { command: string; stripped: string[] } {
	const tokens = tokenize(seg);
	const stripped: string[] = [];
	let i = 0;
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
		stripped.push(tokens[i]!.split("=")[0]!);
		i++;
	}
	return { command: tokens.slice(i).join(" "), stripped };
}

/** Quote-aware whitespace split. Expansion syntax is preserved, not evaluated. */
export function tokenize(seg: string): string[] {
	const out: string[] = [];
	let buf = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < seg.length; i++) {
		const c = seg[i]!;
		if (quote) {
			if (c === quote && seg[i - 1] !== "\\") quote = null;
			else buf += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			continue;
		}
		if (c === "\\") {
			buf += seg[++i] ?? "";
			continue;
		}
		if (/\s/.test(c)) {
			if (buf) {
				out.push(buf);
				buf = "";
			}
			continue;
		}
		buf += c;
	}
	if (buf) out.push(buf);
	return out;
}

/** Command substitution, backticks and process substitution are not parsed: they always escalate. */
export function hasUnparsedExpansion(seg: string): boolean {
	let quote: "'" | null = null;
	for (let i = 0; i < seg.length; i++) {
		const c = seg[i]!;
		if (c === "'") quote = quote ? null : "'";
		if (quote) continue;
		if (seg.startsWith("$(", i) || seg.startsWith("`", i) || seg.startsWith("<(", i) || seg.startsWith(">(", i)) return true;
	}
	return false;
}

/**
 * Commands that run something *else*, so an `allow` on them is meaningless: they always escalate to
 * `ask` (FM-8). Interpreters are listed separately because `python3 script.py` is only a wrapper
 * when it executes a code string (`-c` / `-e`) or appears in a pipe chain (`curl x | sh`).
 */
export const WRAPPER_COMMANDS: readonly string[] = [
	"sudo",
	"doas",
	"pkexec",
	"su",
	"env",
	"eval",
	"exec",
	"command",
	"nohup",
	"xargs",
	"watch",
	"timeout",
	"time",
	"npx",
	"dlx",
	"uvx",
];

export const INTERPRETER_COMMANDS: readonly string[] = [
	"sh",
	"bash",
	"zsh",
	"fish",
	"dash",
	"ksh",
	"python",
	"python3",
	"node",
	"deno",
	"bun",
	"perl",
	"ruby",
	"php",
];

export function commandName(seg: string): string {
	const head = tokenize(peelEnvPrefix(seg).command)[0] ?? "";
	return head.split("/").pop() ?? head;
}

/** True when the segment wraps another command or executes a code string. */
export function isWrappedSegment(seg: string, inPipeline = false): boolean {
	const name = commandName(seg);
	if (!name) return false;
	if (WRAPPER_COMMANDS.includes(name)) return true;
	if (!INTERPRETER_COMMANDS.includes(name)) return false;
	const tokens = tokenize(seg);
	if (tokens.some((t) => /^-[a-z]*c$/.test(t) || t === "-e" || t === "--exec" || t === "--eval")) return true;
	return inPipeline;
}

/** Sub-command depth of the grantable prefix (git→2, so `git status *` rather than `git *`). */
export const BASH_ARITY: Record<string, number> = {
	git: 2,
	npm: 2,
	pnpm: 2,
	yarn: 2,
	bun: 2,
	go: 2,
	cargo: 2,
	docker: 2,
	pip: 2,
	pip3: 2,
	uv: 2,
	gh: 2,
	kubectl: 2,
	apt: 2,
	"apt-get": 2,
	brew: 2,
};

export function normaliseCommand(seg: string): string {
	return seg.replace(/\s+/g, " ").trim();
}

/**
 * Suggested grant pattern for a bash segment.
 *
 * `persisted` scopes (project / all projects) get the **exact** command (FM-10): `pnpm *` would be
 * arbitrary code execution committed to git from one click. Wildcards are only used in memory —
 * and never for a wrapper or interpreter segment, whose wildcard would outlive the call it came
 * from (`sh evil.sh` must not be covered by a session grant made for `curl x | sh`).
 */
export function suggestBashPattern(seg: string): string {
	const normalised = normaliseCommand(seg);
	if (isWrappedSegment(normalised, true) || isDestructiveHead(normalised)) return normalised;
	const tokens = tokenize(peelEnvPrefix(normalised).command);
	if (tokens.length === 0) return normalised;
	const name = tokens[0]!.split("/").pop()!;
	const arity = BASH_ARITY[name] ?? 1;
	return `${tokens.slice(0, Math.min(arity, tokens.length)).join(" ")} *`;
}

/**
 * Commands whose wildcard form is far broader than the call the human actually looked at: `rm *` is not
 * "the same kind of thing" as `rm -rf build`, it is permission to delete anything. These keep the
 * exact command in every scope, which is what the dialog text promises.
 */
export const DESTRUCTIVE_HEADS: ReadonlySet<string> = new Set([
	"rm",
	"rmdir",
	"unlink",
	"shred",
	"truncate",
	"dd",
	"mkfs",
	"fdisk",
	"parted",
	"mount",
	"umount",
	"mv",
	"chown",
	"chgrp",
	"chmod",
	"kill",
	"pkill",
	"killall",
	"sudo",
	"doas",
	"su",
	"systemctl",
	"service",
	"shutdown",
	"reboot",
	"halt",
	"poweroff",
	"nsenter",
	"useradd",
	"userdel",
	"usermod",
	"crontab",
]);

export function isDestructiveHead(seg: string): boolean {
	const tokens = tokenize(peelEnvPrefix(normaliseCommand(seg)).command);
	const name = (tokens[0] ?? "").split("/").pop() ?? "";
	return DESTRUCTIVE_HEADS.has(name);
}

// ---------------------------------------------------------------------------
// compound patterns
// ---------------------------------------------------------------------------

/**
 * The segments of a hand-written compound pattern (`git status * && npm test`), or `undefined`
 * when the pattern is a single command. Grant offers are per segment, but a config file may still
 * chain them, and a chained pattern has to match the call it was written for.
 */
export function compoundPatternParts(pattern: string): string[] | undefined {
	if (!/[|;&\n]/.test(pattern)) return undefined;
	const parts = segmentCommands(pattern).map(normaliseCommand).filter(Boolean);
	return parts.length > 1 ? parts : undefined;
}

/**
 * True when every pattern segment matches a **distinct** command segment. Matching is
 * order-independent — `a && b` and `b && a` are the same set of side effects — and a pattern may
 * not cover more segments than the call has, so a chained pattern never allows one of its commands
 * on its own. Safety comes from the caller: every segment of a call must be allowed separately.
 */
export function matchesSegmentPattern(patternSegments: readonly string[], segments: readonly string[]): boolean {
	if (patternSegments.length === 0 || patternSegments.length > segments.length) return false;
	const used = new Array<boolean>(segments.length).fill(false);
	const assign = (from: number): boolean => {
		if (from >= patternSegments.length) return true;
		const part = patternSegments[from]!;
		for (let i = 0; i < segments.length; i++) {
			if (used[i] || !wildcardMatch(part, segments[i]!)) continue;
			used[i] = true;
			if (assign(from + 1)) return true;
			used[i] = false;
		}
		return false;
	};
	return assign(0);
}

/**
 * Markdown inline code. Front-ends render dialog text as markdown, so `*`, `_` and `[]` in a shell
 * command would be eaten as formatting; a code span is rendered verbatim. The fence grows past any
 * run of backticks in the value, so a command cannot close its own span early.
 */
export function codeSpan(value: string): string {
	const text = value.trim();
	if (!text) return "";
	let fence = "`";
	while (text.includes(fence)) fence = `${fence}\``;
	const pad = /^[`\s]|[`\s]$/.test(text) ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

/** Visibly truncated single-line text with a hard character budget (dialog labels). */
export function shorten(value: string, maxChars: number): string {
	if (maxChars <= 1 || value.length <= maxChars) return value;
	return `${value.slice(0, maxChars - 1)}…`;
}

/**
 * Redacted, control-character-free, single-line text.
 *
 * Uncapped by default: the human would rather scroll through a whole command than approve a snippet of
 * one (`[…truncated]` hid exactly the argument a decision turned on). Pass `maxChars` only where a
 * fixed budget really matters — the review log line.
 */
export function displaySnippet(value: string, maxChars = Number.POSITIVE_INFINITY): string {
	const clean = value
		.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (clean.length <= maxChars) return clean;
	return `${clean.slice(0, maxChars)} […truncated]`;
}
