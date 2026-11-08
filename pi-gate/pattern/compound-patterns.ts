/**
 * Chained (`&&` / `||` / `;`) command patterns matched segment by segment
 * (plan step 3, split out of `match.ts`).
 */

import { wildcardMatch } from "./glob.ts";
import { normaliseCommand } from "./shell-commands.ts";
import { segmentCommands } from "./shell-segmentation.ts";

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
