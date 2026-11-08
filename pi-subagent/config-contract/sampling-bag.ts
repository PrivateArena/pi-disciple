/**
 * The sampling half of the `subagent.roles` vocabulary: pi's thinking-level words, the request-body key rules,
 * and the two readers that turn one role entry's sampling keys into `RoleConfig` fields — shape and key names
 * only, never a value range. Split out of `config-file.ts`, which keeps re-exporting `THINKING_LEVEL_WORDS`
 * as its facade.
 */

import type { RoleConfig } from "../../pi-gate/schema.ts";
import { isRecordish } from "./tolerant-parse.ts";

/** Mirror of `schema.ts::THINKING_LEVEL_WORDS` — pi's thinking levels, not the provider values they map to. */
export const THINKING_LEVEL_WORDS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Mirror of `schema.ts::SAMPLING_KEY_PATTERN`. */
const SAMPLING_KEY_PATTERN = /^[A-Za-z0-9_.\-]{1,64}$/;
/** Mirror of `schema.ts::FORBIDDEN_SAMPLING_KEYS`. */
const FORBIDDEN_SAMPLING_KEYS = ["__proto__", "constructor", "prototype"];

function isThinkingLevelWord(value: unknown): value is RoleConfig["thinkingLevel"] & string {
	return typeof value === "string" && THINKING_LEVEL_WORDS.includes(value.trim().toLowerCase());
}

/** Mirror of `schema.ts::parseRoleSampling`, error-for-error. */
export function readRoleSampling(
	value: Record<string, unknown>,
	id: string,
	file: string,
	errors: string[],
): Pick<RoleConfig, "sampling" | "samplingByThinkingLevel" | "thinkingLevel"> {
	const out: Pick<RoleConfig, "sampling" | "samplingByThinkingLevel" | "thinkingLevel"> = {};
	const path = `subagent.roles.${id}`;
	if (value.thinkingLevel !== undefined) {
		const word = typeof value.thinkingLevel === "string" ? value.thinkingLevel.trim().toLowerCase() : undefined;
		if (word && isThinkingLevelWord(word)) out.thinkingLevel = word;
		else errors.push(`${file}: ${path}.thinkingLevel must be one of ${THINKING_LEVEL_WORDS.join(", ")}, ignored`);
	}
	const sampling = readSamplingBlock(value.sampling, `${file}: ${path}.sampling`, errors);
	if (sampling) out.sampling = sampling;
	if (value.samplingByThinkingLevel !== undefined) {
		if (!isRecordish(value.samplingByThinkingLevel)) {
			errors.push(`${file}: ${path}.samplingByThinkingLevel must be an object keyed by thinking level, ignored`);
		} else {
			const byLevel: NonNullable<RoleConfig["samplingByThinkingLevel"]> = {};
			for (const [rawWord, block] of Object.entries(value.samplingByThinkingLevel)) {
				const word = rawWord.trim().toLowerCase();
				if (!isThinkingLevelWord(word)) {
					errors.push(`${file}: ${path}.samplingByThinkingLevel key "${rawWord}" is not a thinking level (${THINKING_LEVEL_WORDS.join(", ")}), ignored`);
					continue;
				}
				const levelBlock = readSamplingBlock(block, `${file}: ${path}.samplingByThinkingLevel.${word}`, errors);
				if (!levelBlock) continue;
				byLevel[word] = { ...byLevel[word], ...levelBlock };
			}
			if (Object.keys(byLevel).length) out.samplingByThinkingLevel = byLevel;
		}
	}
	return out;
}

/** Mirror of `schema.ts::parseSamplingBlock`, error-for-error. */
function readSamplingBlock(value: unknown, where: string, errors: string[]): RoleConfig["sampling"] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecordish(value)) {
		errors.push(`${where} must be an object of request-body params, ignored`);
		return undefined;
	}
	const out: NonNullable<RoleConfig["sampling"]> = {};
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
		out[key] = item as NonNullable<RoleConfig["sampling"]>[string];
	}
	return Object.keys(out).length ? out : undefined;
}
