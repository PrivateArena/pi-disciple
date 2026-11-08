import { compileRegexPattern, regexSource } from "../pattern/regex-dialect.ts";
import { wildcardMatch } from "../pattern/glob.ts";

/**
 * The built-in rule registry and the way a config-written pattern is matched — the seam between the
 * detectors and `gate.guard.rules` / `.disableRules`.
 */

import { EVIDENCE_CHARS, THINKING_RULE_ID } from "./guard-limits.ts";
import { type Rule } from "./guard-rule.ts";
import { ruleCallFragment, ruleCallTag, ruleToolNameTag } from "./detectors/tag-rules.ts";
import { ruleJsonCall, ruleJsonTruncated } from "./detectors/json-rules.ts";
import { ruleChatTemplate, ruleSpecialToken } from "./detectors/protocol-tokens.ts";

export const BUILTIN_RULES: readonly Rule[] = [
	ruleCallTag,
	ruleCallFragment,
	ruleToolNameTag,
	ruleJsonCall,
	ruleJsonTruncated,
	ruleSpecialToken,
	ruleChatTemplate,
];

/** The rule ids a config may name — pinned to `GUARD_BUILTIN_RULE_IDS` by a test. */
export function builtinRuleIds(): string[] {
	return [...BUILTIN_RULES.map((rule) => rule.id), THINKING_RULE_ID];
}

/**
 * Match one configured pattern the way the rest of the gate matches patterns: `re:` unanchored through the
 * bounded regex probe, anything else as a glob. Returns evidence, or `undefined` for "no match".
 */
export function matchConfiguredPattern(pattern: string, text: string): string | undefined {
	const regex = compileRegexPattern(pattern);
	if (regex) {
		if (!regexSource(regex, text)) return undefined;
		return regex.exec(text)?.[0] ?? text.slice(-EVIDENCE_CHARS);
	}
	return wildcardMatch(pattern, text) ? text.slice(-EVIDENCE_CHARS) : undefined;
}
