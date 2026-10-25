/**
 * Policy loading and evaluation: the single source of truth for a call's action (plan step 5).
 *
 * Two separate rules, never conflated:
 *  1. **within one fact** — rules of all layers concatenate in precedence order
 *     `builtin → global.permission → project.permission → grants.global → grants.project →
 *     grants.session` and the last matching pattern wins;
 *  2. **across the facts of one call** — most restrictive wins, `deny > ask > allow`.
 * Floors are applied per fact after rule matching and can only ever escalate.
 */

import { existsSync, statSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type Action,
	type GateConfig,
	DEFAULT_GATE_CONFIG,
	type GrantRule,
	SCOPE_PRECEDENCE,
	type Scope,
	flattenPermission,
	isAction,
	mostRestrictive,
	parseGateConfig,
	type PermissionEntry,
} from "./schema.ts";
import { getGlobalConfigFile, getProjectConfigFile, readConfigFile } from "./config-file.ts";
import {
	compoundPatternParts,
	hasUnparsedExpansion,
	isExternalPath,
	isProtectedPath,
	matchesSegmentPattern,
	pathPatternMatches,
	protectedPathGlobs,
	suggestBashPattern,
	wildcardMatch,
	isWrappedSegment,
} from "./match.ts";
import { extract, isShellTool, type Facts } from "./inspect.ts";

export type { GrantRule };

export interface Rule extends PermissionEntry {
	scope: Scope;
	origin: "policy" | "grant";
}

export interface Policy {
	rules: Rule[];
	files: string[];
	errors: string[];
	invalidScopes: Scope[];
	config: GateConfig;
	/** `permission["*"]` when it is an action, else `ask` (least privilege). */
	defaultAction: Action;
	/** A config file could not be parsed: every `allow` escalates to `ask` (FM-9). */
	degraded: boolean;
	cwd: string;
	trusted: boolean;
	agentDir: string;
	protectedGlobs: string[];
}

export interface FactCheck {
	surface: string;
	value: string;
	action: Action;
	rule?: Rule;
	floor?: "protected_path" | "wrapper" | "external_directory" | "degraded_config";
}

export interface GrantOffer {
	surface: string;
	/**
	 * One pattern per command segment. A compound command (`a && b | c`) is evaluated per segment, so
	 * a grant has to be stored per segment too — a single chained pattern would match no segment and
	 * the allowance would silently do nothing.
	 */
	patterns: string[];
	/** Single-line summary of `patterns`, for the dialog. */
	label: string;
}

export interface Decision {
	action: Action;
	facts: Facts;
	/** The rule that produced the final action, when a rule did. */
	matched?: Rule;
	/** Set when the call is blocked: model-facing text. */
	reason?: string;
	/** What any "Allow <scope>" choice remembers — one shape for session, project and global. */
	grant?: GrantOffer;
	floors: string[];
	checks: FactCheck[];
}

/**
 * "Allow everything" mode. `until === null` runs until the session ends; a timestamp closes the window
 * then. It silences routine approvals only — {@link SAFETY_FLOORS} still ask.
 */
export interface AllowAll {
	until: number | null;
}

/** Length of the "Allow everything for 5 minutes" window. */
export const ALLOW_ALL_WINDOW_MS = 5 * 60 * 1000;

/**
 * The floors that survive "allow everything": protected paths (incl. `.env`, keys, `.git`, `~/.pi`),
 * files outside the workspace, hidden arguments inside wrappers, and a broken config file. Skipping
 * these would turn one click into a blanket permission over the whole security model.
 */
export const SAFETY_FLOORS: readonly string[] = ["protected_path", "external_directory", "wrapper", "degraded_config"];

export function allowAllActive(allowAll: AllowAll | undefined, now: number): boolean {
	if (!allowAll) return false;
	return allowAll.until === null || now < allowAll.until;
}

/**
 * True when an `ask` rests on nothing but routine rules, so "allow everything" may silence it. One hard
 * floor anywhere — protected path, external directory, hidden arguments, broken config — keeps the dialog.
 */
export function noSafetyFloor(decision: Decision): boolean {
	return decision.floors.every((floor) => !SAFETY_FLOORS.includes(floor));
}

