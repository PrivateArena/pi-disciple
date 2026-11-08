/**
 * Config document types and tolerant parsers, shared by pi-gate and pi-subagent (plan step 2).
 *
 * The two extensions read the same `config.json` file(s) but only ever import this module's types
 * and pure parsers — never each other (see the plan's ownership boundary).
 */

export type Action = "allow" | "ask" | "deny";

import { REGEX_PROBE_LIMIT, regexPatternError } from "./match.ts";

/** Precedence order, lowest first: later scopes override earlier ones (last matching pattern wins). */
export type Scope =
	| "builtin"
	| "global"
	| "project"
	| "grants.global"
	| "grants.project"
	| "grants.session";

export const SCOPE_PRECEDENCE: readonly Scope[] = [
	"builtin",
	"global",
	"project",
	"grants.global",
	"grants.project",
	"grants.session",
];

/** `deny > ask > allow`, used when combining the facts of one call (most restrictive wins). */
export const ACTION_SEVERITY: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };

export function isAction(value: unknown): value is Action {
	return value === "allow" || value === "ask" || value === "deny";
}

export function mostRestrictive(a: Action, b: Action): Action {
	return ACTION_SEVERITY[a] >= ACTION_SEVERITY[b] ? a : b;
}

/** One entry of a `gate.permission` surface map, in file order. */
export interface PermissionEntry {
	surface: string;
	/** `"*"` for the shorthand string form (`"read": "allow"`). */
	pattern: string;
	action: Action;
}

/** A persisted grant: `gate.grants.global` / `gate.grants.project` in a config file. */
export interface GrantRule {
	surface: string;
	pattern: string;
	action: Action;
}

/**
 * One `gate.hardDeny` entry: a deny the "allow everything" mode cannot swallow (plan step C).
 *
 * Deliberately **not** a {@link GrantRule} and never an `action` field: there is exactly one action, and
 * the absence of a knob is what makes the entry un-coercible by a dialog click. `surface` is optional
 * because the common case is "this thing, wherever it appears" — a host, a file, a command — and `"*"`
 * means every surface, including the cross-cutting `path` / `external_directory` / `network` ones.
 */
export interface HardDenyRule {
	surface?: string;
	pattern: string;
	/** Shown in the block text and the review log: why a human wrote the rule, for whoever hits it. */
	reason?: string;
}

/**
 * What the output guard does with a call the model wrote as text instead of making.
 *
 * `off` never looks. `notify` tells the human and logs, and lets the run end — the shape is reported but
 * the model is not interrupted. `remind` additionally appends a reminder and keeps the run going, which is
 * the only setting that saves the turn.
 */
export type GuardAction = "off" | "notify" | "remind";

export function isGuardAction(value: unknown): value is GuardAction {
	return value === "off" || value === "notify" || value === "remind";
}

/**
 * The rule ids the guard ships with — the vocabulary `disableRules` is written against, and what
 * `/gatec guard` lists. `guard.ts` implements exactly this set; a drift test pins the two together.
 */
export const GUARD_BUILTIN_RULE_IDS: readonly string[] = [
	"call-tag",
	"call-fragment",
	"tool-name-tag",
	"json-call",
	"json-call-truncated",
	"special-token",
	"chat-template-token",
	"call-in-thinking",
];

/**
 * One detector the human can switch off, add to, or re-word. `pattern` is matched against the scanned
 * tail of the assistant message exactly like every other gate pattern: a glob, or a regex with `re:`.
 */
export interface GuardRuleConfig {
	id: string;
	pattern: string;
	/** How the reminder names the shape; defaults to "a call written as message text". */
	label?: string;
	/** The instruction the reminder gives; defaults to the built-in one. */
	advice?: string;
}

export interface GuardConfig {
	enabled: boolean;
	action: GuardAction;
	/** Reminders per session. Restored by the next real tool call, so a run cannot be nudged to death. */
	maxReminders: number;
	/** Characters of message tail the rules read. Capped by the gate's regex probe budget (see `match.ts`). */
	scanTailChars: number;
	/** Built-in rule ids to switch off, e.g. `["tool-name-tag"]` when the task is about XML tool syntax. */
	disableRules: string[];
	/** Extra detectors, same shape as `hardDeny`: concatenated across config files, never ordered. */
	rules: GuardRuleConfig[];
	/** Text these patterns match is *about* tool calls, not leaking one: the guard stays out. */
	allowPatterns: string[];
	/** Treat a tag named after one of the session's own tools (`<bash>`, `<read path=>`) as a leaked call. */
	matchToolNames: boolean;
	/** When a message has no text at all, look at the end of its thinking for the same shapes. */
	checkEmptyThinking: boolean;
}

