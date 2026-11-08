/**
 * The `gate` section: `GateConfig`, its shipped default, and the tolerant parsers for `gate.permission`,
 * `gate.hardDeny` and `gate.grants` (plan step 2, split out of `schema.ts`).
 */

import { checkedPattern, readBoolean, readNumber, trimmed } from "./tolerant-parse.ts";
import {
	isAction,
	isDocKey,
	isRecord,
	type Action,
	type GrantRule,
	type HardDenyRule,
	type PermissionEntry,
} from "./action-vocabulary.ts";
import { DEFAULT_GUARD_CONFIG, parseGuardConfig, type GuardConfig } from "./guard-section.ts";

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
	 * `config.json` (repo root) and is **config-only** — the dialog never writes it, and neither does
	 * `grants.ts` — because a rule that blocks past "allow everything" has to be human-authored.
	 */
	hardDeny: [],
	guard: DEFAULT_GUARD_CONFIG,
};

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
	const enabled = readBoolean(doc, "enabled", `${where}: gate.enabled`, errors);
	if (enabled !== undefined) config.enabled = enabled;
	const reviewLog = readBoolean(doc, "reviewLog", `${where}: gate.reviewLog`, errors);
	if (reviewLog !== undefined) config.reviewLog = reviewLog;
	const promptTimeoutMs = readNumber(doc, "promptTimeoutMs", `${where}: gate.promptTimeoutMs`, 0, errors);
	if (promptTimeoutMs !== undefined) config.promptTimeoutMs = promptTimeoutMs;

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
						if (checkedPattern(pattern, `${where}: gate.permission.${surface}["${pattern}"]`, errors) === undefined) continue;
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
		if (checkedPattern(item.pattern, `${where}[${i}].pattern`, errors) === undefined) return;
		const reason = trimmed(item.reason);
		out.push({
			surface: trimmed(item.surface) ?? "*",
			pattern: item.pattern,
			...(reason !== undefined ? { reason } : {}),
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
		if (checkedPattern(item.pattern, `${where}[${i}].pattern`, errors) === undefined) return;
		out.push({ surface: item.surface, pattern: item.pattern, action: item.action });
	});
	return out;
}
