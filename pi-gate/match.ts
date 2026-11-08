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
	const regex = compileRegexPattern(pattern);
	if (regex) return regexSource(regex, value);
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

/** The one prefix that turns a pattern into a regular expression. */
export const REGEX_PREFIX = "re:";

/** Longest accepted regex source: a runaway pattern is a hang, and a hang is an outage (see {@link regexSource}). */
export const REGEX_MAX_SOURCE = 512;

const regexCache = new Map<string, RegExp | "invalid">();

/** True when a pattern is written in the regex form (`re:<source>`), before `~`/`$HOME` expansion. */
export function isRegexPattern(pattern: string): boolean {
	return pattern.startsWith(REGEX_PREFIX);
}

/**
 * A pattern is a regular expression only when it is written as `re:<source>` — the sigil is explicit
 * because a glob and a regex cannot be told apart by eye (`*.env` is a valid regex matching almost
 * nothing), and a silently-misread rule is a rule that lets the wrong call through.
 *
 * Cached, and `undefined` for anything that is not a regex or does not compile: an invalid pattern is
 * reported by {@link regexPatternError} at config-settle and matches nothing, so a typo can never widen
 * a rule — it can only ever fail to match, which the floors still catch.
 */
export function compileRegexPattern(pattern: string): RegExp | undefined {
	if (!isRegexPattern(pattern)) return undefined;
	const cached = regexCache.get(pattern);
	if (cached === "invalid") return undefined;
	if (cached) return cached;
	const source = pattern.slice(REGEX_PREFIX.length);
	let compiled: RegExp | undefined;
	try {
		compiled = source && source.length <= REGEX_MAX_SOURCE ? new RegExp(source, "i") : undefined;
	} catch {
		compiled = undefined;
	}
	regexCache.set(pattern, compiled ?? "invalid");
	return compiled;
}

/**
 * A shape that makes a match exponential: a quantified group whose body is itself quantified (`(a+)+`),
 * or the same class quantified twice in a row (`a*a*`, `(a|a)*`).
 *
 * JavaScript gives no way to interrupt a running `RegExp.test`, and the wall-clock budget around it only
 * stops *later* probes — the first catastrophic match runs to completion. So the honest mitigation is to
 * refuse the shape where a human can still read the message: at config load, in the file, before any
 * tool call has to wait for it.
 */
export function catastrophicBacktrack(source: string): string | undefined {
	if (/\((?![?*+])[a-z0-9_.\\\]\[]?[^()]*[+*]\)\s*[+*]/i.test(source) || /\)[+*]\s*[+*]/.test(source)) {
		return "nested quantifier, e.g. `(a+)+`";
	}
	if (/\(\s*\?[^)]*\|/.test(source)) return "an alternation of prefixes inside a quantified group";
	return undefined;
}

/** Why a `re:` pattern will never match, or `undefined` when it is fine. */
export function regexPatternError(pattern: string): string | undefined {
	if (!isRegexPattern(pattern)) return undefined;
	const source = pattern.slice(REGEX_PREFIX.length);
	if (!source.trim()) return `"${pattern}" has an empty regex after "${REGEX_PREFIX}"`;
	if (source.length > REGEX_MAX_SOURCE) return `"${pattern}" is over the ${REGEX_MAX_SOURCE}-character regex limit`;
	try {
		new RegExp(source, "i");
	} catch (error) {
		return `"${pattern}" is not a valid regex: ${error instanceof Error ? error.message : String(error)}`;
	}
	const blowup = catastrophicBacktrack(source);
	return blowup ? `"${pattern}" can blow up on a long argument (${blowup}) and was refused; a bounded glob or a more specific pattern is the fix` : undefined;
}

/**
 * `re:` patterns are **unanchored** — `re:aliyuncs` matches a URL containing it — because a rule the
 * human wrote to block a domain must not depend on remembering to wrap it in `.*`.
 *
 * Bounded by wall clock, not by steps: a backtracking pattern (`re:(a+)+b`) on a long argument can run
 * for minutes, and a gate that never answers is worse than a gate that denies. On timeout the match
 * **fails open to the stricter answer** — `false`, meaning "this rule does not allow it", so an allow
 * rule stops applying and the default (`ask`) stands — and the pattern is reported.
 */
const REGEX_BUDGET_MS = 50;

export function regexSource(regex: RegExp, value: string): boolean {
	// The budget is checked *around* the match, because JavaScript offers no way to interrupt one: a pattern
	// that starts inside its window is allowed to finish, and a probe arriving after the window is refused
	// without running. That bounds a catastrophic pattern across one call's many facts — every segment
	// against every rule is where a runaway regex would otherwise multiply.
	if (Date.now() > regexDeadline(regex)) {
		regexPatternTimeouts.add(regex.source);
		return false;
	}
	// A pathological pattern on an unbounded argument is the other half of the risk; a command is short,
	// and a rule about character 5000 of a tool argument is not one a human wrote deliberately.
	const probe = value.length > REGEX_MAX_VALUE ? value.slice(0, REGEX_MAX_VALUE) : value;
	try {
		return regex.test(probe);
	} catch {
		return false;
	}
}

/**
 * The budget for one regex, restarted at the start of every evaluation round (see
 * {@link beginRegexRound}). A per-regex deadline that is never restarted is a trap: the first slow probe
 * would mark the pattern spent **forever**, and an `allow` rule would silently stop allowing while a
 * `deny` rule silently stopped denying — the worst possible failure for a gate, because it is invisible.
 */
const regexDeadlines = new WeakMap<RegExp, number>();

function regexDeadline(regex: RegExp): number {
	const seen = regexDeadlines.get(regex);
	if (seen !== undefined && seen >= regexRoundStart) return seen;
	const next = Date.now() + REGEX_BUDGET_MS;
	regexDeadlines.set(regex, next);
	return next;
}

let regexRoundStart = 0;

/**
 * Start a fresh time budget for every `re:` rule for the duration of one call's evaluation. `policy.ts`
 * calls this once per `evaluate`, so a slow pattern costs at most one budget per call, never one per
 * process, and never a permanent dead rule.
 */
export function beginRegexRound(): void {
	regexRoundStart = Date.now();
}

const REGEX_MAX_VALUE = 4096;

/** Regex sources whose match ran past the budget — surfaced by `/gatec status` (a slow rule is a bug). */
export const regexPatternTimeouts = new Set<string>();

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