export interface GateConfig {
	enabled: boolean;
	reviewLog: boolean;
	/** 0 waits forever; any timeout or dismiss resolves to abort, never to allow. */
	promptTimeoutMs: number;
	permission: Record<string, Action | Record<string, Action>>;
	/** Deny rules above the mode and above any matching allow. Config-only; the dialog never writes them. */
	hardDeny: HardDenyRule[];
	/** The output guard (`guard.ts`): a tool call that arrived as text and would have ended the run. */
	guard: GuardConfig;
}

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
 * One value of a sampling block, and the block itself.
 *
 * The shape is deliberately "anything JSON can hold", not a list of known knobs: pi's own
 * `SamplingParams` is a free-form bag that it merges into the request body verbatim, because the field
 * names belong to the inference server (`top_k`, `min_p`, `repetition_penalty`, `chat_template_kwargs`,
 * `do_sample`, ...) and not to pi. Restricting the keys here would make a new server feature a pi-subagent
 * release instead of a config edit.
 */
export type SamplingValue = number | boolean | string | null | SamplingValue[] | { [key: string]: SamplingValue };
export type SamplingConfig = Record<string, SamplingValue>;

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
const ROLE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

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

/**
 * Values of `subagent.model` that mean "no pin, inherit the session model".
 *
 * They exist because the shipped config is strict JSON with no comment syntax: without a word for
 * "unset" the key could not be shown to a human at all, and a placeholder id would either pin every
 * child to a model or warn on every session start.
 */
export const MODEL_INHERIT_WORDS: readonly string[] = ["inherit", "inherited", "session", "parent", "default"];

export interface ModelValue {
	/** The pin to resolve, or `undefined` when the child inherits the session model. */
	model?: string;
	/** Set when the text named no model, so the caller reports the exact value it tried. */
	error?: string;
}

/** Read one `subagent.model` value: an inherit word clears the pin, anything else becomes the reference. */
export function parseModelValue(value: unknown): ModelValue {
	if (typeof value !== "string" || !value.trim()) return { error: "must be a non-empty string like \"provider/id\", or one of " + MODEL_INHERIT_WORDS.join(", ") };
	const text = value.trim();
	const word = text.toLowerCase();
	if (MODEL_INHERIT_WORDS.includes(word)) return {};
	if (text.startsWith("/") || text.startsWith(":")) return { error: `"${text}" is not a usable model reference` };
	return { model: text };
}

export interface SubagentLimits {
	/** Master switch for the `subagent` tool (`subagent.enabled`). */
	enabled: boolean;
	maxTurns: number;
	timeoutMinutes: number;
	/**
	 * How much of the child's report goes to the *model* (`subagent.maxResultBytes`). The report is the
	 * artifact the delegation paid for, so this is a safety bound, not a budget to spend: up to this size the
	 * report arrives whole, and beyond it the head is returned and the complete report is written next to the
	 * child's transcript as `<id>.report.md`, which the result names. Keep it above any report you would
	 * legitimately ask for — the fallback costs a file read, and re-reading the transcript costs more.
	 */
	maxResultBytes: number;
	keepTranscripts: number;
	/**
	 * Pin the child's model: `provider/id` (pi's CLI form), `provider:id`, or a bare `id`.
	 * Unset means the child inherits the model the session is on, and so does one of
	 * {@link MODEL_INHERIT_WORDS} — which is how the shipped config shows the key without pinning it.
	 * Human-authored config only — the tool itself still takes no model parameter.
	 */
	model?: string;
	/**
	 * The role a call gets when the model does not name one (`subagent.defaultRole`).
	 *
	 * `general-purpose` is the shipped default because it is not an escalation: its tool list is "whatever
	 * the parent can call right now", and every nested call is gated by the parent's policy anyway. Set it
	 * to `explore` to make unnamed delegations read-only, i.e. least privilege by default.
	 */
	defaultRole: SubagentRoleId;
	/**
	 * Role definitions from `subagent.roles`: edits of the three built-ins and any new roles. Absent means
	 * the built-in table exactly (`pi-subagent/roles.ts::applyRoleConfig`).
	 */
	roles?: RoleConfigMap;
	/**
	 * Add the `delegation` system prompt section ("when to hand work to a child") to runs of this session
	 * (`subagent.delegationPrompt`). Without it the only guidance the model gets is the tool's own
	 * description and two `<rules>` bullets, which is why the tool goes unused.
	 */
	delegationPrompt: boolean;
	/**
	 * Ask the human, once per run, when a child reaches its turn or time budget (`subagent.askToExtend`).
	 * The budgets are per-role guesses, and the common failure is a delegation that turns out bigger than the
	 * role guessed: the dialog hands the run more turns and minutes, or ends it as it always was. Anything other
	 * than an explicit "Extend" choice — Esc, a dialog nobody answered, no UI — enforces the ceiling unchanged.
	 */
	askToExtend: boolean;
}