export function resolveConfigPaths(cwd: string, trusted: boolean, agentDir: string = getAgentDir()): { globalFile: string; projectFile: string | null } {
	return { globalFile: getGlobalConfigFile(agentDir), projectFile: trusted ? getProjectConfigFile(cwd) : null };
}

// ---------------------------------------------------------------------------
// loading (mtime-cached: step 9 and `/gate reload` see edits without a restart)
// ---------------------------------------------------------------------------

const cache = new Map<string, { stamp: string; policy: Policy }>();

export function clearPolicyCache(): void {
	cache.clear();
}

export function loadPolicy(cwd: string, trusted: boolean, agentDir: string): Policy {
	const { globalFile, projectFile } = resolveConfigPaths(cwd, trusted, agentDir);
	const stamp = [globalFile, projectFile]
		.filter((file): file is string => !!file)
		.map((file) => `${file}=${mtimeOf(file)}`)
		.join("|");
	const key = `${cwd}\u0000${trusted}\u0000${agentDir}`;
	const hit = cache.get(key);
	if (hit && hit.stamp === stamp) return hit.policy;
	const policy = buildPolicy({ cwd, trusted, agentDir, globalFile, projectFile });
	cache.set(key, { stamp, policy });
	return policy;
}

function mtimeOf(file: string): number {
	try {
		return existsSync(file) ? statSync(file).mtimeMs : 0;
	} catch {
		return 0;
	}
}

function buildPolicy(o: {
	cwd: string;
	trusted: boolean;
	agentDir: string;
	globalFile: string;
	projectFile: string | null;
}): Policy {
	const errors: string[] = [];
	const invalidScopes: Scope[] = [];
	const files: string[] = [];
	const rules: Rule[] = [];
	let degraded = false;
	let globalConfig: Partial<GateConfig> = {};

	const absorb = (file: string, scope: "global" | "project") => {
		const read = readConfigFile(file);
		if (read.json === undefined) {
			if (read.error && !read.error.includes("does not exist")) {
				errors.push(read.error);
				degraded = true;
			}
			return;
		}
		files.push(file);
		if (read.error) errors.push(read.error);
		const parsed = parseGateConfig(read.json, file);
		errors.push(...parsed.errors);
		rules.push(...parsed.entries.map(toRule(scope === "global" ? "global" : "project")));
		if (scope === "global") globalConfig = { ...globalConfig, ...parsed.config };
		rules.push(...parsed.grants.global.map(toRule("grants.global")));
		if (parsed.grants.project.length) {
			if (scope === "global") {
				invalidScopes.push("grants.project");
				errors.push(`${file}: gate.grants.project is only read from a project config, ignored`);
			} else {
				rules.push(...parsed.grants.project.map(toRule("grants.project")));
			}
		}
		if (scope === "project" && parsed.config.enabled === false) {
			errors.push(`${file}: gate.enabled=false is ignored in a project config (only the global file may disable the gate)`);
		}
	};

	absorb(o.globalFile, "global");
	if (o.projectFile) absorb(o.projectFile, "project");

	const permission = globalConfig.permission ?? DEFAULT_GATE_CONFIG.permission;
	const defaultAction = isAction(permission["*"]) ? (permission["*"] as Action) : "ask";
	// The built-in defaults are a real rule layer, not display text: without it a machine with no config
	// file — or one that omits `permission` — would ask for every call, including the reads and
	// in-workspace edits the shipped defaults allow. Only when no file supplies a permission map.
	const builtinRules = globalConfig.permission === undefined ? flattenPermission(DEFAULT_GATE_CONFIG.permission).map(toRule("builtin")) : [];

	return {
		rules: orderRules([...builtinRules, ...rules]),
		files,
		errors,
		invalidScopes,
		config: {
			enabled: globalConfig.enabled ?? DEFAULT_GATE_CONFIG.enabled,
			reviewLog: globalConfig.reviewLog ?? DEFAULT_GATE_CONFIG.reviewLog,
			promptTimeoutMs: globalConfig.promptTimeoutMs ?? DEFAULT_GATE_CONFIG.promptTimeoutMs,
			permission,
		},
		defaultAction,
		degraded,
		cwd: o.cwd,
		trusted: o.trusted,
		agentDir: o.agentDir,
		protectedGlobs: protectedPathGlobs(o.cwd, o.agentDir),
	};
}

