/**
 * The extension-ladder half of the `subagent` config vocabulary: the shape of one rung of the "more rope?"
 * dialog, the ceilings a rung may not cross, and the rungs a human asks to be dropped.
 *
 * Shape rules only — the ladder itself, the shipped rungs and the rule that a written list replaces them live in
 * `../ceiling.ts`, the one place that knows what a ceiling offer is. Error-for-error mirror of
 * `pi-gate/config-contract/subagent-section.ts`, which `__tests__/config-parity.test.ts` keeps honest.
 *
 * A leaf module: it imports the ceilings from `role-names.ts` and the shape probe from `tolerant-parse.ts`.
 */

import type { ExtendOption } from "../../pi-gate/schema.ts";
import { isRecordish } from "./tolerant-parse.ts";
import { ROLE_TIMEOUT_CEILING_MINUTES } from "./role-names.ts";

/** Mirror of `pi-gate/config-contract/subagent-section.ts::MAX_EXTEND_OPTIONS`. */
export const MAX_EXTEND_OPTIONS = 8;

/**
 * Mirror of `pi-gate/config-contract/subagent-section.ts::EXTEND_TURNS_CEILING`: the turn count a written rung may
 * name. Wider than a role's own ceiling (`role-names.ts::ROLE_TURNS_CEILING`) on purpose — a role budget is
 * written once by whoever
 * edits the file, but the largest rung a watching human clicks is theirs to size, and the point of writing a big
 * one is a delegation bigger than any role guessed. Minutes stay inside what a role may be configured to spend, so
 * no rung can be both huge and endless.
 */
export const EXTEND_TURNS_CEILING = 1000;

/**
 * Mirror of `pi-gate/config-contract/subagent-section.ts::parseExtendRung`: both figures written, turns inside
 * {@link EXTEND_TURNS_CEILING} and minutes inside the ceiling a role may be configured to spend.
 */
function readRung(value: unknown, label: string, errors: string[]): ExtendOption | undefined {
	if (!isRecordish(value)) {
		errors.push(`${label} must be { turns, minutes }, ignored`);
		return undefined;
	}
	const rung: ExtendOption = { turns: 0, minutes: 0 };
	for (const [key, ceiling] of [
		["turns", EXTEND_TURNS_CEILING],
		["minutes", ROLE_TIMEOUT_CEILING_MINUTES],
	] as const) {
		const numberValue = value[key];
		if (typeof numberValue !== "number" || !Number.isFinite(numberValue) || numberValue <= 0 || numberValue > ceiling) {
			errors.push(`${label}.${key} must be a number in 1..${ceiling}, ignored`);
			return undefined;
		}
		rung[key] = Math.floor(numberValue);
	}
	return rung;
}

/** Mirror of `pi-gate/schema.ts::parseExtendOptions`, error-for-error. */
export function readExtendOptions(raw: unknown, file: string, errors: string[]): ExtendOption[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!Array.isArray(raw) || !raw.length) {
		errors.push(`${file}: subagent.extendOptions must be a non-empty array of { turns, minutes }, ignored`);
		return undefined;
	}
	const out: ExtendOption[] = [];
	raw.forEach((value, index) => {
		const rung = readRung(value, `${file}: subagent.extendOptions[${index}]`, errors);
		if (rung) out.push(rung);
	});
	return out.length ? out : undefined;
}

/** Mirror of `pi-gate/schema.ts::parseDisableExtendTurns`, error-for-error. */
export function readDisableExtendTurns(raw: unknown, file: string, errors: string[]): number[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!Array.isArray(raw) || !raw.length) {
		errors.push(`${file}: subagent.disableExtendTurns must be a non-empty array of turn counts, ignored`);
		return undefined;
	}
	const out: number[] = [];
	raw.forEach((value, index) => {
		const label = `${file}: subagent.disableExtendTurns[${index}]`;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > EXTEND_TURNS_CEILING) {
			errors.push(`${label} must be a number in 1..${EXTEND_TURNS_CEILING}, ignored`);
			return;
		}
		out.push(Math.floor(value));
	});
	return out.length ? out : undefined;
}
