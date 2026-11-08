import { beginRegexRound } from "../pattern/regex-dialect.ts";
import { displaySnippet } from "../render/text.ts";
import { redact } from "../log.ts";
import { type GuardConfig } from "../config-contract/guard-section.ts";

/**
 * The detection entry point: run the live rules over one message, apply the `allowPatterns` veto and the
 * thinking-tail fallback, and return the one hit the reminder will describe.
 */

import { EVIDENCE_CHARS, THINKING_RULE_ID, THINKING_TAIL_CHARS } from "./guard-limits.ts";
import { buildScan } from "./message-scan.ts";
import { type GuardHit } from "./guard-rule.ts";
import { ruleCallTag } from "./detectors/tag-rules.ts";
import { ruleChatTemplate, ruleSpecialToken } from "./detectors/protocol-tokens.ts";
import { BUILTIN_RULES, builtinRuleIds, matchConfiguredPattern } from "./rule-registry.ts";

export interface GuardInput {
	/** Concatenated text blocks of the assistant message. */
	text: string;
	/** Concatenated thinking blocks — consulted only when `text` is empty. */
	thinking: string;
	toolNames: ReadonlySet<string>;
	config: GuardConfig;
	/** Rule ids the human switched off for this session (`/gatec guard disable <id>`). */
	sessionDisabled?: ReadonlySet<string>;
}

/** Rule ids in force, for `/gatec`. */
export function activeRuleIds(config: GuardConfig, sessionDisabled: ReadonlySet<string> = new Set()): string[] {
	const disabled = new Set([...config.disableRules, ...sessionDisabled]);
	const ids = builtinRuleIds().filter((id) => !disabled.has(id));
	return [...(config.checkEmptyThinking ? ids : ids.filter((id) => id !== THINKING_RULE_ID)), ...config.rules.map((rule) => rule.id)];
}

function makeHit(rules: string[], label: string, advice: string | undefined, evidence: string): GuardHit {
	// `redact()` is command-shaped (`API_KEY=…`, `token: …`) and best effort. It cannot be a promise here: the
	// same bytes are already in the session transcript verbatim, so this is about the log file, not about a
	// secret the model has not already seen.
	return { rules, label, advice, evidence: displaySnippet(redact(evidence), EVIDENCE_CHARS) };
}

/**
 * Look at one finished assistant message and decide whether it is a call that never became one.
 *
 * `undefined` means "this message is an answer" — the honest answer almost always, and the reason the shape
 * tests are strict rather than generous.
 */
export function detectMalformedCall(input: GuardInput): GuardHit | undefined {
	const { config } = input;
	const disabled = new Set([...config.disableRules, ...(input.sessionDisabled ?? [])]);
	beginRegexRound();

	// A human's veto wins over every detector, including on text a rule would otherwise read.
	if (config.allowPatterns.some((pattern) => matchConfiguredPattern(pattern, input.text) !== undefined)) return undefined;

	if (input.text.trim() === "") {
		if (!config.checkEmptyThinking || disabled.has(THINKING_RULE_ID)) return undefined;
		const scan = buildScan(input.thinking.slice(-THINKING_TAIL_CHARS), input.toolNames, config);
		for (const rule of [ruleCallTag, ruleSpecialToken, ruleChatTemplate]) {
			const evidence = rule.test(scan);
			if (evidence !== undefined) return makeHit([THINKING_RULE_ID, rule.id], `${rule.label}, and the message had no text at all`, undefined, evidence);
		}
		return undefined;
	}

	const scan = buildScan(input.text, input.toolNames, config);
	const fired = new Map<string, { label: string; evidence: string; advice?: string }>();
	for (const rule of BUILTIN_RULES) {
		if (disabled.has(rule.id)) continue;
		const evidence = rule.test(scan);
		if (evidence !== undefined) fired.set(rule.id, { label: rule.label, evidence });
	}
	for (const rule of config.rules) {
		if (disabled.has(rule.id)) continue;
		const found = matchConfiguredPattern(rule.pattern, scan.prose);
		if (found !== undefined) fired.set(rule.id, { label: rule.label ?? `a message matching guard rule "${rule.id}"`, evidence: found, advice: rule.advice });
	}
	const first = fired.entries().next();
	if (first.done) return undefined;
	const detail = first.value[1];
	return makeHit([...fired.keys()], detail.label, detail.advice, detail.evidence);
}