/**
 * On by default: a call that silently ends the turn costs the whole run, and the guard's own cost is
 * bounded by {@link GuardConfig.maxReminders}. Every shape test is strict and lives in `guard.ts`; this is
 * only the switch, the budget and the human's additions.
 */
export const DEFAULT_GUARD_CONFIG: GuardConfig = {
	enabled: true,
	action: "remind",
	maxReminders: 3,
	scanTailChars: REGEX_PROBE_LIMIT,
	disableRules: [],
	rules: [],
	allowPatterns: [],
	matchToolNames: true,
	checkEmptyThinking: true,
};

/** Matches the shipped default config block in the plan (step 17). */
export const DEFAULT_GATE_CONFIG: GateConfig = {
	enabled: true,
	reviewLog: false,
	promptTimeoutMs: 0,
	permission: {
		"*": "ask",
		read: "allow",
		// Inside the workspace the agent may create and change files without a prompt: the `path`
		// rules, the `external_directory` floor and the protected-path floor still bound it.
		write: "allow",
		edit: "allow",
		grep: "allow",
		find: "allow",
		ls: "allow",
		path: {
			"*": "allow",
			"*.env": "deny",
			"*.env.*": "deny",
			"*.env.example": "allow",
			"*.pem": "deny",
			"*.key": "deny",
			"*id_rsa*": "deny",
		},
		external_directory: "ask",
		bash: { "*": "ask" },
		/**
		 * The egress surface (plan step B4): one fact per host a call can reach, allow-by-default so no
		 * existing user is suddenly prompted. Flipping `"*"` to `"ask"` is how you get a prompt for every
		 * host a call touches; a scoped pattern (`"aliyuncs.com": "deny"`) is the targeted form, and
		 * `gate.hardDeny` is the **mode-proof** one — it still blocks with "allow everything" turned on.
		 *
		 * A surface a config file does not name inherits this default action (`policy.ts::absorb`), which is
		 * what keeps a years-old config from silently acquiring a new prompt — and what makes the *absence* of
		 * a key a decision rather than an accident.
		 */
		network: { "*": "allow" },
		// The subagent tool itself has no side effects; its nested calls are gated individually.
		// (Deviation from the plan's shipped block, which left it at the "*": "ask" default.)
		subagent: "allow",
	},
	/**
	 * Empty by design (plan step C4): a deny class nobody is born with. The key is documented in
	 * `pi-gate/config.json` and is **config-only** — the dialog never writes it, and neither does
	 * `grants.ts` — because a rule that blocks past "allow everything" has to be human-authored.
	 */
	hardDeny: [],
	guard: DEFAULT_GUARD_CONFIG,
};

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
	enabled: true,
	defaultRole: "general-purpose",
	delegationPrompt: true,
	maxTurns: 30,
	timeoutMinutes: 20,
	maxResultBytes: 65536,
	keepTranscripts: 20,
	askToExtend: true,
};

/** A `==`-prefixed key is documentation in this file, so no layer of the gate may read it as config. */
export function isDocKey(key: string): boolean {
	return key.startsWith("==");
}

/** Ordered permission entries of a `gate.permission` map (insertion order is the rule order). */
export function flattenPermission(permission: GateConfig["permission"]): PermissionEntry[] {
	const out: PermissionEntry[] = [];
	for (const [surface, value] of Object.entries(permission)) {
		if (isDocKey(surface)) continue;
		if (isAction(value)) {
			out.push({ surface, pattern: "*", action: value });
		} else if (value && typeof value === "object") {
			for (const [pattern, action] of Object.entries(value)) {
				if (isAction(action)) out.push({ surface, pattern, action });
			}
		}
	}
	return out;
}

/**
 * A `gate` block as one config file wrote it: every scalar optional, and `guard` partial for the same reason
 * — a file that names one guard knob must not be read as having restated the other eight.
 */
export type PartialGateConfig = Partial<Omit<GateConfig, "guard">> & { guard?: Partial<GuardConfig> };

export interface ParsedGateConfig {
	config: PartialGateConfig;
	entries: PermissionEntry[];
	grants: { global: GrantRule[]; project: GrantRule[] };
	hardDeny: HardDenyRule[];
	errors: string[];
}

/**
 * Parse the `gate` section of one config file. Never throws: unknown keys, wrong types and invalid
 * actions are returned in `errors` and contribute no rule (the caller notifies and fails closed).
 */
