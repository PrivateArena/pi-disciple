/**
 * What the *shape* of a rule says about it, independent of the surface it is written for
 * (plan step 3, split out of `match.ts`).
 */

import { expandHome } from "./glob.ts";
/**
 * True when a rule's pattern *is* the value — the human named this exact call, not a class of calls.
 * That distinction is what makes a floor survivable: `npx vitest run` allowed by name is a decision,
 * `npx *` allowed is a shortcut over arbitrary code, and only the second one the floor must refuse.
 */
export function isExactRule(rule: { pattern: string }, value: string): boolean {
	if (rule.pattern === "*") return value === "*";
	return rule.pattern === value || expandHome(rule.pattern) === value;
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
