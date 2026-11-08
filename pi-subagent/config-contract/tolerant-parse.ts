/**
 * The shared probes behind every tolerant key lookup in the `subagent` config contract.
 *
 * The reader spells the same probe in two ways and used to spell the boolean one out three times inline:
 * key absent, right type, else one error line and the previous value stands. Only the label and the bound ever
 * varied, so the label is passed fully rendered rather than built here — the shipped error text is not uniform
 * across the two readers, and `__tests__/config-parity.test.ts` asserts on it word for word.
 *
 * A leaf module — it imports nothing, so every other module of this package can sit on top of it.
 */

/** One boolean key: `undefined` when the file did not write it, an error when it wrote the wrong type. */
export function readBoolean(doc: Record<string, unknown>, key: string, label: string, errors: string[]): boolean | undefined {
	const value = doc[key];
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	errors.push(`${label} must be a boolean, ignored`);
	return undefined;
}

/** The shape every config map must have: a plain object, so neither an array nor `null`. */
export function isRecordish(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
