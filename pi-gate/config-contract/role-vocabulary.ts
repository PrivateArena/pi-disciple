/**
 * The `subagent.roles` vocabulary: role names and ids, thinking-level words, the `RoleConfig` shape and
 * the role ceilings (plan step 2, split out of `schema.ts`).
 *
 * pi-subagent imports these types; this module keeps importing nothing at runtime but the leaf below it.
 */

import { type SamplingConfig } from "./sampling-vocabulary.ts";

/**
 * Role names, as a literal union here so this file keeps importing nothing: `pi-subagent/roles.ts`
 * makes this its `RoleName`, and a drift test in `roles.test.ts` pins the union to the roles that
 * actually exist. A *human* writes these in the config; the model never chooses them from config.
 */
export type SubagentRoleName = "explore" | "general-purpose" | "review";

/**
 * A role id: one of the built-in names, or a name a human added under `subagent.roles`.
 *
 * Config-defined roles are still human-authored — only the *name list* became dynamic, never the tool
 * list a model may ask for, so the plan's objection ("a model-chosen child allowlist is a
 * privilege-escalation primitive") is untouched: the model picks a name, the config decides what it means.
 */
export type SubagentRoleId = SubagentRoleName | string;

/**
 * Pi's thinking levels, spelled here so this file keeps importing nothing (see `SubagentRoleName`).
 * `subagent.roles.<name>.thinkingLevel` and the keys of `samplingByThinkingLevel` use these words, which are
 * pi's own `MODEL_THINKING_LEVELS` — not the provider values a `thinkingLevelMap` maps them to.
 */
export const THINKING_LEVEL_WORDS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type ThinkingLevelWord = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export function isThinkingLevelWord(value: unknown): value is ThinkingLevelWord {
	return typeof value === "string" && (THINKING_LEVEL_WORDS as readonly string[]).includes(value.trim().toLowerCase());
}

/** One entry of `subagent.roles`: a partial edit of a built-in role, or the definition of a new one. */
export interface RoleConfig {
	/** Label shown by `/subagentc roles` and in the `<delegation>` prompt section. */
	description?: string;
	/** Instruction appended to the child system prompt, beside the built-in role's own line. */
	prompt?: string;
	/** Tool names the child may reach; `"*"` means the parent's callable set. Required for a *new* role. */
	tools?: string[];
	/** Clamped later by the session-wide `subagent.maxTurns`. */
	maxTurns?: number;
	timeoutMinutes?: number;
	/**
	 * Request-body sampling parameters for a child running this role (`sampling`), merged over whatever the
	 * model itself declares in `models.json` (`samplingParams`). Free-form on purpose — see {@link SamplingValue}.
	 * Applies to the OpenAI-compatible APIs only; other APIs ignore them (see `pi-subagent/sampling.ts`).
	 */
	sampling?: SamplingConfig;
	/** The same, for one thinking level only — pi's `samplingParamsByThinkingLevel`, keyed by its level words. */
	samplingByThinkingLevel?: Partial<Record<ThinkingLevelWord, SamplingConfig>>;
	/**
	 * The child's thinking level (`thinkingLevel`). Unset means inherit the session's, which is what
	 * `pi-subagent/model-override.ts::childThinkingLevel` settles against the model's capabilities.
	 */
	thinkingLevel?: ThinkingLevelWord;
}

export type RoleConfigMap = Record<string, RoleConfig>;

/** A role id a config file may use: lowercase, starts with a letter, short enough to render in a prompt. */
export const ROLE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function isRoleId(value: unknown): value is string {
	return typeof value === "string" && ROLE_ID_PATTERN.test(value.trim());
}

/** A role id is matched case- and separator-insensitively, so fold before comparing. */
export function foldRoleId(value: string): string {
	return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/** Beyond these the shipped ceilings stop being sane: `maxTurns` x parallel calls must stay under 256 (FM-13). */
export const ROLE_TURNS_CEILING = 200;
export const ROLE_TIMEOUT_CEILING_MINUTES = 120;
