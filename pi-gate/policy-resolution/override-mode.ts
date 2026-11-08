/**
 * The layer above the precedence ladder: "allow everything" mode and the `hardDeny` list a mode cannot
 * swallow (plan step 7, split out of `policy.ts`).
 */

import { type HardDenyRule } from "../config-contract/action-vocabulary.ts";
import { type Facts, isShellTool } from "../inspect.ts";
import { type Policy } from "./call-decision.ts";
import { patternMatches } from "./surface-matching.ts";

/**
 * "Allow everything" mode. `until === null` runs until the session ends; a timestamp closes the window
 * then.
 *
 * It is absolute: while it is active no `tool_call` reaches the dialog — not a protected path, not
 * pi's own config, not a config file too broken to parse. That is the point: it is chosen by a human
 * who is about to walk away (an overnight run), and a switch that keeps asking is not a switch.
 * Floors stay as *labels* on a decision, so an audit log still says why a call looked unusual.
 *
 * Two things still hold, and neither can produce a dialog: a `deny` rule blocks (an explicit
 * instruction outranks a mode), and the mode is never inferable from config or from the model.
 */
export interface AllowAll {
	until: number | null;
}

/** Length of the "Allow everything for 5 minutes" window. */
export const ALLOW_ALL_WINDOW_MS = 5 * 60 * 1000;

/** The same window in the unit the human is told it in. */
export const ALLOW_ALL_WINDOW_MINUTES = Math.round(ALLOW_ALL_WINDOW_MS / 60_000);

/**
 * The `gate.hardDeny` check: the one deny class the "allow everything" mode cannot swallow.
 *
 * It looks at **everything** the call touches — every fact value on every surface, every path spelling,
 * every host — because the thing a human wrote a hardDeny about is a thing, not a surface: a host
 * appears as a `network` fact, inside a `bash` segment and inside a `curl` argument rendering, and a rule
 * that only checked the surface it was keyed to would miss the call that spells it differently. Surface
 * filtering is by {@link patternMatches} semantics, so a `path` rule uses the path matcher, a `network`
 * rule the domain matcher, and a shell segment still matches a chained pattern segment by segment.
 *
 * First match wins, and the offending value comes back so the block text can name what tripped.
 */
export function matchHardDeny(facts: Facts, policy: Policy): { rule: HardDenyRule; value: string } | undefined {
	if (policy.hardDeny.length === 0) return undefined;
	const shell = isShellTool(facts.toolName);
	const shellValues = facts.surfaces.find(([surface]) => surface === facts.toolName)?.[1] ?? [];
	const probes: Array<{ surface: string; value: string; segments?: readonly string[] }> = [];
	for (const [surface, values] of facts.surfaces) {
		const segments = shell && surface === facts.toolName ? shellValues : undefined;
		for (const value of values) probes.push({ surface, value, ...(segments ? { segments } : {}) });
	}
	for (const spelling of facts.paths) probes.push({ surface: "path", value: spelling });
	for (const rule of policy.hardDeny) {
		for (const probe of probes) {
			if (rule.surface !== "*" && rule.surface !== probe.surface && rule.surface !== facts.toolName) continue;
			if (patternMatches(probe.surface, rule.pattern, probe.value, probe.segments)) return { rule, value: probe.value };
		}
	}
	return undefined;
}

export function allowAllActive(allowAll: AllowAll | undefined, now: number): boolean {
	if (!allowAll) return false;
	return allowAll.until === null || now < allowAll.until;
}
