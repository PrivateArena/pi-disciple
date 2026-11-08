/**
 * The `gate.guard` section: its types, its shipped default, its tolerant parser and the fold that
 * merges one block per file into the config the output guard runs (plan step 2, split out of `schema.ts`).
 */

import { REGEX_PROBE_LIMIT } from "../pattern/regex-dialect.ts";
import { checkedPattern, readBoolean, readNumber, trimmed } from "./tolerant-parse.ts";
import { isRecord } from "./action-vocabulary.ts";

/**
 * What the output guard does with a call the model wrote as text instead of making.
 *
 * `off` never looks. `notify` tells the human and logs, and lets the run end — the shape is reported but
 * the model is not interrupted. `remind` additionally appends a reminder and keeps the run going, which is
 * the only setting that saves the turn.
 */
export type GuardAction = "off" | "notify" | "remind";

export function isGuardAction(value: unknown): value is GuardAction {
	return value === "off" || value === "notify" || value === "remind";
}

/**
 * The rule ids the guard ships with — the vocabulary `disableRules` is written against, and what
 * `/gatec guard` lists. `guard.ts` implements exactly this set; a drift test pins the two together.
 */
export const GUARD_BUILTIN_RULE_IDS: readonly string[] = [
	"call-tag",
	"call-fragment",
	"tool-name-tag",
	"json-call",
	"json-call-truncated",
	"special-token",
	"chat-template-token",
	"call-in-thinking",
];

/**
 * One detector the human can switch off, add to, or re-word. `pattern` is matched against the scanned
 * tail of the assistant message exactly like every other gate pattern: a glob, or a regex with `re:`.
 */
export interface GuardRuleConfig {
	id: string;
	pattern: string;
	/** How the reminder names the shape; defaults to "a call written as message text". */
	label?: string;
	/** The instruction the reminder gives; defaults to the built-in one. */
	advice?: string;
}

export interface GuardConfig {
	enabled: boolean;
	action: GuardAction;
	/** Reminders per session. Restored by the next real tool call, so a run cannot be nudged to death. */
	maxReminders: number;
	/** Characters of message tail the rules read. Capped by the gate's regex probe budget (see `pattern/regex-dialect.ts`). */
	scanTailChars: number;
	/** Built-in rule ids to switch off, e.g. `["tool-name-tag"]` when the task is about XML tool syntax. */
	disableRules: string[];
	/** Extra detectors, same shape as `hardDeny`: concatenated across config files, never ordered. */
	rules: GuardRuleConfig[];
	/** Text these patterns match is *about* tool calls, not leaking one: the guard stays out. */
	allowPatterns: string[];
	/** Treat a tag named after one of the session's own tools (`<bash>`, `<read path=>`) as a leaked call. */
	matchToolNames: boolean;
	/** When a message has no text at all, look at the end of its thinking for the same shapes. */
	checkEmptyThinking: boolean;
}

/**
 * On by default: a call that silently ends the turn costs the whole run, and the guard's own cost is
 * bounded by {@link GuardConfig.maxReminders}. Every shape test is strict and lives in `guard.ts`; this is
 * only the switch, the budget and the human's additions.
 */
export const DEFAULT_GUARD_CONFIG: GuardConfig = {
	enabled: true,
	action: "remind",
	maxReminders: 3,
	scanTailChars: REGEX_PROBE_LIMIT,
	disableRules: [],
	rules: [],
	allowPatterns: [],
	matchToolNames: true,
	checkEmptyThinking: true,
};

/**
 * Parse one `gate.guard` block of one config file, returning only the keys that file wrote.
 *
 * Written-keys-only is what makes the layering behave: {@link mergeGuardConfigs} then lets a project file
 * change one number without re-deriving every other key from its own defaults, exactly like the scalar keys
 * of the rest of `gate`.
 *
 * `rules` are matched against message text, so an invalid pattern is refused the way every other gate pattern
 * is: reported at config-settle, matches nothing, and cannot widen or narrow anything.
 */