export function parseGateConfig(raw: unknown, where: string): ParsedGateConfig {
	const errors: string[] = [];
	const config: PartialGateConfig = {};
	const grants: ParsedGateConfig["grants"] = { global: [], project: [] };

	if (raw === undefined || raw === null) return { config, entries: [], grants, hardDeny: [], errors };
	const wrapped = isRecord(raw) && "gate" in raw ? raw.gate : raw;
	if (wrapped === undefined || wrapped === null) return { config, entries: [], grants, hardDeny: [], errors };
	if (typeof wrapped !== "object" || Array.isArray(wrapped)) {
		errors.push(`${where}: "gate" must be an object`);
		return { config, entries: [], grants, hardDeny: [], errors };
	}

	const doc = wrapped as Record<string, unknown>;
	if (doc.enabled !== undefined) {
		if (typeof doc.enabled === "boolean") config.enabled = doc.enabled;
		else errors.push(`${where}: gate.enabled must be a boolean, ignored`);
	}
	if (doc.reviewLog !== undefined) {
		if (typeof doc.reviewLog === "boolean") config.reviewLog = doc.reviewLog;
		else errors.push(`${where}: gate.reviewLog must be a boolean, ignored`);
	}
	if (doc.promptTimeoutMs !== undefined) {
		if (typeof doc.promptTimeoutMs === "number" && Number.isFinite(doc.promptTimeoutMs) && doc.promptTimeoutMs >= 0) {
			config.promptTimeoutMs = Math.floor(doc.promptTimeoutMs);
		} else {
			errors.push(`${where}: gate.promptTimeoutMs must be a number >= 0, ignored`);
		}
	}

	const entries: PermissionEntry[] = [];
	if (doc.permission !== undefined) {
		if (!isRecord(doc.permission)) {
			errors.push(`${where}: gate.permission must be an object, ignored`);
		} else {
			for (const [surface, value] of Object.entries(doc.permission)) {
				if (isDocKey(surface)) continue; // `==permission`, `==powershell`: prose, not a surface
				if (isAction(value)) {
					entries.push({ surface, pattern: "*", action: value });
				} else if (isRecord(value)) {
					for (const [pattern, action] of Object.entries(value)) {
						const bad = regexPatternError(pattern);
						if (bad) {
							errors.push(`${where}: gate.permission.${surface}["${pattern}"] ${bad}, ignored`);
							continue;
						}
						if (isAction(action)) entries.push({ surface, pattern, action });
						else errors.push(`${where}: gate.permission.${surface}["${pattern}"] is not an action, ignored`);
					}
				} else {
					errors.push(`${where}: gate.permission.${surface} must be "allow"|"ask"|"deny" or a pattern map, ignored`);
				}
			}
		}
		config.permission = doc.permission as GateConfig["permission"];
	}

	if (doc.grants !== undefined) {
		if (!isRecord(doc.grants)) {
			errors.push(`${where}: gate.grants must be an object, ignored`);
		} else {
			grants.global = parseGrantList(doc.grants.global, `${where}: gate.grants.global`, errors);
			grants.project = parseGrantList(doc.grants.project, `${where}: gate.grants.project`, errors);
		}
	}

	const hardDeny = doc.hardDeny === undefined ? [] : parseHardDenyList(doc.hardDeny, `${where}: gate.hardDeny`, errors);
	if (doc.hardDeny !== undefined) config.hardDeny = hardDeny;
	if (doc.guard !== undefined) config.guard = parseGuardConfig(doc.guard, `${where}: gate.guard`, errors);

	return { config, entries, grants, hardDeny, errors };
}

/**
 * Parse one `gate.guard` block of one config file, returning only the keys that file wrote.
 *
 * Written-keys-only is what makes the layering behave: {@link mergeGuardConfigs} then lets a project file
 * change one number without re-deriving every other key from its own defaults, exactly like the scalar keys
 * of the rest of `gate`.
 *
 * `rules` are matched against message text, so an invalid pattern is refused the way every other gate pattern
 * is: reported at config-settle, matches nothing, and cannot widen or narrow anything.
 */
