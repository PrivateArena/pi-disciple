/**
 * call-text.ts — is this *text* a tool call the model wrote out by hand?
 *
 * A model that means to call a tool and says it on the text channel produces an assistant message with no
 * `toolCall` part. To the harness that is an ordinary answer: the loop ends, and the text — "Now I'll write
 * the code. Starting with deps and lib.rs:" plus a `[Tool call: bash]` that ran nothing — becomes whatever
 * reads the message next. This module is the one question that distinguishes it: did the model write the
 * *markup* of a call instead of making the call?
 *
 * Two callers, both in the child:
 * - `child.ts` asks of a finished assistant message, to remind the child in-place instead of letting its run
 *   end on a call that never executed (the "error as a prompt" recovery `pi-gate`'s output guard does for the
 *   parent — a child has no extensions, so nothing else would catch it);
 * - `budget/ceiling-clock.ts` asks through `child.ts` of a *streaming* message, so a written-out call does not
 *   buy the deferral that is reserved for a real report (FM-2's grace is for the artifact, not for the markup).
 *
 * The dialect list mirrors `pi-gate/output-guard/detectors/` by hand rather than importing it: `pi-subagent`
 * couples to `pi-gate` through types only (see PROJECT_OVERVIEW §Key Architectural Patterns 2), and deleting the
 * gate must leave the subagent working. It mirrors the same shapes with different *windows* — the tag and JSON
 * dialects are judged on the tail alone, where the gate runs a full rule registry — so neither is a subset of the
 * other, and `__tests__/call-text.test.ts` pins where the two agree and where they deliberately do not.
 */

/**
 * Tag dialects: `<tool_call>`, `<invoke name=>`, `<parameter name=>`, `<function_calls>`, and their closers.
 * A closing tag alone counts, because it only ever arrives with an opening one.
 *
 * Judged on the tail of the message only (see `CALL_TAIL_CHARS`): a report that *mentions* `<tool_call>` in a
 * sentence is a report, while an emission stops the moment it has written the call, so the markup is the last
 * thing there is. `pi-gate`'s tag rules make the same distinction by other means.
 */
const TAG_SHAPE: CallShape = {
	id: "call-tags",
	tailOnly: true,
	pattern: /<\s*\/?\s*(?:antml:)?(?:tool[_ -]?call|function[_ -]?calls?|invoke|param(?:eter)?|tool_use)\b|<\s*invoke\s+name\s*=/i,
};

/**
 * Protocol tokens, in their raw (`<\|tool_call\|>`), bracketed (`[tool_call]`) and prose (`[Tool call: bash]`)
 * spellings. The colon form is what a Qwen-family model emits when it runs out of budget mid-task, and nothing
 * in ordinary prose looks like it; `tool call` always names a call here. The payload after the colon is any
 * short run — the name alone, or the name with its arguments written out too.
 */
const TOKEN_SHAPE: CallShape = {
	id: "special-token",
	pattern: /<\|\s*[a-z0-9_:.-]*(?:tool|function)[a-z0-9_:.-]*\s*\|>|\[\s*(?:tool[_ -]?call|tool[_ -]?use|function[_ -]?calls?|call[_ -]?function)\s*(?::\s*[^\]\n]{1,80})?\s*\]/i,
};

/** A chat-template control token written as text: the model wrote the turn instead of answering it. */
const TEMPLATE_SHAPE: CallShape = {
	id: "chat-template-token",
	pattern: /<\|\s*(?:im_start|im_end|endoftext)\s*\|>/i,
};

/**
 * A call-shaped JSON of a serialized invocation: a `tool_calls`/`function_call` key, or a tool name sitting
 * beside its arguments. Deliberately narrow: `"arguments":` on its own is what a report *about* a schema says,
 * and a report is exactly the text this module must not mistake for a call. Tail-only, like the tags.
 */
const JSON_SHAPE: CallShape = {
	id: "json-call",
	tailOnly: true,
	pattern: /"(?:tool_calls|function_call|tool_call)"\s*:|"(?:tool_name|name)"\s*:\s*"[^"]{1,80}"\s*,\s*"(?:arguments|params|input|args|parameters)"/i,
};