export function parseGuardConfig(raw: unknown, where: string, errors: string[]): Partial<GuardConfig> {
	const guard: Partial<GuardConfig> = {};
	if (!isRecord(raw)) {
		errors.push(`${where} must be an object, ignored`);
		return guard;
	}
	const doc = raw as Record<string, unknown>;
	const enabled = readBoolean(doc, "enabled", `${where}.enabled`, errors);
	if (enabled !== undefined) guard.enabled = enabled;
	if (doc.action !== undefined) {
		if (isGuardAction(doc.action)) guard.action = doc.action;
		else errors.push(`${where}.action must be "off"|"notify"|"remind", ignored`);
	}
	const maxReminders = readNumber(doc, "maxReminders", `${where}.maxReminders`, 0, errors);
	if (maxReminders !== undefined) guard.maxReminders = maxReminders;
	const scanTailChars = readNumber(doc, "scanTailChars", `${where}.scanTailChars`, 256, errors);
	if (scanTailChars !== undefined) {
		if (scanTailChars > REGEX_PROBE_LIMIT) {
			errors.push(`${where}.scanTailChars is capped at ${REGEX_PROBE_LIMIT} (a longer tail would hide its end from an re: rule), using that`);
			guard.scanTailChars = REGEX_PROBE_LIMIT;
		} else {
			guard.scanTailChars = scanTailChars;
		}
	}
	const matchToolNames = readBoolean(doc, "matchToolNames", `${where}.matchToolNames`, errors);
	if (matchToolNames !== undefined) guard.matchToolNames = matchToolNames;
	const checkEmptyThinking = readBoolean(doc, "checkEmptyThinking", `${where}.checkEmptyThinking`, errors);
	if (checkEmptyThinking !== undefined) guard.checkEmptyThinking = checkEmptyThinking;
	const ids = (key: "disableRules"): string[] | undefined => {
		const value = doc[key];
		if (value === undefined) return undefined;
		if (!Array.isArray(value)) {
			errors.push(`${where}.${key} must be an array of rule ids, ignored`);
			return undefined;
		}
		const out: string[] = [];
		for (const id of value) {
			if (typeof id !== "string" || !id.trim()) {
				errors.push(`${where}.${key} entries must be non-empty strings, one ignored`);
				continue;
			}
			if (!GUARD_BUILTIN_RULE_IDS.includes(id.trim())) {
				errors.push(`${where}.${key} names "${id}", which is not a built-in guard rule (built-ins: ${GUARD_BUILTIN_RULE_IDS.join(", ")})`);
				continue;
			}
			out.push(id.trim());
		}
		return out;
	};
	const disabled = ids("disableRules");
	if (disabled) guard.disableRules = disabled;

	if (doc.rules !== undefined) {
		if (!Array.isArray(doc.rules)) errors.push(`${where}.rules must be an array, ignored`);
		else {
			const rules: GuardRuleConfig[] = [];
			doc.rules.forEach((item, i) => {
				const at = `${where}.rules[${i}]`;
				if (!isRecord(item) || typeof item.pattern !== "string" || !item.pattern.trim()) {
					errors.push(`${at} must be {id, pattern, label?, advice?} with a non-empty pattern, ignored`);
					return;
				}
				for (const key of ["id", "label", "advice"] as const) {
					const value = item[key];
					if (value !== undefined && typeof value !== "string") errors.push(`${at}.${key} must be a string, ignored`);
				}
				if (checkedPattern(item.pattern, `${at}.pattern`, errors) === undefined) return;
				const id = trimmed(item.id) ?? `rule-${i + 1}`;
				if (GUARD_BUILTIN_RULE_IDS.includes(id)) errors.push(`${at}.id "${id}" is a built-in guard rule; yours is kept beside it and reported separately`);
				rules.push({
					id,
					pattern: item.pattern,
					...(trimmed(item.label) !== undefined ? { label: trimmed(item.label) } : {}),
					...(trimmed(item.advice) !== undefined ? { advice: trimmed(item.advice) } : {}),
				});
			});
			guard.rules = rules;
		}
	}

	if (doc.allowPatterns !== undefined) {
		if (!Array.isArray(doc.allowPatterns)) errors.push(`${where}.allowPatterns must be an array, ignored`);
		else {
			const patterns: string[] = [];
			for (const pattern of doc.allowPatterns) {
				if (typeof pattern !== "string" || !pattern.trim()) {
					errors.push(`${where}.allowPatterns entries must be non-empty patterns, one ignored`);
					continue;
				}
				if (checkedPattern(pattern, `${where}.allowPatterns "${pattern}"`, errors) === undefined) continue;
				patterns.push(pattern);
			}
			guard.allowPatterns = patterns;
		}
	}
	return guard;
}

/**
 * Fold the `gate.guard` blocks the policy read, lowest precedence first, into the one config the guard runs.
 *
 * A written scalar is replaced by the later file that wrote one — the same rule as `gate.enabled`. The three
 * *lists* are concatenated, like `gate.hardDeny`: an extra detector or a veto is an addition, and a project
 * file must not be able to delete a rule the global file added.
 */
export function mergeGuardConfigs(files: readonly (Partial<GuardConfig> | undefined)[]): GuardConfig {
	const merged: GuardConfig = { ...DEFAULT_GUARD_CONFIG, disableRules: [], rules: [], allowPatterns: [] };
	for (const guard of files) {
		if (!guard) continue;
		for (const key of ["enabled", "action", "maxReminders", "scanTailChars", "matchToolNames", "checkEmptyThinking"] as const) {
			const value = guard[key];
			if (value !== undefined) Object.assign(merged, { [key]: value });
		}
		merged.disableRules.push(...(guard.disableRules ?? []));
		merged.rules.push(...(guard.rules ?? []));
		merged.allowPatterns.push(...(guard.allowPatterns ?? []));
	}
	return merged;
}