export function parseGuardConfig(raw: unknown, where: string, errors: string[]): Partial<GuardConfig> {
	const guard: Partial<GuardConfig> = {};
	if (!isRecord(raw)) {
		errors.push(`${where} must be an object, ignored`);
		return guard;
	}
	const doc = raw as Record<string, unknown>;
	if (doc.enabled !== undefined) {
		if (typeof doc.enabled === "boolean") guard.enabled = doc.enabled;
		else errors.push(`${where}.enabled must be a boolean, ignored`);
	}
	if (doc.action !== undefined) {
		if (isGuardAction(doc.action)) guard.action = doc.action;
		else errors.push(`${where}.action must be "off"|"notify"|"remind", ignored`);
	}
	if (doc.maxReminders !== undefined) {
		if (typeof doc.maxReminders === "number" && Number.isFinite(doc.maxReminders) && doc.maxReminders >= 0) {
			guard.maxReminders = Math.floor(doc.maxReminders);
		} else {
			errors.push(`${where}.maxReminders must be a number >= 0, ignored`);
		}
	}
	if (doc.scanTailChars !== undefined) {
		if (typeof doc.scanTailChars === "number" && Number.isFinite(doc.scanTailChars) && doc.scanTailChars >= 256) {
			if (doc.scanTailChars > REGEX_PROBE_LIMIT) {
				errors.push(`${where}.scanTailChars is capped at ${REGEX_PROBE_LIMIT} (a longer tail would hide its end from an re: rule), using that`);
				guard.scanTailChars = REGEX_PROBE_LIMIT;
			} else {
				guard.scanTailChars = Math.floor(doc.scanTailChars);
			}
		} else {
			errors.push(`${where}.scanTailChars must be a number >= 256, ignored`);
		}
	}
	if (doc.matchToolNames !== undefined) {
		if (typeof doc.matchToolNames === "boolean") guard.matchToolNames = doc.matchToolNames;
		else errors.push(`${where}.matchToolNames must be a boolean, ignored`);
	}
	if (doc.checkEmptyThinking !== undefined) {
		if (typeof doc.checkEmptyThinking === "boolean") guard.checkEmptyThinking = doc.checkEmptyThinking;
		else errors.push(`${where}.checkEmptyThinking must be a boolean, ignored`);
	}
	const ids = (key: "disableRules"): string[] | undefined => {
		const value = doc[key];
		if (value === undefined) return undefined;
		if (!Array.isArray(value)) {
			errors.push(`${where}.${key} must be an array of rule ids, ignored`);
			return undefined;
		}
		const out: string[] = [];
		for (const id of value) {
			if (typeof id !== "string" || !id.trim()) {
				errors.push(`${where}.${key} entries must be non-empty strings, one ignored`);
				continue;
			}
			if (!GUARD_BUILTIN_RULE_IDS.includes(id.trim())) {
				errors.push(`${where}.${key} names "${id}", which is not a built-in guard rule (built-ins: ${GUARD_BUILTIN_RULE_IDS.join(", ")})`);
				continue;
			}
			out.push(id.trim());
		}
		return out;
	};
	const disabled = ids("disableRules");
	if (disabled) guard.disableRules = disabled;

	if (doc.rules !== undefined) {
		if (!Array.isArray(doc.rules)) errors.push(`${where}.rules must be an array, ignored`);
		else {
			const rules: GuardRuleConfig[] = [];
			doc.rules.forEach((item, i) => {
				const at = `${where}.rules[${i}]`;
				if (!isRecord(item) || typeof item.pattern !== "string" || !item.pattern.trim()) {
					errors.push(`${at} must be {id, pattern, label?, advice?} with a non-empty pattern, ignored`);
					return;
				}
				for (const key of ["id", "label", "advice"] as const) {
					const value = item[key];
					if (value !== undefined && typeof value !== "string") errors.push(`${at}.${key} must be a string, ignored`);
				}
				const bad = regexPatternError(item.pattern);
				if (bad) {
					errors.push(`${at}.pattern ${bad}, ignored`);
					return;
				}
				const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `rule-${i + 1}`;
				if (GUARD_BUILTIN_RULE_IDS.includes(id)) errors.push(`${at}.id "${id}" is a built-in guard rule; yours is kept beside it and reported separately`);
				rules.push({
					id,
					pattern: item.pattern,
					...(typeof item.label === "string" && item.label.trim() ? { label: item.label.trim() } : {}),
					...(typeof item.advice === "string" && item.advice.trim() ? { advice: item.advice.trim() } : {}),
				});
			});
			guard.rules = rules;
		}
	}

	if (doc.allowPatterns !== undefined) {
		if (!Array.isArray(doc.allowPatterns)) errors.push(`${where}.allowPatterns must be an array, ignored`);
		else {
			const patterns: string[] = [];
			for (const pattern of doc.allowPatterns) {
				if (typeof pattern !== "string" || !pattern.trim()) {
					errors.push(`${where}.allowPatterns entries must be non-empty patterns, one ignored`);
					continue;
				}
				const bad = regexPatternError(pattern);
				if (bad) {
					errors.push(`${where}.allowPatterns "${pattern}" ${bad}, ignored`);
					continue;
				}
				patterns.push(pattern);
			}
			guard.allowPatterns = patterns;
		}
	}
	return guard;
}

