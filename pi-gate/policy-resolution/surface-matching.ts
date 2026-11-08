/**
 * Surface-aware rule matching: which rule of which scope wins for one value of one surface
 * (plan step 6, split out of `policy.ts`).
 */

import { wildcardMatch } from "../pattern/glob.ts";
import { pathPatternMatches } from "../pattern/path-spellings.ts";
import { compoundPatternParts, matchesSegmentPattern } from "../pattern/compound-patterns.ts";
import { hostDomainMatches } from "../network.ts";
import { type Policy, type Rule, SPECIFICITY, isNetworkSurface } from "./call-decision.ts";

// ---------------------------------------------------------------------------

export function patternMatches(surface: string, pattern: string, value: string, segments?: readonly string[]): boolean {
	if (pattern === "*") return true;
	// A chained pattern (only ever offered for shell surfaces) describes the whole call, not one part.
	if (segments) {
		const parts = compoundPatternParts(pattern);
		if (parts) return matchesSegmentPattern(parts, segments);
	}
	// A host is matched as a *domain*, not as a spelling: `aliyuncs.com` has to cover `oss.aliyuncs.com`,
	// which no glob the human would write says and which `wildcardMatch` would answer by substring.
	if (isNetworkSurface(surface)) return hostDomainMatches(pattern, value);
	if (surface === "path" || surface === "external_directory") return pathPatternMatches(pattern, value);
	return wildcardMatch(pattern, value);
}

/**
 * The last rule matching one fact, with the named surface taking precedence over the `"*"`
 * tool-name wildcard (`permission["*"]` is the default for *all* surfaces, not a more specific rule).
 */
export function matchRule(surface: string, value: string, policy: Policy, isToolSurface: boolean, segments?: readonly string[]): Rule | undefined {
	let named: Rule | undefined;
	let generic: Rule | undefined;
	for (const rule of policy.rules) {
		if (!patternMatches(surface, rule.pattern, value, segments)) continue;
		if (rule.surface === surface) named = rule;
		// permission["*"] is the tool-name wildcard: it must not silence `path` / `external_directory`.
		else if (rule.surface === "*" && isToolSurface) generic = rule;
	}
	return named ?? generic;
}

/** {@link matchRule} plus how specifically the winning rule talks about this value. */
export function matchFact(surface: string, value: string, policy: Policy, isToolSurface: boolean, segments?: readonly string[]): { rule?: Rule; specificity: number } {
	const rule = matchRule(surface, value, policy, isToolSurface, segments);
	if (!rule) return { specificity: SPECIFICITY.fallback };
	if (rule.surface === "*") return { rule, specificity: SPECIFICITY.generic };
	return { rule, specificity: rule.pattern === "*" ? SPECIFICITY.classWide : SPECIFICITY.scoped };
}
