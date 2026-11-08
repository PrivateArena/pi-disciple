/**
 * Path spellings and path pattern matching (plan step 3, split out of `match.ts`).
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { expandHome, wildcardMatch } from "./glob.ts";

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