/**
 * Fold the `gate.guard` blocks the policy read, lowest precedence first, into the one config the guard runs.
 *
 * A written scalar is replaced by the later file that wrote one — the same rule as `gate.enabled`. The three
 * *lists* are concatenated, like `gate.hardDeny`: an extra detector or a veto is an addition, and a project
 * file must not be able to delete a rule the global file added.
 */
export function mergeGuardConfigs(files: readonly (Partial<GuardConfig> | undefined)[]): GuardConfig {
	const merged: GuardConfig = { ...DEFAULT_GUARD_CONFIG, disableRules: [], rules: [], allowPatterns: [] };
	for (const guard of files) {
		if (!guard) continue;
		for (const key of ["enabled", "action", "maxReminders", "scanTailChars", "matchToolNames", "checkEmptyThinking"] as const) {
			const value = guard[key];
			if (value !== undefined) Object.assign(merged, { [key]: value });
		}
		merged.disableRules.push(...(guard.disableRules ?? []));
		merged.rules.push(...(guard.rules ?? []));
		merged.allowPatterns.push(...(guard.allowPatterns ?? []));
	}
	return merged;
}

/**
 * Parse one `gate.hardDeny` array — same style as {@link parseGrantList}: a bad entry costs only itself.
 *
 * There is no `action` to validate because there is only one action here. An entry that names no
 * surface is kept as `"*"`: "never let this host through" is the sentence a human actually writes.
 */
export function parseHardDenyList(raw: unknown, where: string, errors: string[]): HardDenyRule[] {
	if (!Array.isArray(raw)) {
		errors.push(`${where} must be an array, ignored`);
		return [];
	}
	const out: HardDenyRule[] = [];
	raw.forEach((item, i) => {
		if (!isRecord(item) || typeof item.pattern !== "string" || !item.pattern.trim()) {
			errors.push(`${where}[${i}] must be {surface?, pattern, reason?} with a non-empty pattern, ignored`);
			return;
		}
		if (item.surface !== undefined && typeof item.surface !== "string") {
			errors.push(`${where}[${i}].surface must be a surface name, ignored`);
			return;
		}
		if (item.reason !== undefined && typeof item.reason !== "string") {
			errors.push(`${where}[${i}].reason must be a string, ignored`);
			return;
		}
		const bad = regexPatternError(item.pattern);
		if (bad) {
			errors.push(`${where}[${i}].pattern ${bad}, ignored`);
			return;
		}
		out.push({
			surface: typeof item.surface === "string" && item.surface.trim() ? item.surface.trim() : "*",
			pattern: item.pattern,
			...(typeof item.reason === "string" && item.reason.trim() ? { reason: item.reason.trim() } : {}),
		});
	});
	return out;
}

function parseGrantList(raw: unknown, where: string, errors: string[]): GrantRule[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		errors.push(`${where} must be an array, ignored`);
		return [];
	}
	const out: GrantRule[] = [];
	raw.forEach((item, i) => {
		if (!isRecord(item) || typeof item.surface !== "string" || typeof item.pattern !== "string" || !isAction(item.action)) {
			errors.push(`${where}[${i}] must be {surface, pattern, action}, ignored`);
			return;
		}
		const bad = regexPatternError(item.pattern);
		if (bad) {
			errors.push(`${where}[${i}].pattern ${bad}, ignored`);
			return;
		}
		out.push({ surface: item.surface, pattern: item.pattern, action: item.action });
	});
	return out;
}

export interface ParsedSubagentConfig {
	limits: Partial<SubagentLimits>;
	errors: string[];
}

const SUBAGENT_NUMBER_KEYS = ["maxTurns", "timeoutMinutes", "maxResultBytes", "keepTranscripts"] as const satisfies readonly (keyof SubagentLimits)[];

const SUBAGENT_ROLE_WORDS: readonly SubagentRoleName[] = ["explore", "general-purpose", "review"];

/**
 * Parse one `subagent.roles` map. Never throws; a bad entry contributes an error and no rule, so a typo in
 * one role cannot change the others. Shape only: the built-in merge and the forbidden-tool strip live in
 * `pi-subagent/roles.ts`, the one place that knows what a role is.
 */
