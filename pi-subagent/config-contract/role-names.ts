/**
 * The role-name half of the `subagent` vocabulary: the id pattern a `subagent.roles` key is matched against,
 * the two normalisations that turn hand-written text into an id, the `==` documentation-key rule, and the two
 * ceilings a role budget may not cross. Split out of `config-file.ts`, which keeps re-exporting the three
 * constants as its facade. A leaf module — it imports nothing.
 */

/** Mirror of `schema.ts::ROLE_TURNS_CEILING` / `ROLE_TIMEOUT_CEILING_MINUTES`. */
export const ROLE_TURNS_CEILING = 200;
export const ROLE_TIMEOUT_CEILING_MINUTES = 120;
/** Mirror of `schema.ts::isRoleId`. */
export const ROLE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function isRoleId(value: unknown): value is string {
	return typeof value === "string" && ROLE_ID_PATTERN.test(value.trim());
}

/** Mirror of `pi-gate/schema.ts::isDocKey`: a `==` key is documentation, never config, in any map of this file. */
export function isDocKey(key: string): boolean {
	return key.startsWith("==");
}

export function normaliseRoleId(value: string): string {
	return value.trim().toLowerCase();
}
