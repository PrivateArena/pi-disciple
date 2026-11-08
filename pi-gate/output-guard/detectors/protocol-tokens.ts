/**
 * The protocol-token detectors: a raw tool-call token in either of its spellings, and a chat-template
 * control token leaked as text.
 */

import { type Rule } from "../guard-rule.ts";

/**
 * Pipe-delimited and bracketed protocol tokens: nothing in prose looks like `<|tool_call|>`.
 *
 * The angle-bracket spellings (`<tool_call>`) are deliberately **not** here — that is a tag, and it is judged
 * by the tag rules, which let one balanced tag named in a sentence alone.
 */
const SPECIAL_TOKEN_RE =
	/<\|\s*[a-z0-9_:.-]*(?:tool|call|function|argument|param)[a-z0-9_:.-]*\s*\|>|\[\s*(?:tool_call|tool-call|toolcall|tool_use|function_call|function_calls)\s*\]/i;

export const ruleSpecialToken: Rule = {
	id: "special-token",
	label: "a raw special token of the model's tool-call protocol appeared as text",
	test: (scan) => SPECIAL_TOKEN_RE.exec(scan.prose)?.[0],
};

const CHAT_TEMPLATE_RE = /<\|\s*(?:im_start|im_end|endoftext)\s*\|>/i;

export const ruleChatTemplate: Rule = {
	id: "chat-template-token",
	label: "a chat-template token appeared as text, so the model wrote the turn instead of answering it",
	test: (scan) => CHAT_TEMPLATE_RE.exec(scan.prose)?.[0],
};
