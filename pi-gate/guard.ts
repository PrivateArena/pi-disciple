/**
 * The output guard: a tool call the model **wrote** instead of **making**.
 *
 * A local or XML-dialect model sometimes ends its message with the *markup* of a call as plain text —
 * `<tool_call>…</tool_call>`, an `<invoke name=…>` envelope, a `<parameter=path>` fragment, a JSON body, or a
 * tail cut off in the middle of one — because the sampler produced the shape of a call on the text channel
 * instead of the structured block the harness reads. Pi sees text, so no tool runs and the run ends as if the
 * agent had answered: the turn is gone, and the human is left with a confident sentence about work that never
 * happened.
 *
 * The guard turns that into a message from the harness. At `turn_end` — on the one turn where the model spoke
 * and nothing ran — it reads the tail of the assistant text, and when the shape really is a call it appends a
 * reminder entry and asks Pi to continue the run, so the model is told "that call did not execute" while it
 * still has the work in context.
 *
 * **A false positive costs the exact thing this saves** — a turn the model did not intend — so every shape
 * test is strict: fenced and inline code is never a call, one balanced tag with no payload is prose, a
 * plain-JSON call has to parse and sit at the very end of the message, only the tail is read at all,
 * `gate.guard.allowPatterns` is a human-written veto, and the whole thing is bounded by a reminder budget the
 * next real tool call refills. Rule ids are config-addressable (`gate.guard.rules`, `.disableRules`,
 * `/gatec guard`), because the dialects are endless and a false positive has to be fixable without code.
 */

import type { ExtensionContext, SessionBoundaryDraft, TurnEndEvent, TurnEndEventResult } from "@earendil-works/pi-coding-agent";
import { beginRegexRound, codeSpan, compileRegexPattern, displaySnippet, regexSource, wildcardMatch } from "./match.ts";
import { defaultGuardLogPath, guardLog, redact, type GuardLogEntry } from "./log.ts";
import type { GuardAction, GuardConfig } from "./schema.ts";
import type { Policy } from "./policy.ts";

/** The `customType` of the reminder the model is handed. */
export const GUARD_MESSAGE_TYPE = "pi-gate.malformed-tool-call";

/** Stop reasons worth reminding about: the model chose to stop, or ran out of output room. */
const REMINDABLE_STOP_REASONS: ReadonlySet<string> = new Set(["stop", "length"]);

/** How much of a thinking block counts as "the reasoning stopped on the markup of a call". */
const THINKING_TAIL_CHARS = 240;

/** Evidence budget in the reminder and the log line. */
const EVIDENCE_CHARS = 160;

/** Largest JSON candidate the plain-text call rules will parse. */
const JSON_CANDIDATE_CHARS = 2000;

/** How many `{` positions are tried from the end, so the scan stays a scan of a small window. */
const JSON_CANDIDATE_LIMIT = 12;

/** Assistant messages remembered per session, so `seen` cannot grow without bound. */
export const REMINDER_MEMORY_LIMIT = 32;

/** The rule id of the thinking-tail check, which runs only for a message with no text at all. */
export const THINKING_RULE_ID = "call-in-thinking";

// ---------------------------------------------------------------------------
// tag shapes
// ---------------------------------------------------------------------------

/** Tag names that mean "tool call" in every dialect that uses them. */
const CALL_TAG_NAMES: ReadonlySet<string> = new Set(["toolcall", "toolcalls", "tooluse", "functioncall", "functioncalls"]);

/** Tag names that mean a call only next to an argument shape (`<invoke name="x">`, `<parameter=path>`). */
const ARG_TAG_NAMES: ReadonlySet<string> = new Set([
	"function",
	"invoke",
	"parameter",
	"parameters",
	"param",
	"argument",
	"arguments",
	"tool",
]);

