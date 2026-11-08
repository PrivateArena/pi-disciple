/**
 * The `re:` pattern dialect and its per-round match budget (plan step 3, split out of `match.ts`).
 *
 * A leaf module: it reads nothing but its own state, so every other matching module and the config
 * contract can depend on it without reaching back up the layering.
 */

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

/**
 * The longest string a bounded regex probe reads. Exported as {@link REGEX_PROBE_LIMIT} because anything a
 * `re:` rule is meant to judge has to fit inside it — a longer value is silently cut from the end, which is
 * where a scanned message tail keeps the interesting part.
 */
export const REGEX_PROBE_LIMIT = 4096;

const REGEX_MAX_VALUE = REGEX_PROBE_LIMIT;

/** Regex sources whose match ran past the budget — surfaced by `/gatec status` (a slow rule is a bug). */
export const regexPatternTimeouts = new Set<string>();
