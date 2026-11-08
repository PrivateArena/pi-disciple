/**
 * The tag detectors: a call envelope written as text, markup cut off mid-tag, and a tag named after one of
 * this session's tools.
 */

import { type Tag, ARG_TAG_NAMES, CALL_TAG_NAMES, HTML_TAG_NAMES, TAG_RE, hasArgumentShape, normaliseTagName } from "../tag-shapes.ts";
import { type Scan } from "../message-scan.ts";
import { type Rule } from "../guard-rule.ts";

function callTags(scan: Scan): Tag[] {
	return scan.tags.filter((tag) => {
		const name = normaliseTagName(tag.name);
		return CALL_TAG_NAMES.has(name) || (ARG_TAG_NAMES.has(name) && hasArgumentShape(tag));
	});
}

/**
 * A call, as opposed to a sentence that mentions one.
 *
 * The signals, in decreasing strength: an argument on the tag (`<invoke name="read">`), an *envelope* (more
 * than one tag of the family, which is what a call actually is), a closing tag nobody opened, a tag that was
 * never terminated, a message that *ends* on an open tag, and a message that is nothing but markup. One
 * balanced, self-contained `<tool_call>` inside a sentence is none of these, and flagging it would cost the
 * guard the credibility it needs to be left switched on.
 */
export const ruleCallTag: Rule = {
	id: "call-tag",
	label: "a tool call was written as markup in the message text",
	test: (scan) => {
		const tags = callTags(scan);
		if (tags.length === 0) return undefined;
		const opens = tags.filter((tag) => !tag.closing);
		const closes = tags.filter((tag) => tag.closing);
		const sameName = (a: Tag, b: Tag) => normaliseTagName(a.name) === normaliseTagName(b.name);
		const strayClose = closes.some((close) => !opens.some((open) => sameName(open, close)));
		const truncated = tags.some((tag) => !tag.terminated);
		const envelope = tags.length > 1 || tags.some(hasArgumentShape);
		const last = tags[tags.length - 1]!;
		const after = scan.prose.slice(scan.prose.lastIndexOf(last.raw) + last.raw.length);
		const endsOnOpenTag = !last.closing && /^[\s.,;:!?)\]]*$/.test(after);
		const onlyMarkup = scan.prose.replace(TAG_RE, " ").trim().length === 0;
		if (!(strayClose || truncated || envelope || endsOnOpenTag || onlyMarkup)) return undefined;
		return tags.slice(0, 3).map((tag) => tag.raw).join(" ");
	},
};

function isCallNamePrefix(name: string): boolean {
	if (name.length < 3) return false;
	return [...CALL_TAG_NAMES, ...ARG_TAG_NAMES].some((known) => known.startsWith(name));
}

function isToolNamePrefix(name: string, scan: Scan): boolean {
	if (name.length < 3) return false;
	for (const tool of scan.toolNames) if (tool.startsWith(name)) return true;
	return false;
}

/** The call died mid-tag: an unterminated tag, or a text that stops at the `<` that opens one. */
export const ruleCallFragment: Rule = {
	id: "call-fragment",
	label: "a tool call was cut off inside its own markup",
	test: (scan) => {
		for (const tag of scan.tags) {
			if (tag.terminated) continue;
			const name = normaliseTagName(tag.name);
			if (isCallNamePrefix(name) || (scan.matchToolNames && isToolNamePrefix(name, scan))) return tag.raw;
		}
		if (!/\s<\s*$/.test(scan.prose)) return undefined;
		const window = scan.prose.slice(-300);
		if (callTags(scan).length > 0 || /"(?:name|arguments|args|command|path|pattern|content|prompt|task)"\s*:/i.test(window)) {
			return window.slice(-40);
		}
		return undefined;
	},
};

export const ruleToolNameTag: Rule = {
	id: "tool-name-tag",
	label: "a tool call was written as an XML tag named after the tool",
	test: (scan) => {
		if (!scan.matchToolNames) return undefined;
		for (const tag of scan.tags) {
			if (tag.closing || !tag.terminated) continue;
			const name = normaliseTagName(tag.name);
			if (HTML_TAG_NAMES.has(name) || CALL_TAG_NAMES.has(name)) continue;
			if (!scan.toolNames.has(name)) continue;
			const paired = scan.tags.some((other) => other.closing && normaliseTagName(other.name) === name);
			if (hasArgumentShape(tag) || paired) return tag.raw;
		}
		return undefined;
	},
};