export function parseRolesConfig(raw: unknown, where: string, errors: string[]): RoleConfigMap | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!isRecord(raw)) {
		errors.push(`${where}: subagent.roles must be an object of role names, ignored`);
		return undefined;
	}
	const out: RoleConfigMap = {};
	const folded = new Map<string, string>();
	for (const [key, value] of Object.entries(raw)) {
		// A `==` key inside the role table is the file's own documentation convention (see `==commented`), so it
		// must be inert here too: an unread note may not report an error, because an error makes the config
		// `degraded` and floors every call in the session.
		if (isDocKey(key)) continue;
		if (!isRoleId(key)) {
			errors.push(`${where}: subagent.roles key "${key}" must match ${ROLE_ID_PATTERN}, ignored`);
			continue;
		}
		const id = key.trim();
		const fold = foldRoleId(id);
		const clash = folded.get(fold);
		if (clash) {
			errors.push(`${where}: subagent.roles "${id}" collides with "${clash}" (role names ignore case, spaces, - and _), ignored`);
			continue;
		}
		folded.set(fold, id);
		if (!isRecord(value)) {
			errors.push(`${where}: subagent.roles.${id} must be an object, ignored`);
			continue;
		}
		const entry: RoleConfig = {};
		for (const textKey of ["description", "prompt"] as const) {
			const text = value[textKey];
			if (text === undefined) continue;
			if (typeof text !== "string" || !text.trim()) errors.push(`${where}: subagent.roles.${id}.${textKey} must be a non-empty string, ignored`);
			else entry[textKey] = text.trim();
		}
		if (value.tools !== undefined) {
			if (!Array.isArray(value.tools) || !value.tools.length || value.tools.some((name) => typeof name !== "string" || !name.trim())) {
				errors.push(`${where}: subagent.roles.${id}.tools must be a non-empty array of tool names, ignored`);
			} else entry.tools = value.tools.map((name) => (name as string).trim());
		}
		for (const [numberKey, ceiling] of [
			["maxTurns", ROLE_TURNS_CEILING],
			["timeoutMinutes", ROLE_TIMEOUT_CEILING_MINUTES],
		] as const) {
			const numberValue = value[numberKey];
			if (numberValue === undefined) continue;
			if (typeof numberValue !== "number" || !Number.isFinite(numberValue) || numberValue <= 0 || numberValue > ceiling) {
				errors.push(`${where}: subagent.roles.${id}.${numberKey} must be a number in 1..${ceiling}, ignored`);
				continue;
			}
			entry[numberKey] = Math.floor(numberValue);
		}
		const sampling = parseRoleSampling(value, id, where, errors);
		if (sampling.sampling) entry.sampling = sampling.sampling;
		if (sampling.samplingByThinkingLevel) entry.samplingByThinkingLevel = sampling.samplingByThinkingLevel;
		if (sampling.thinkingLevel) entry.thinkingLevel = sampling.thinkingLevel;
		out[id] = entry;
	}
	return Object.keys(out).length ? out : undefined;
}

/** A request-body field name: short, no spaces. Nested objects and arrays are passed through unchecked. */
const SAMPLING_KEY_PATTERN = /^[A-Za-z0-9_.\-]{1,64}$/;

/**
 * Keys an object literal would not put on the bag but on its prototype. They are refused rather than
 * silently swallowed, which is what assigning `__proto__` on a plain object does.
 */
const FORBIDDEN_SAMPLING_KEYS = ["__proto__", "constructor", "prototype"];

/**
 * Read the sampling fields of one `subagent.roles` entry: `thinkingLevel`, `sampling`, and
 * `samplingByThinkingLevel`. Never throws, and a bad key costs only itself.
 *
 * Values are not range-checked. pi forwards them as-is to a server whose contract this project does not own,
 * and an out-of-range value is a rejected request the child reports, which is a louder and more accurate
 * failure than a guess about what the endpoint accepts.
 */
export function parseRoleSampling(
	value: Record<string, unknown>,
	id: string,
	where: string,
	errors: string[],
): Pick<RoleConfig, "sampling" | "samplingByThinkingLevel" | "thinkingLevel"> {
	const out: Pick<RoleConfig, "sampling" | "samplingByThinkingLevel" | "thinkingLevel"> = {};
	const path = `subagent.roles.${id}`;
	if (value.thinkingLevel !== undefined) {
		const word = typeof value.thinkingLevel === "string" ? value.thinkingLevel.trim().toLowerCase() : undefined;
		if (word && isThinkingLevelWord(word)) out.thinkingLevel = word as ThinkingLevelWord;
		else errors.push(`${where}: ${path}.thinkingLevel must be one of ${THINKING_LEVEL_WORDS.join(", ")}, ignored`);
	}
	const sampling = parseSamplingBlock(value.sampling, `${where}: ${path}.sampling`, errors);
	if (sampling) out.sampling = sampling;
	if (value.samplingByThinkingLevel !== undefined) {
		if (!isRecord(value.samplingByThinkingLevel)) {
			errors.push(`${where}: ${path}.samplingByThinkingLevel must be an object keyed by thinking level, ignored`);
		} else {
			const byLevel: Partial<Record<ThinkingLevelWord, SamplingConfig>> = {};
			for (const [rawWord, block] of Object.entries(value.samplingByThinkingLevel)) {
				const word = rawWord.trim().toLowerCase();
				if (!isThinkingLevelWord(word)) {
					errors.push(`${where}: ${path}.samplingByThinkingLevel key "${rawWord}" is not a thinking level (${THINKING_LEVEL_WORDS.join(", ")}), ignored`);
					continue;
				}
				const levelBlock = parseSamplingBlock(block, `${where}: ${path}.samplingByThinkingLevel.${word}`, errors);
				if (!levelBlock) continue;
				byLevel[word as ThinkingLevelWord] = { ...byLevel[word as ThinkingLevelWord], ...levelBlock };
			}
			if (Object.keys(byLevel).length) out.samplingByThinkingLevel = byLevel;
		}
	}
	return out;
}

