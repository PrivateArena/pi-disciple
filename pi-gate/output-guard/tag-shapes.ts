/**
 * Tag shapes: the tag vocabulary of the call dialects and the scanner that lifts every `<…>` out of a
 * message, including the ones a truncated emission never closed.
 */

/** Tag names that mean "tool call" in every dialect that uses them. */
export const CALL_TAG_NAMES: ReadonlySet<string> = new Set(["toolcall", "toolcalls", "tooluse", "functioncall", "functioncalls"]);

/** Tag names that mean a call only next to an argument shape (`<invoke name="x">`, `<parameter=path>`). */
export const ARG_TAG_NAMES: ReadonlySet<string> = new Set([
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
export const HTML_TAG_NAMES: ReadonlySet<string> = new Set([
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

export const TAG_RE = /<[/!]?[A-Za-z][^<>]{0,400}>?/g;

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
export function hasArgumentShape(tag: Tag): boolean {
	return /[=(]/.test(tag.body);
}
