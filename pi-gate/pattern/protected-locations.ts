/**
 * The protected-location floor: paths and directories no `allow` rule may resolve below
 * (plan step 3, split out of `match.ts`).
 */

import { resolve } from "node:path";
import { isUnder, pathPatternMatches } from "./path-spellings.ts";

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
