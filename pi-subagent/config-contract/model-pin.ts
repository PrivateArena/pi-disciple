/**
 * The `subagent.model` pin half of the config vocabulary: the words that mean "no pin, inherit the session
 * model" and the reader that turns one written value into a pin or a refusal. Split out of `config-file.ts`,
 * which keeps re-exporting `MODEL_INHERIT_WORDS` as its facade. A leaf module — it imports nothing.
 */

/** Mirror of `schema.ts::MODEL_INHERIT_WORDS` — values of `subagent.model` that mean "no pin". */
export const MODEL_INHERIT_WORDS: readonly string[] = ["inherit", "inherited", "session", "parent", "default"];

/** `subagent.model`: an inherit word means "no pin" — that is what lets the shipped config show the key. */
export function readModelValue(value: unknown): { model?: string; error?: string } {
	if (typeof value !== "string" || !value.trim())
		return { error: `must be a non-empty string like "provider/id", or one of ${MODEL_INHERIT_WORDS.join(", ")}` };
	const text = value.trim();
	if (MODEL_INHERIT_WORDS.includes(text.toLowerCase())) return {};
	if (text.startsWith("/") || text.startsWith(":")) return { error: `"${text}" is not a usable model reference` };
	return { model: text };
}
