/**
 * Quote-aware bash segmentation: the one seam for a future real shell parser
 * (plan step 3, split out of `match.ts`).
 */

// ---------------------------------------------------------------------------
// bash segmentation
// ---------------------------------------------------------------------------
/** Quote-aware split of a command line into every command it can run. */
export function segmentCommands(command: string): string[] {
	const src = command.replace(/\\\r?\n/g, " ");
	const segments: string[] = [];
	let buf = "";
	let quote: '"' | "'" | null = null;
	let parenDepth = 0;

	const flush = () => {
		const seg = buf.trim();
		if (seg) segments.push(seg);
		buf = "";
	};

	for (let i = 0; i < src.length; i++) {
		const c = src[i]!;

		if (quote) {
			buf += c;
			if (c === quote && src[i - 1] !== "\\") quote = null;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			buf += c;
			continue;
		}
		if (c === "\\") {
			buf += c;
			if (i + 1 < src.length) buf += src[++i];
			continue;
		}

		// Heredoc body: copied verbatim, never split.
		if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "(") {
			const next = consumeHeredoc(src, i);
			buf += src.slice(i, next);
			i = next - 1;
			continue;
		}
		// Process substitution `<(` / `>(`: copied verbatim, never split.
		if ((c === "<" || c === ">") && src[i + 1] === "(") {
			const next = consumeBalanced(src, i + 1);
			buf += src.slice(i, next);
			i = next - 1;
			continue;
		}

		if (c === "(") {
			parenDepth++;
			buf += c;
			continue;
		}
		if (c === ")") {
			parenDepth = Math.max(0, parenDepth - 1);
			buf += c;
			continue;
		}
		if (parenDepth > 0) {
			buf += c;
			continue;
		}

		const two = src.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			flush();
			i++;
			continue;
		}
		// File-descriptor redirects (`2>&1`, `<&`, `&>`) are not command separators.
		if (c === "&" && (src[i - 1] === ">" || src[i - 1] === "<" || src[i + 1] === ">" || src[i + 1] === "&")) {
			buf += c;
			continue;
		}
		if (c === ";" || c === "\n" || c === "|" || c === "&") {
			flush();
			continue;
		}
		buf += c;
	}
	flush();
	return segments;
}

/** Index just past the whole heredoc (header line + body + terminator line). */
function consumeHeredoc(src: string, start: number): number {
	let i = start + 2;
	if (src[i] === "-") i++;
	while (src[i] === " " || src[i] === "\t") i++;
	let delim = "";
	while (i < src.length && /[^\s|&;<>()]/.test(src[i]!)) delim += src[i++];
	if (!delim) return start + 2;
	const bare = delim.replace(/^['"`]|['"`]$/g, "");
	if (!bare) return start + 2;
	const lineEnd = src.indexOf("\n", i);
	if (lineEnd < 0) return src.length;
	const terminator = new RegExp(`^[ \t]*${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \t]*$`);
	let cursor = lineEnd + 1;
	while (cursor < src.length) {
		const next = src.indexOf("\n", cursor);
		const line = src.slice(cursor, next < 0 ? src.length : next);
		if (terminator.test(line)) return next < 0 ? src.length : next + 1;
		if (next < 0) break;
		cursor = next + 1;
	}
	return src.length;
}

/** `start` points at "("; returns the index after the matching ")". */
function consumeBalanced(src: string, start: number): number {
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		if (src[i] === "(") depth++;
		else if (src[i] === ")") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return src.length;
}

/** `FOO=1 BAR=x cmd …` → the command part plus the stripped assignment names. */
export function peelEnvPrefix(seg: string): { command: string; stripped: string[] } {
	const tokens = tokenize(seg);
	const stripped: string[] = [];
	let i = 0;
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
		stripped.push(tokens[i]!.split("=")[0]!);
		i++;
	}
	return { command: tokens.slice(i).join(" "), stripped };
}

/** Quote-aware whitespace split. Expansion syntax is preserved, not evaluated. */
export function tokenize(seg: string): string[] {
	const out: string[] = [];
	let buf = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < seg.length; i++) {
		const c = seg[i]!;
		if (quote) {
			if (c === quote && seg[i - 1] !== "\\") quote = null;
			else buf += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			continue;
		}
		if (c === "\\") {
			buf += seg[++i] ?? "";
			continue;
		}
		if (/\s/.test(c)) {
			if (buf) {
				out.push(buf);
				buf = "";
			}
			continue;
		}
		buf += c;
	}
	if (buf) out.push(buf);
	return out;
}

/** Command substitution, backticks and process substitution are not parsed: they always escalate. */
export function hasUnparsedExpansion(seg: string): boolean {
	let quote: "'" | null = null;
	for (let i = 0; i < seg.length; i++) {
		const c = seg[i]!;
		if (c === "'") quote = quote ? null : "'";
		if (quote) continue;
		if (seg.startsWith("$(", i) || seg.startsWith("`", i) || seg.startsWith("<(", i) || seg.startsWith(">(", i)) return true;
	}
	return false;
}
