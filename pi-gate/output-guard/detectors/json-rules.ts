/**
 * The JSON detectors: a call-shaped object at the end of the message, and the same object cut off mid-body.
 */

import { JSON_CANDIDATE_CHARS, JSON_CANDIDATE_LIMIT } from "../guard-limits.ts";
import { type Rule } from "../guard-rule.ts";

/** A JSON call that parses: `{name, arguments}`, or OpenAI's `{function:{name, arguments}}` envelope. */
const CALL_NAME_KEYS = ["name", "tool", "tool_name", "toolname", "function", "function_name", "action"];
const CALL_ARG_KEYS = ["arguments", "args", "params", "parameters", "input"];
const CALL_ENVELOPE_KEYS = ["function", "tool_call", "toolcall", "data", "call"];

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function lookupKey(record: Record<string, unknown>, candidates: readonly string[]): string | undefined {
	for (const key of Object.keys(record)) {
		if (candidates.includes(key.toLowerCase())) return key;
	}
	return undefined;
}

function isCallShapedJson(value: unknown, depth = 0): boolean {
	const record = jsonRecord(value);
	if (!record || depth > 2) return false;
	const nameKey = lookupKey(record, CALL_NAME_KEYS);
	const argKey = lookupKey(record, CALL_ARG_KEYS);
	if (nameKey && argKey) return true;
	for (const key of Object.keys(record)) {
		if (!CALL_ENVELOPE_KEYS.includes(key.toLowerCase())) continue;
		if (isCallShapedJson(record[key], depth + 1)) return true;
	}
	return false;
}

/** Track brace depth and string state, so "truncated" can be told from "malformed". */
function jsonBalance(text: string): { open: number; unterminatedString: boolean } {
	let open = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{" || ch === "[") open++;
		else if (ch === "}" || ch === "]") open--;
	}
	return { open, unterminatedString: inString };
}

/** Index just past the bracket that closes `text`, or `undefined` when nothing closes it. */
function matchBrace(text: string): number | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) return i + 1;
			if (depth < 0) return undefined;
		}
	}
	return undefined;
}

/** The `{…}` spans of `text`, last first — a leaked call sits at the end of the message. */
function jsonCandidates(text: string): Array<{ source: string; end: number }> {
	const out: Array<{ source: string; end: number }> = [];
	let start = text.lastIndexOf("{");
	while (start >= 0 && out.length < JSON_CANDIDATE_LIMIT) {
		const slice = text.slice(start, start + JSON_CANDIDATE_CHARS);
		const closed = matchBrace(slice);
		if (closed !== undefined) out.push({ source: slice.slice(0, closed), end: start + closed });
		start = start > 0 ? text.lastIndexOf("{", start - 1) : -1;
	}
	return out;
}

export const ruleJsonCall: Rule = {
	id: "json-call",
	label: "a tool call was written as a JSON object in the message text",
	test: (scan) => {
		for (const candidate of jsonCandidates(scan.prose)) {
			// Nothing but punctuation may follow it: a call the model *meant* to end the message with.
			if (!/^[.,;:!?)\]}*`\s]*$/.test(scan.prose.slice(candidate.end))) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(candidate.source);
			} catch {
				continue;
			}
			if (!isCallShapedJson(parsed)) continue;
			return candidate.source;
		}
		return undefined;
	},
};

const TRUNCATED_ARG_KEYS = /"(?:arguments|args|params|parameters|input|command|path|pattern|content|prompt|task|url)"\s*:/;
const TRUNCATED_NAME_KEY = /"(?:name|tool|tool_name|function|action)"\s*:/;

/**
 * A call-shaped JSON object whose tail never arrived.
 *
 * "Truncated" is a structural claim, not a vibe: braces or a string are still open at the end of the message
 * (so nothing could ever have parsed) while the keys of a call are already there. A closed object is the job of
 * {@link ruleJsonCall}, and a closed-but-not-call-shaped one is a quoted config file.
 */
function isTruncatedCall(text: string): boolean {
	if (text.length < 12 || text.length > JSON_CANDIDATE_CHARS) return false;
	const balance = jsonBalance(text);
	if (balance.open <= 0 && !balance.unterminatedString) return false;
	if (balance.open > 6) return false;
	return TRUNCATED_ARG_KEYS.test(text) && TRUNCATED_NAME_KEY.test(text);
}

/**
 * The same shape with its tail cut off: braces or a string never close, so nothing can parse.
 *
 * Anchored at the message end *and* required to name call keys, because "an unbalanced JSON object at the
 * end of a message" is also a report that quoted a config file and stopped mid-example.
 */
export const ruleJsonTruncated: Rule = {
	id: "json-call-truncated",
	label: "a truncated tool call was left in the message text",
	test: (scan) => {
		const window = scan.prose.slice(-1500);
		let start = window.lastIndexOf("{");
		while (start >= 0) {
			const rest = window.slice(start);
			if (isTruncatedCall(rest)) return rest;
			start = start > 0 ? window.lastIndexOf("{", start - 1) : -1;
		}
		return undefined;
	},
};