/** Element names prose is full of: a coding tool is never named like one of these. */
const HTML_TAG_NAMES: ReadonlySet<string> = new Set([
	"a", "abbr", "address", "area", "article", "aside", "audio", "b", "base", "bdi", "bdo", "blockquote",
	"body", "br", "button", "canvas", "caption", "cite", "code", "col", "colgroup", "data", "dd", "del",
	"details", "dfn", "dialog", "div", "dl", "dt", "em", "embed", "fieldset", "figcaption", "figure",
	"footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "i",
	"iframe", "img", "input", "ins", "kbd", "label", "legend", "li", "link", "main", "map", "mark", "menu",
	"meta", "nav", "noscript", "object", "ol", "optgroup", "option", "output", "p", "picture", "pre",
	"progress", "q", "rp", "rt", "ruby", "s", "samp", "script", "section", "select", "slot", "small",
	"source", "span", "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "template",
	"textarea", "tfoot", "th", "thead", "time", "title", "tr", "track", "u", "ul", "var", "video", "wbr",
]);

/** One `<…>`, or a `<…` that never closed — a truncated emission. */
export interface Tag {
	raw: string;
	name: string;
	body: string;
	closing: boolean;
	terminated: boolean;
}

const TAG_RE = /<[/!]?[A-Za-z][^<>]{0,400}>?/g;

/** `antml:parameter`, `Tool-Call`, `tool_call` → `parameter`, `toolcall`, `toolcall`. */
export function normaliseTagName(name: string): string {
	const bare = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
	return bare.toLowerCase().replace(/[\s_-]+/g, "");
}

