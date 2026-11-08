/**
 * The ordered unique list the fact pipeline needs.
 *
 * A `Set` would dedupe but lose the order, and the order is load-bearing: hosts are listed "in the order
 * the call spelled them" in the dialog and in the log, and grant patterns are offered in segment order so
 * the last match still resolves towards the human. Every collector in the gate therefore keeps an array and
 * refuses the duplicate instead.
 */

/** Append `value` unless the list already holds it, keeping first-seen order. Returns whether it was added. */
export function pushUnique<T>(list: T[], value: T): boolean {
	if (list.includes(value)) return false;
	list.push(value);
	return true;
}
