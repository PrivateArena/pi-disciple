/**
 * The `subagent.roles` table half of the config vocabulary: the shape rules one entry may trip and the error
 * each one produces. Shape only — the built-in merge and the forbidden-tool strip live in `../roles.ts`, the
 * one place that knows what a role is. Split out of `config-file.ts`, which still calls it from the reader.
 */

import type { RoleConfig, RoleConfigMap } from "../../pi-gate/schema.ts";
import { isRecordish } from "./tolerant-parse.ts";
import { ROLE_ID_PATTERN, ROLE_TIMEOUT_CEILING_MINUTES, ROLE_TURNS_CEILING, isDocKey, isRoleId, normaliseRoleId } from "./role-names.ts";
import { readRoleSampling } from "./sampling-bag.ts";

/** Mirror of `pi-gate/schema.ts::parseRolesConfig`, error-for-error. */
export function readRoles(raw: unknown, file: string, errors: string[]): RoleConfigMap | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!isRecordish(raw)) {
		errors.push(`${file}: subagent.roles must be an object of role names, ignored`);
		return undefined;
	}
	const out: RoleConfigMap = {};
	const folded = new Map<string, string>();
	for (const [key, value] of Object.entries(raw)) {
		if (isDocKey(key)) continue; // an unread note must not become a config error, so it is skipped, not refused
		if (!isRoleId(key)) {
			errors.push(`${file}: subagent.roles key "${key}" must match ${ROLE_ID_PATTERN}, ignored`);
			continue;
		}
		const id = normaliseRoleId(key);
		const fold = id.replace(/[\s_-]+/g, "");
		const clash = folded.get(fold);
		if (clash) {
			errors.push(`${file}: subagent.roles "${id}" collides with "${clash}" (role names ignore case, spaces, - and _), ignored`);
			continue;
		}
		folded.set(fold, id);
		if (!isRecordish(value)) {
			errors.push(`${file}: subagent.roles.${id} must be an object, ignored`);
			continue;
		}
		const entry: RoleConfig = {};
		for (const textKey of ["description", "prompt"] as const) {
			const text = value[textKey];
			if (text === undefined) continue;
			if (typeof text !== "string" || !text.trim()) errors.push(`${file}: subagent.roles.${id}.${textKey} must be a non-empty string, ignored`);
			else entry[textKey] = text.trim();
		}
		if (value.tools !== undefined) {
			if (!Array.isArray(value.tools) || !value.tools.length || value.tools.some((name) => typeof name !== "string" || !name.trim())) {
				errors.push(`${file}: subagent.roles.${id}.tools must be a non-empty array of tool names, ignored`);
			} else entry.tools = value.tools.map((name) => (name as string).trim());
		}
		for (const [numberKey, ceiling] of [
			["maxTurns", ROLE_TURNS_CEILING],
			["timeoutMinutes", ROLE_TIMEOUT_CEILING_MINUTES],
		] as const) {
			const numberValue = value[numberKey];
			if (numberValue === undefined) continue;
			if (typeof numberValue !== "number" || !Number.isFinite(numberValue) || numberValue <= 0 || numberValue > ceiling) {
				errors.push(`${file}: subagent.roles.${id}.${numberKey} must be a number in 1..${ceiling}, ignored`);
				continue;
			}
			entry[numberKey] = Math.floor(numberValue);
		}
		const sampling = readRoleSampling(value, id, file, errors);
		if (sampling.sampling) entry.sampling = sampling.sampling;
		if (sampling.samplingByThinkingLevel) entry.samplingByThinkingLevel = sampling.samplingByThinkingLevel;
		if (sampling.thinkingLevel) entry.thinkingLevel = sampling.thinkingLevel;
		out[id] = entry;
	}
	return Object.keys(out).length ? out : undefined;
}