export function scanTags(text: string): Tag[] {
	const out: Tag[] = [];
	for (const match of text.matchAll(TAG_RE)) {
		const raw = match[0];
		const terminated = raw.endsWith(">");
		const inner = raw.slice(1, terminated ? -1 : undefined).replace(/^\s*[/!]\s*/, "");
		const cut = inner.search(/[\s=(/]/);
		out.push({
			raw,
			name: cut < 0 ? inner : inner.slice(0, cut),
			body: cut < 0 ? "" : inner.slice(cut),
			closing: /^<\s*\//.test(raw),
			terminated,
		});
	}
	return out;
}

/** `<invoke name="x">`, `<function=x>`: the tag itself carries an argument. */
function hasArgumentShape(tag: Tag): boolean {
	return /[=(]/.test(tag.body);
}

// ---------------------------------------------------------------------------
// the scan
// ---------------------------------------------------------------------------

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

function buildScan(text: string, toolNames: ReadonlySet<string>, config: GuardConfig): Scan {
	const tail = text.length > config.scanTailChars ? text.slice(-config.scanTailChars) : text;
	const prose = stripCode(tail);
	return { tail, prose, tags: scanTags(prose), toolNames, matchToolNames: config.matchToolNames };
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

/** A rule returns the text that proves the shape, or `undefined`. */
interface Rule {
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
const ruleCallTag: Rule = {
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
const ruleCallFragment: Rule = {
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

const ruleToolNameTag: Rule = {
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

const ruleJsonCall: Rule = {
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
const ruleJsonTruncated: Rule = {
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

/**
 * Pipe-delimited and bracketed protocol tokens: nothing in prose looks like `<|tool_call|>`.
 *
 * The angle-bracket spellings (`<tool_call>`) are deliberately **not** here — that is a tag, and it is judged
 * by the tag rules, which let one balanced tag named in a sentence alone.
 */
const SPECIAL_TOKEN_RE =
	/<\|\s*[a-z0-9_:.-]*(?:tool|call|function|argument|param)[a-z0-9_:.-]*\s*\|>|\[\s*(?:tool_call|tool-call|toolcall|tool_use|function_call|function_calls)\s*\]/i;

const ruleSpecialToken: Rule = {
	id: "special-token",
	label: "a raw special token of the model's tool-call protocol appeared as text",
	test: (scan) => SPECIAL_TOKEN_RE.exec(scan.prose)?.[0],
};

const CHAT_TEMPLATE_RE = /<\|\s*(?:im_start|im_end|endoftext)\s*\|>/i;

const ruleChatTemplate: Rule = {
	id: "chat-template-token",
	label: "a chat-template token appeared as text, so the model wrote the turn instead of answering it",
	test: (scan) => CHAT_TEMPLATE_RE.exec(scan.prose)?.[0],
};

const BUILTIN_RULES: readonly Rule[] = [
	ruleCallTag,
	ruleCallFragment,
	ruleToolNameTag,
	ruleJsonCall,
	ruleJsonTruncated,
	ruleSpecialToken,
	ruleChatTemplate,
];

/** The rule ids a config may name — pinned to `GUARD_BUILTIN_RULE_IDS` by a test. */
export function builtinRuleIds(): string[] {
	return [...BUILTIN_RULES.map((rule) => rule.id), THINKING_RULE_ID];
}

/**
 * Match one configured pattern the way the rest of the gate matches patterns: `re:` unanchored through the
 * bounded regex probe, anything else as a glob. Returns evidence, or `undefined` for "no match".
 */
function matchConfiguredPattern(pattern: string, text: string): string | undefined {
	const regex = compileRegexPattern(pattern);
	if (regex) {
		if (!regexSource(regex, text)) return undefined;
		return regex.exec(text)?.[0] ?? text.slice(-EVIDENCE_CHARS);
	}
	return wildcardMatch(pattern, text) ? text.slice(-EVIDENCE_CHARS) : undefined;
}

export interface GuardInput {
	/** Concatenated text blocks of the assistant message. */
	text: string;
	/** Concatenated thinking blocks — consulted only when `text` is empty. */
	thinking: string;
	toolNames: ReadonlySet<string>;
	config: GuardConfig;
	/** Rule ids the human switched off for this session (`/gatec guard disable <id>`). */
	sessionDisabled?: ReadonlySet<string>;
}

/** Rule ids in force, for `/gatec`. */
export function activeRuleIds(config: GuardConfig, sessionDisabled: ReadonlySet<string> = new Set()): string[] {
	const disabled = new Set([...config.disableRules, ...sessionDisabled]);
	const ids = builtinRuleIds().filter((id) => !disabled.has(id));
	return [...(config.checkEmptyThinking ? ids : ids.filter((id) => id !== THINKING_RULE_ID)), ...config.rules.map((rule) => rule.id)];
}

function makeHit(rules: string[], label: string, advice: string | undefined, evidence: string): GuardHit {
	// `redact()` is command-shaped (`API_KEY=…`, `token: …`) and best effort. It cannot be a promise here: the
	// same bytes are already in the session transcript verbatim, so this is about the log file, not about a
	// secret the model has not already seen.
	return { rules, label, advice, evidence: displaySnippet(redact(evidence), EVIDENCE_CHARS) };
}

/**
 * Look at one finished assistant message and decide whether it is a call that never became one.
 *
 * `undefined` means "this message is an answer" — the honest answer almost always, and the reason the shape
 * tests are strict rather than generous.
 */
export function detectMalformedCall(input: GuardInput): GuardHit | undefined {
	const { config } = input;
	const disabled = new Set([...config.disableRules, ...(input.sessionDisabled ?? [])]);
	beginRegexRound();

	// A human's veto wins over every detector, including on text a rule would otherwise read.
	if (config.allowPatterns.some((pattern) => matchConfiguredPattern(pattern, input.text) !== undefined)) return undefined;

	if (input.text.trim() === "") {
		if (!config.checkEmptyThinking || disabled.has(THINKING_RULE_ID)) return undefined;
		const scan = buildScan(input.thinking.slice(-THINKING_TAIL_CHARS), input.toolNames, config);
		for (const rule of [ruleCallTag, ruleSpecialToken, ruleChatTemplate]) {
			const evidence = rule.test(scan);
			if (evidence !== undefined) return makeHit([THINKING_RULE_ID, rule.id], `${rule.label}, and the message had no text at all`, undefined, evidence);
		}
		return undefined;
	}

	const scan = buildScan(input.text, input.toolNames, config);
	const fired = new Map<string, { label: string; evidence: string; advice?: string }>();
	for (const rule of BUILTIN_RULES) {
		if (disabled.has(rule.id)) continue;
		const evidence = rule.test(scan);
		if (evidence !== undefined) fired.set(rule.id, { label: rule.label, evidence });
	}
	for (const rule of config.rules) {
		if (disabled.has(rule.id)) continue;
		const found = matchConfiguredPattern(rule.pattern, scan.prose);
		if (found !== undefined) fired.set(rule.id, { label: rule.label ?? `a message matching guard rule "${rule.id}"`, evidence: found, advice: rule.advice });
	}
	const first = fired.entries().next();
	if (first.done) return undefined;
	const detail = first.value[1];
	return makeHit([...fired.keys()], detail.label, detail.advice, detail.evidence);
}

// ---------------------------------------------------------------------------
// the reminder
// ---------------------------------------------------------------------------

const CUT_OFF_ADVICE =
	"The response was cut off, so the arguments never arrived. Make the call again through the tool interface with complete arguments, or split the step into smaller ones.";

const LEAK_ADVICE =
	"Tool calls go through the harness's tool interface, not through the text of a message. Make the call properly now if you meant to make it; otherwise answer without the call markup.";

/** The text the model reads: short markdown, one screen, and it names the next action. */
export function reminderText(hit: GuardHit, truncated: boolean): string {
	const advice = hit.advice ?? (truncated || hit.rules.includes("json-call-truncated") ? CUT_OFF_ADVICE : LEAK_ADVICE);
	return [`Malformed tool call: ${hit.label}, so nothing ran and the run would have stopped here.`, `What you wrote: ${codeSpan(hit.evidence)}`, advice].join(" ");
}

/** The one-line version for the human. */
export function guardNotice(hit: GuardHit, action: GuardAction): string {
	return `[gate] ${action === "remind" ? "reminded the agent:" : "noticed"} ${hit.label} (${hit.rules.join(", ")})`;
}

// ---------------------------------------------------------------------------
// the turn_end pipeline
// ---------------------------------------------------------------------------

/**
 * Session state for the guard: what was already answered and how much rope is left. Owned by the entry point
 * so `session_start` can clear it and `/gatec` can show and change it.
 */
export interface GuardBudget {
	/** Reminders sent this session, against `gate.guard.maxReminders`. */
	reminders: number;
	/** Entry ids already reminded — one nudge per assistant message. */
	seen: Set<string>;
	/** Rule ids the human switched off for this session. */
	disabled: Set<string>;
	/** Session override of `gate.guard.action`. */
	action?: GuardAction;
	/** The last hit, for `/gatec` and the footer. */
	last?: { rules: string[]; label: string };
}

export function createGuardBudget(): GuardBudget {
	return { reminders: 0, seen: new Set(), disabled: new Set() };
}

/** A real tool call means the model can call tools: the nudge budget is for the current trouble, not for the session. */
export function refillGuardBudget(budget: GuardBudget): void {
	budget.reminders = 0;
}

/** `/gatec guard reset`: the counters only — what the human switched off stays switched off. */
export function resetGuardCounters(budget: GuardBudget): void {
	budget.reminders = 0;
	budget.seen.clear();
	budget.last = undefined;
}

/** A new session: nothing carries over, including the human's session overrides of action and rules. */
export function resetGuardSession(budget: GuardBudget): void {
	resetGuardCounters(budget);
	budget.disabled.clear();
	budget.action = undefined;
}

export interface GuardTurnState {
	policy: Policy;
	/** `pi.getActiveTools()`, lowercased — the names `matchToolNames` recognises. */
	toolNames: ReadonlySet<string>;
	budget: GuardBudget;
}

export interface GuardTurnDeps {
	guardLog?: typeof guardLog;
	logPath?: () => string;
	now?: () => Date;
}

/**
 * The action for this turn. A session override wins over the config in both directions, including over
 * `enabled: false`: the human who just typed `/gatec guard remind` means it, and there is no other way to ask
 * of a config that switched the guard off. `/gatec guard off` is the answer back.
 */
export function effectiveGuardAction(config: GuardConfig, budget: GuardBudget): GuardAction {
	return budget.action ?? (config.enabled ? config.action : "off");
}

/** The assistant message a turn ends on — `turn_end` always carries one, but `AgentMessage` is a union. */
type GuardedMessage = Extract<TurnEndEvent["message"], { role: "assistant" }>;

/** Text blocks of a finished message, joined. */
export function assistantText(message: GuardedMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n");
}

function assistantThinking(message: GuardedMessage): string {
	const content = message.content;
	if (typeof content === "string") return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "thinking") parts.push(block.thinking);
	}
	return parts.join("\n");
}

/**
 * The `turn_end` hook: guard the message the model just finished, and only when the run would otherwise end
 * on it.
 *
 * Skipped, in order: every form of "off" (`--no-gate`, `/gatec off`, `gate.guard.enabled=false`,
 * `action:"off"`); a turn that ran tools, because that model already has a tool result to read and the run is
 * continuing anyway; an aborted or errored turn, because a human pressed Escape or the provider failed, and
 * neither is the model's mistake to correct; a message already reminded; and a spent reminder budget.
 */
export function guardTurnEnd(event: TurnEndEvent, ctx: ExtensionContext, state: GuardTurnState, deps: GuardTurnDeps = {}): TurnEndEventResult | undefined {
	const config = state.policy.config.guard;
	const action = effectiveGuardAction(config, state.budget);
	if (action === "off") return undefined;
	if (event.outcome !== "completed") return undefined;
	if (event.toolResults.length > 0) return undefined;
	const message = event.message;
	if (message.role !== "assistant") return undefined;
	if (!REMINDABLE_STOP_REASONS.has(message.stopReason)) return undefined;
	if (state.budget.seen.has(event.messageEntryId)) return undefined;

	const hit = detectMalformedCall({
		text: assistantText(message),
		thinking: assistantThinking(message),
		toolNames: state.toolNames,
		config,
		sessionDisabled: state.budget.disabled,
	});
	if (!hit) return undefined;

	const budget = state.budget;
	const spend = action === "remind" && budget.reminders < config.maxReminders;
	budget.last = { rules: hit.rules, label: hit.label };
	if (spend) {
		budget.reminders++;
		budget.seen.add(event.messageEntryId);
		if (budget.seen.size > REMINDER_MEMORY_LIMIT) {
			const oldest = budget.seen.values().next();
			if (!oldest.done) budget.seen.delete(oldest.value);
		}
	}

	const appendLog = deps.guardLog ?? guardLog;
	const logPath = deps.logPath?.() ?? defaultGuardLogPath();
	const entry: GuardLogEntry = {
		ts: (deps.now ?? (() => new Date()))().toISOString(),
		kind: "malformed-tool-call",
		rules: hit.rules,
		label: hit.label,
		evidence: hit.evidence,
		action: spend ? "remind" : action,
		turnIndex: event.turnIndex,
		stopReason: message.stopReason,
		model: message.model,
		reminders: budget.reminders,
	};
	void appendLog(logPath, entry);

	ctx.ui.notify(guardNotice(hit, action), "warning");
	if (!spend) {
		if (action === "remind") {
			ctx.ui.notify(`[gate] reminder budget spent (${config.maxReminders}) — leaving the run alone; raise gate.guard.maxReminders or run /gatec guard reset`, "warning");
		}
		return undefined;
	}

	const entries: SessionBoundaryDraft[] = [
		{
			type: "custom_message",
			customType: GUARD_MESSAGE_TYPE,
			content: [{ type: "text", text: reminderText(hit, message.stopReason === "length") }],
			display: true,
			details: { rules: hit.rules, label: hit.label, evidence: hit.evidence, turnIndex: event.turnIndex },
		},
	];
	// `continue` is Pi's boundary answer for "run another turn", and the appended message is what makes the
	// continuation runnable: a context ending on an assistant message is not.
	return { entries, continue: true };
}