function toRule(scope: Scope) {
	return (entry: PermissionEntry): Rule => ({
		...entry,
		scope,
		origin: scope.startsWith("grants.") ? "grant" : "policy",
	});
}

/** Precedence order: earlier scopes first, so "last match wins" resolves towards the human. */
function orderRules(rules: Rule[]): Rule[] {
	return [...rules].sort((a, b) => SCOPE_PRECEDENCE.indexOf(a.scope) - SCOPE_PRECEDENCE.indexOf(b.scope));
}

/** Session grants sit on top of everything, in memory only (step 9). */
export function withSessionGrants(policy: Policy, grants: readonly GrantRule[]): Policy {
	if (grants.length === 0) return policy;
	return { ...policy, rules: [...policy.rules, ...grants.map(toRule("grants.session"))] };
}

// ---------------------------------------------------------------------------
// rule matching
// ---------------------------------------------------------------------------

function patternMatches(surface: string, pattern: string, value: string, segments?: readonly string[]): boolean {
	if (pattern === "*") return true;
	// A chained pattern (only ever offered for shell surfaces) describes the whole call, not one part.
	if (segments) {
		const parts = compoundPatternParts(pattern);
		if (parts) return matchesSegmentPattern(parts, segments);
	}
	if (surface === "path") return pathPatternMatches(pattern, value);
	return wildcardMatch(pattern, value);
}

/**
 * The last rule matching one fact, with the named surface taking precedence over the `"*"`
 * tool-name wildcard (`permission["*"]` is the default for *all* surfaces, not a more specific rule).
 */
function matchRule(surface: string, value: string, policy: Policy, isToolSurface: boolean, segments?: readonly string[]): Rule | undefined {
	let named: Rule | undefined;
	let generic: Rule | undefined;
	for (const rule of policy.rules) {
		if (!patternMatches(surface, rule.pattern, value, segments)) continue;
		if (rule.surface === surface) named = rule;
		// permission["*"] is the tool-name wildcard: it must not silence `path` / `external_directory`.
		else if (rule.surface === "*" && isToolSurface) generic = rule;
	}
	return named ?? generic;
}

/** A tool is hidden from the model only when every rule for it denies it. */
export function isFullyDenied(toolName: string, policy: Policy): boolean {
	const scoped = policy.rules.filter((rule) => rule.surface === toolName);
	const generic = policy.rules.filter((rule) => rule.surface === "*");
	if (scoped.length === 0) {
		if (generic.length === 0) return policy.defaultAction === "deny";
		return generic.every((rule) => rule.action === "deny");
	}
	return scoped.every((rule) => rule.action === "deny");
}

/** Tools to hide before the agent starts. */
export function hiddenTools(toolNames: readonly string[], policy: Policy): string[] {
	return toolNames.filter((name) => isFullyDenied(name, policy));
}

export function recomputeActive(toolNames: readonly string[], policy: Policy): string[] {
	const hidden = new Set(hiddenTools(toolNames, policy));
	return toolNames.filter((name) => !hidden.has(name));
}

// ---------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------

