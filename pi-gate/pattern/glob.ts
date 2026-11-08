/**
 * The glob dialect of a gate pattern, plus `~`/`$HOME` expansion (plan step 3, split out of `match.ts`).
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { compileRegexPattern, regexSource } from "./regex-dialect.ts";

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

export function expandHome(p: string): string {
	const home = homedir();
	if (p === "~") return home;
	if (p.startsWith("~/")) return resolve(home, p.slice(2));
	if (p === "$HOME") return home;
	if (p.startsWith("$HOME/")) return resolve(home, p.slice(6));
	return p;
}