/**
 * One sampling block, or `undefined` when it says nothing usable. Only shapes that cannot survive the trip
 * to the server are refused: a non-object block, a key that is not a field name, a non-finite number.
 */
export function parseSamplingBlock(value: unknown, where: string, errors: string[]): SamplingConfig | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) {
		errors.push(`${where} must be an object of request-body params, ignored`);
		return undefined;
	}
	const out: SamplingConfig = {};
	for (const [rawKey, item] of Object.entries(value)) {
		const key = rawKey.trim();
		if (!SAMPLING_KEY_PATTERN.test(key) || FORBIDDEN_SAMPLING_KEYS.includes(key)) {
			errors.push(`${where} key "${rawKey}" is not a request-body field name, ignored`);
			continue;
		}
		if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
			errors.push(`${where}.${key} has no JSON value, ignored`);
			continue;
		}
		if (typeof item === "number" && !Number.isFinite(item)) {
			errors.push(`${where}.${key} must be a finite number, ignored`);
			continue;
		}
		out[key] = item as SamplingValue;
	}
	return Object.keys(out).length ? out : undefined;
}

/** Case- and separator-tolerant role lookup for config text (mirrors `pi-subagent/roles.ts`). */
function normalizeRoleWord(input: string): SubagentRoleName | undefined {
	const key = input.trim().toLowerCase().replace(/[\s_-]+/g, "");
	return SUBAGENT_ROLE_WORDS.find((name) => name.replace(/[\s_-]+/g, "") === key);
}

/** Parse the `subagent` section of one config file. Never throws. */
export function parseSubagentConfig(raw: unknown, where = "config"): ParsedSubagentConfig {
	const errors: string[] = [];
	const limits: Partial<SubagentLimits> = {};
	if (raw === undefined || raw === null) return { limits, errors };
	if (!isRecord(raw)) {
		errors.push(`${where}: "subagent" must be an object`);
		return { limits, errors };
	}
	for (const key of SUBAGENT_NUMBER_KEYS) {
		const value = raw[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			errors.push(`${where}: subagent.${key} must be a positive number, ignored`);
			continue;
		}
		limits[key] = Math.floor(value);
	}
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") limits.enabled = raw.enabled;
		else errors.push(`${where}: subagent.enabled must be a boolean, ignored`);
	}
	if (raw.model !== undefined) {
		const parsed = parseModelValue(raw.model);
		if (parsed.error) errors.push(`${where}: subagent.model ${parsed.error}, ignored`);
		else if (parsed.model !== undefined) limits.model = parsed.model;
	}
	if (raw.defaultRole !== undefined) {
		// A config-defined role name is legal here, so a bare `isRoleId` word is accepted and checked against
		// the effective table by the caller that has one (`pi-subagent/config-file.ts`).
		const name = typeof raw.defaultRole === "string" ? normalizeRoleWord(raw.defaultRole) : undefined;
		if (name) limits.defaultRole = name;
		else if (isRoleId(raw.defaultRole)) limits.defaultRole = raw.defaultRole.trim().toLowerCase();
		else errors.push(`${where}: subagent.defaultRole must name a role (${SUBAGENT_ROLE_WORDS.join(", ")}), ignored`);
	}
	const roles = parseRolesConfig(raw.roles, where, errors);
	if (roles) limits.roles = roles;
	if (raw.delegationPrompt !== undefined) {
		if (typeof raw.delegationPrompt === "boolean") limits.delegationPrompt = raw.delegationPrompt;
		else errors.push(`${where}: subagent.delegationPrompt must be a boolean, ignored`);
	}
	if (raw.askToExtend !== undefined) {
		if (typeof raw.askToExtend === "boolean") limits.askToExtend = raw.askToExtend;
		else errors.push(`${where}: subagent.askToExtend must be a boolean, ignored`);
	}
	return { limits, errors };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