export function evaluate(facts: Facts, policy: Policy): Decision {
	const shell = isShellTool(facts.toolName);
	const shellValues = facts.surfaces.find(([surface]) => surface === facts.toolName)?.[1] ?? [];
	const inPipeline = shell && shellValues.length > 1;
	const protectedHit = isProtectedPath(facts.paths, policy.protectedGlobs);
	const checks: FactCheck[] = [];

	const push = (surface: string, value: string, fallback: Action | undefined, escalation?: FactCheck["floor"]) => {
		const segments = shell && surface === facts.toolName ? shellValues : undefined;
		const rule = matchRule(surface, value, policy, surface === facts.toolName, segments);
		let action = rule?.action ?? fallback;
		if (action === undefined) return;
		let floor: FactCheck["floor"];
		if (escalation && rule === undefined && action === "ask") {
			// The floor *is* the reason for the ask — no rule of the human's said anything about this value.
			floor = escalation;
		} else if (action === "allow") {
			if ((surface === "path" && isProtectedPath([value], policy.protectedGlobs)) || (surface !== "path" && protectedHit)) {
				action = "ask";
				floor = "protected_path";
			} else if (shell && surface === facts.toolName && (isWrappedSegment(value, inPipeline) || hasUnparsedExpansion(value))) {
				action = "ask";
				floor = "wrapper";
			} else if (policy.degraded) {
				action = "ask";
				floor = "degraded_config";
			}
		}
		checks.push({ surface, value, action, rule, floor });
	};

	for (const [surface, values] of facts.surfaces) {
		for (const value of values) push(surface, value, policy.defaultAction);
	}
	for (const spelling of facts.paths) {
		push("path", spelling, "allow");
		if (isExternalPath([spelling], facts.cwd)) push("external_directory", spelling, "ask", "external_directory");
	}

	let action: Action = "allow";
	let decided = false;
	for (const check of checks) {
		if (!decided || severityOf(check.action) > severityOf(action)) {
			action = check.action;
			decided = true;
		}
	}
	if (!decided) action = policy.defaultAction;
	if (checks.length === 0) action = policy.defaultAction;

	const matched = [...checks].reverse().find((check) => check.action === action)?.rule;
	return {
		action,
		facts,
		matched,
		checks,
		floors: [...new Set(checks.flatMap((check) => (check.floor ? [check.floor] : [])))],
		grant: offerGrant(facts),
	};
}

function severityOf(action: Action): number {
	return action === "deny" ? 2 : action === "ask" ? 1 : 0;
}

/**
 * What the dialog offers to remember: one wildcard pattern per command segment, identical for every
 * scope. Persisted grants used to store the exact command while a session grant stored a wildcard, so
 * one click meant two different things — and an exact multi-argument command is useless as a rule.
 * `suggestBashPattern` keeps dangerous and wrapper segments exact, so the wildcard is not naive.
 */
export function offerGrant(facts: Facts): GrantOffer | undefined {
	const values = facts.surfaces.find(([surface]) => surface === facts.toolName)?.[1] ?? [];
	if (values.length === 0) return undefined;
	const shell = isShellTool(facts.toolName);
	const patterns = shell ? values.map((seg) => suggestBashPattern(seg)) : [values[0]!];
	return { surface: facts.toolName, patterns, label: patterns.join(shell ? " && " : "") };
}

/** Model-facing text for a blocked call, naming the fix (FM-12). */
export function blockReason(decision: Decision, kind: "policy_deny" | "user_abort" | "no_ui", instruction?: string): string {
	const { facts, matched, grant } = decision;
	if (kind === "user_abort") {
		return instruction
			? `[gate] Blocked by the user. Follow this instruction verbatim and do not retry the blocked call: ${instruction}`
			: `[gate] Blocked by the user: ${facts.preview}. Do not retry it; choose another approach or ask.`;
	}
	const fixPatterns = [...new Set(grant?.patterns ?? ["*"])];
	const fix = fixPatterns.map((pattern) => `"${pattern}": "allow"`).join(", ");
	if (kind === "no_ui") {
		return (
			`[gate] Blocked: ${facts.toolName} "${facts.preview}" needs approval and this session has no UI. ` +
			`Add {${fix}} to the "${facts.toolName}" section of ${getGlobalConfigFile()}, or run pi interactively.`
		);
	}
	return (
		`[gate] Denied by policy${matched ? `: ${matched.surface} "${matched.pattern}" = deny (${matched.scope})` : ""}. ` +
		`Do not retry ${facts.preview}. This rule cannot be approved interactively.`
	);
}

/** Convenience wrapper used by the extension entry point and by tests. */
export function evaluateCall(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	call: { callId: string; parentCallId?: string },
	policy: Policy,
): Decision {
	return evaluate(extract(toolName, input, cwd, call), policy);
}

export { mostRestrictive, severityOf as severity };
