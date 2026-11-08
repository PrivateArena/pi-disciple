/**
 * The `subagent.roles.<name>.sampling` vocabulary and its parser: a free-form request-body bag,
 * shape-checked and prototype-key-filtered (plan step 2, split out of `schema.ts`).
 */

import { isRecord } from "./action-vocabulary.ts";
import { THINKING_LEVEL_WORDS, isThinkingLevelWord, type RoleConfig, type ThinkingLevelWord } from "./role-vocabulary.ts";

/**
 * One value of a sampling block, and the block itself.
 *
 * The shape is deliberately "anything JSON can hold", not a list of known knobs: pi's own
 * `SamplingParams` is a free-form bag that it merges into the request body verbatim, because the field
 * names belong to the inference server (`top_k`, `min_p`, `repetition_penalty`, `chat_template_kwargs`,
 * `do_sample`, ...) and not to pi. Restricting the keys here would make a new server feature a pi-subagent
 * release instead of a config edit.
 */
export type SamplingValue = number | boolean | string | null | SamplingValue[] | { [key: string]: SamplingValue };
export type SamplingConfig = Record<string, SamplingValue>;

/** A request-body field name: short, no spaces. Nested objects and arrays are passed through unchecked. */
const SAMPLING_KEY_PATTERN = /^[A-Za-z0-9_.\-]{1,64}$/;

/**
 * Keys an object literal would not put on the bag but on its prototype. They are refused rather than
 * silently swallowed, which is what assigning `__proto__` on a plain object does.
 */
const FORBIDDEN_SAMPLING_KEYS = ["__proto__", "constructor", "prototype"];

/**
 * Read the sampling fields of one `subagent.roles` entry: `thinkingLevel`, `sampling`, and
 * `samplingByThinkingLevel`. Never throws, and a bad key costs only itself.
 *
 * Values are not range-checked. pi forwards them as-is to a server whose contract this project does not own,
 * and an out-of-range value is a rejected request the child reports, which is a louder and more accurate
 * failure than a guess about what the endpoint accepts.
 */
export function parseRoleSampling(
	value: Record<string, unknown>,
	id: string,
	where: string,
	errors: string[],
): Pick<RoleConfig, "sampling" | "samplingByThinkingLevel" | "thinkingLevel"> {
	const out: Pick<RoleConfig, "sampling" | "samplingByThinkingLevel" | "thinkingLevel"> = {};
	const path = `subagent.roles.${id}`;
	if (value.thinkingLevel !== undefined) {
		const word = typeof value.thinkingLevel === "string" ? value.thinkingLevel.trim().toLowerCase() : undefined;
		if (word && isThinkingLevelWord(word)) out.thinkingLevel = word as ThinkingLevelWord;
		else errors.push(`${where}: ${path}.thinkingLevel must be one of ${THINKING_LEVEL_WORDS.join(", ")}, ignored`);
	}
	const sampling = parseSamplingBlock(value.sampling, `${where}: ${path}.sampling`, errors);
	if (sampling) out.sampling = sampling;
	if (value.samplingByThinkingLevel !== undefined) {
		if (!isRecord(value.samplingByThinkingLevel)) {
			errors.push(`${where}: ${path}.samplingByThinkingLevel must be an object keyed by thinking level, ignored`);
		} else {
			const byLevel: Partial<Record<ThinkingLevelWord, SamplingConfig>> = {};
			for (const [rawWord, block] of Object.entries(value.samplingByThinkingLevel)) {
				const word = rawWord.trim().toLowerCase();
				if (!isThinkingLevelWord(word)) {
					errors.push(`${where}: ${path}.samplingByThinkingLevel key "${rawWord}" is not a thinking level (${THINKING_LEVEL_WORDS.join(", ")}), ignored`);
					continue;
				}
				const levelBlock = parseSamplingBlock(block, `${where}: ${path}.samplingByThinkingLevel.${word}`, errors);
				if (!levelBlock) continue;
				byLevel[word as ThinkingLevelWord] = { ...byLevel[word as ThinkingLevelWord], ...levelBlock };
			}
			if (Object.keys(byLevel).length) out.samplingByThinkingLevel = byLevel;
		}
	}
	return out;
}

/**
 * One sampling block, or `undefined` when it says nothing usable. Only shapes that cannot survive the trip
 * to the server are refused: a non-object block, a key that is not a field name, a non-finite number.
 */
export function parseSamplingBlock(value: unknown, where: string, errors: string[]): SamplingConfig | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) {
		errors.push(`${where} must be an object of request-body params, ignored`);
		return undefined;
	}
	const out: SamplingConfig = {};
	for (const [rawKey, item] of Object.entries(value)) {
		const key = rawKey.trim();
		if (!SAMPLING_KEY_PATTERN.test(key) || FORBIDDEN_SAMPLING_KEYS.includes(key)) {
			errors.push(`${where} key "${rawKey}" is not a request-body field name, ignored`);
			continue;
		}
		if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
			errors.push(`${where}.${key} has no JSON value, ignored`);
			continue;
		}
		if (typeof item === "number" && !Number.isFinite(item)) {
			errors.push(`${where}.${key} must be a finite number, ignored`);
			continue;
		}
		out[key] = item as SamplingValue;
	}
	return Object.keys(out).length ? out : undefined;
}
