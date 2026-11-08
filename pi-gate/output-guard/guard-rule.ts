/**
 * The two shapes every detector speaks: a `Rule` (an id, a label, a test over the scan) and the `GuardHit`
 * it produces.
 */

import { type Scan } from "./message-scan.ts";

/** A rule returns the text that proves the shape, or `undefined`. */
export interface Rule {
	id: string;
	label: string;
	test: (scan: Scan) => string | undefined;
}

/** What the guard found in one message. */
export interface GuardHit {
	/** Every rule id that fired, most specific first. */
	rules: string[];
	label: string;
	advice?: string;
	evidence: string;
}
