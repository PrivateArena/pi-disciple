/**
 * The shared probes behind every tolerant key lookup in the config contract.
 *
 * Each parser used to spell the same three-step probe inline — key absent, right type, else one error line —
 * and only the label and the bound varied. The label is passed fully rendered rather than built here, because
 * the shipped error text is not uniform (`gate.enabled` and `${where}.enabled` sit at different depths) and
 * the tests assert on it.
 */

import { regexPatternError } from "../pattern/regex-dialect.ts";

/** One boolean key: `undefined` when the file did not write it, an error when it wrote the wrong type. */
export function readBoolean(doc: Record<string, unknown>, key: string, label: string, errors: string[]): boolean | undefined {
	const value = doc[key];
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	errors.push(`${label} must be a boolean, ignored`);
	return undefined;
}

/** One finite number key at or above `min`, floored — `undefined` when the file did not write it. */
export function readNumber(doc: Record<string, unknown>, key: string, label: string, min: number, errors: string[]): number | undefined {
	const value = doc[key];
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isFinite(value) && value >= min) return Math.floor(value);
	errors.push(`${label} must be a number >= ${min}, ignored`);
	return undefined;
}

/**
 * A pattern the matcher can actually compile. The error names the pattern and the reason, and the caller
 * decides whether the entry is skipped or the whole list abandoned.
 */
export function checkedPattern(pattern: string, label: string, errors: string[]): string | undefined {
	const bad = regexPatternError(pattern);
	if (bad) {
		errors.push(`${label} ${bad}, ignored`);
		return undefined;
	}
	return pattern;
}

/** A written-but-blank string is not written at all: the trimmed value, or `undefined`. */
export function trimmed(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