/** The dialects, in the order their evidence is reported. */
const CALL_SHAPES: readonly CallShape[] = [TAG_SHAPE, TOKEN_SHAPE, TEMPLATE_SHAPE, JSON_SHAPE];

/** One dialect, and the words that name it in the log and the reminder. */
interface CallShape {
	id: string;
	pattern: RegExp;
	/** Judge this dialect only in the last `CALL_TAIL_CHARS` characters of the message. */
	tailOnly?: boolean;
}

/**
 * How much of the message is a possible emission: the shape of a leaked call is *the end* of the turn, and a
 * window keeps a long report from being judged on a passing remark two pages back.
 */
export const CALL_TAIL_CHARS = 400;

/** How much of the matched text is quoted back in the reminder and the log. */
export const CALL_EVIDENCE_CHARS = 160;

/**
 * Fenced blocks and inline spans are the model *showing* code, which is what a report legitimately contains.
 * Only a **closed** fence counts, exactly as in `pi-gate/output-guard/message-scan.ts::stripCode`: a truncated
 * emission stops *inside* a fence, and blanking the rest of the buffer there would hide the fragment itself.
 */
export function stripCode(text: string): string {
	return text
		.replace(/(`{3,})[\s\S]*?\1/g, " ")
		.replace(/(~{3,})[\s\S]*?\1/g, " ")
		.replace(/(`+)[^`\n]+?\1/g, " ");
}

/** The two windows a dialect may be judged on: the whole prose, and the tail of it. */
function scanWindows(text: string): { prose: string; tail: string } {
	const prose = stripCode(text);
	return { prose, tail: prose.length > CALL_TAIL_CHARS ? prose.slice(-CALL_TAIL_CHARS) : prose };
}

/** The first dialect this text writes as markup, with the snippet that said so. */
export function callTextEvidence(text: string): { id: string; evidence: string } | undefined {
	if (!text) return undefined;
	const { prose, tail } = scanWindows(text);
	for (const shape of CALL_SHAPES) {
		const haystack = shape.tailOnly ? tail : prose;
		const match = shape.pattern.exec(haystack);
		if (!match) continue;
		const start = Math.max(0, (match.index ?? 0) - 20);
		const evidence = haystack.slice(start, start + CALL_EVIDENCE_CHARS).replace(/\s+/g, " ").trim();
		return { id: shape.id, evidence: evidence || match[0] };
	}
	return undefined;
}

/** Is a tool call written out in this text? */
export function looksLikeToolCallText(text: string): boolean {
	return callTextEvidence(text) !== undefined;
}

/**
 * Did the message *stop* on the markup? This is the question that decides whether text is a report: an emission
 * is a call written and then nothing more, while a report about a guard, a protocol or a template names the same
 * shapes in a sentence and then says the thing it came to say. Judging the end of the message keeps a report
 * whole, which matters because a wrong "markup" verdict here costs the caller a re-run, not just a reminder.
 */
export function endsWithCallMarkup(text: string): boolean {
	// Trailing punctuation a writer may add after the markup, but never a closing `]` or `>`: those are the
	// shape's own end, and stripping them would leave the dialect unrecognised.
	const prose = stripCode(text).replace(/[\s"'`*.:,;!?]+$/, "");
	if (!prose) return false;
	const window = prose.slice(-CALL_EVIDENCE_CHARS);
	for (const shape of CALL_SHAPES) {
		const matches = [...window.matchAll(shape.pattern.global ? shape.pattern : new RegExp(shape.pattern.source, shape.pattern.flags + "g"))];
		const last = matches.at(-1);
		if (last && (last.index ?? 0) + last[0].length >= window.length - CALL_END_SLACK) return true;
	}
	return false;
}

/** How far from the very end a dialect's closing bracket may sit and still count as "it stopped there". */
export const CALL_END_SLACK = 2;

/** Every dialect that fired, for the log line. */
export function callTextRuleIds(text: string): string[] {
	if (!text) return [];
	const { prose, tail } = scanWindows(text);
	return CALL_SHAPES.filter((shape) => (shape.tailOnly ? tail : prose).match(shape.pattern) !== null).map((shape) => shape.id);
}

/** The ids this module knows, so a test can pin the dialects against `pi-gate`'s detectors. */
export function callTextShapeIds(): string[] {
	return CALL_SHAPES.map((shape) => shape.id);
}
