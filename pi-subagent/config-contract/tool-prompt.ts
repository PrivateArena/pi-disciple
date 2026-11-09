/**
 * The `subagent.tool` half of the config vocabulary: the keys that may appear in the block, the placeholders its
 * text may use, and the shape rules a value can trip. Semantics live in `../tool-declaration.ts`, which is the
 * only place that knows what a placeholder expands to.
 *
 * Mirror of `pi-gate/config-contract/subagent-section.ts::parseToolPromptConfig`, error-for-error —
 * `__tests__/config-parity.test.ts` feeds the same block to both readers and compares the lists.
 */

import type { SubagentToolPrompt } from "../../pi-gate/schema.ts";
import { isRecordish } from "./tolerant-parse.ts";
import { isDocKey } from "./role-names.ts";

/** Mirror of `schema.ts::SUBAGENT_TOOL_PROMPT_KEYS`. */
export const TOOL_PROMPT_KEYS = ["description", "promptSnippet", "promptGuidelines"] as const satisfies readonly (keyof SubagentToolPrompt)[];

/** Mirror of `schema.ts::SUBAGENT_TOOL_PROMPT_TOKENS`, the vocabulary `tool-declaration.ts` expands. */
export const TOOL_PROMPT_TOKENS = ["roles", "roleNames", "defaultRole"] as const;

/** Mirror of `schema.ts::unknownToolPromptToken`: the first placeholder this vocabulary does not answer to. */
export function unknownToolPromptToken(text: string): string | undefined {
	for (const match of text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)) {
		if (!(TOOL_PROMPT_TOKENS as readonly string[]).includes(match[1]!)) return match[0];
	}
	return undefined;
}

function tokenError(where: string, key: string, token: string): string {
	return `${where}: subagent.tool.${key} uses unknown token "${token}" (known: ${TOOL_PROMPT_TOKENS.map((name) => `{{${name}}}`).join(", ")}), ignored`;
}

/** Read one `subagent.tool` block: one error per bad field, and that field alone is dropped. Never throws. */
export function readToolPrompt(raw: unknown, where: string, errors: string[]): SubagentToolPrompt | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!isRecordish(raw)) {
		errors.push(`${where}: subagent.tool must be an object of ${TOOL_PROMPT_KEYS.join(", ")}, ignored`);
		return undefined;
	}
	const out: SubagentToolPrompt = {};
	for (const [key, value] of Object.entries(raw)) {
		if (isDocKey(key)) continue; // an unread note may not become a config error, so it is skipped, not refused
		if (!(TOOL_PROMPT_KEYS as readonly string[]).includes(key)) {
			errors.push(`${where}: subagent.tool.${key} is not a tool prompt key (${TOOL_PROMPT_KEYS.join(", ")}), ignored`);
			continue;
		}
		if (key === "promptGuidelines") {
			if (!Array.isArray(value) || !value.length || value.some((line) => typeof line !== "string" || !line.trim())) {
				errors.push(`${where}: subagent.tool.promptGuidelines must be a non-empty array of non-empty strings, ignored`);
				continue;
			}
			const kept: string[] = [];
			value.forEach((line, index) => {
				const token = unknownToolPromptToken(String(line));
				if (token) errors.push(tokenError(where, `promptGuidelines[${index}]`, token));
				else kept.push(String(line).trim());
			});
			if (kept.length) out.promptGuidelines = kept;
			continue;
		}
		if (typeof value !== "string" || !value.trim()) {
			errors.push(`${where}: subagent.tool.${key} must be a non-empty string, ignored`);
			continue;
		}
		const token = unknownToolPromptToken(value);
		if (token) {
			errors.push(tokenError(where, key, token));
			continue;
		}
		if (key === "description") out.description = value.trim();
		else out.promptSnippet = value.trim();
	}
	return Object.keys(out).length ? out : undefined;
}
