import { type GuardConfig } from "../config-contract/guard-section.ts";

/**
 * One pass over a message: the code stripped, the tags scanned, the tool names normalised — everything a
 * rule may look at, computed once and shared by all of them.
 */

import { type Tag, scanTags } from "./tag-shapes.ts";

/** Everything a rule may look at, computed once per message. */
export interface Scan {
	/** The message text, cut to `gate.guard.scanTailChars` from the end. */
	tail: string;
	/** `tail` with fenced blocks and inline code spans removed: documentation is not a leaked call. */
	prose: string;
	/** Tags found in {@link prose}. */
	tags: Tag[];
	/** Active tool names, lowercased, for `matchToolNames`. */
	toolNames: ReadonlySet<string>;
	/** `gate.guard.matchToolNames`: recognise a tag named after one of this session's tools. */
	matchToolNames: boolean;
}

/**
 * Remove code from scanned text.
 *
 * Only a **closed** fence or span counts: a truncated emission stops *inside* a fence, and dropping the rest
 * of the buffer there would hide exactly the fragment the guard exists to catch.
 */
export function stripCode(text: string): string {
	return text
		.replace(/(`{3,})[\s\S]*?\1/g, " ")
		.replace(/(~{3,})[\s\S]*?\1/g, " ")
		.replace(/(`+)[^`\n]+?\1/g, " ");
}

export function buildScan(text: string, toolNames: ReadonlySet<string>, config: GuardConfig): Scan {
	const tail = text.length > config.scanTailChars ? text.slice(-config.scanTailChars) : text;
	const prose = stripCode(tail);
	return { tail, prose, tags: scanTags(prose), toolNames, matchToolNames: config.matchToolNames };
}
