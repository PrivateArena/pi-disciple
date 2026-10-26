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
	directoryPattern,
	hasUnparsedExpansion,
	isExactRule,
	isExternalPath,
	isProtectedPath,
	isScopedRule,
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
	floor?: "protected_path" | "protected_read" | "wrapper" | "external_directory" | "degraded_config";
	/** How specifically the fact was decided — see {@link specificityOf}. */
	specificity: number;
}

/**
 * How specifically a rule talks about a fact. Two facts of one call can describe the *same thing*
 * (the `edit` tool's value for `src/a.ts` and the `path` fact for `src/a.ts`), and a rule about the
 * location is the more specific statement about it — that is what stops the tool-name wildcard
 * `permission["*"]`, which is only a default action for tools nobody configured, from overriding the
 * `path` rules that decide the workspace boundary.
 */
export const SPECIFICITY = {
	/** No rule: the surface's documented fallback (`path` allow, `external_directory` ask). */
	fallback: 0,
	/** `permission["*"]` — the tool-name wildcard, a default for unconfigured tools. */
	generic: 1,
	/** A named surface with a class-wide rule (`read: "allow"`), or a cross-cutting path default. */
	classWide: 2,
	/** A named surface with a concrete pattern (`path: "/secrets/*"`, `bash: "git *"`, any grant). */
	scoped: 3,
} as const;

export interface GrantOffer {
	surface: string;
	/**
	 * One pattern per command segment. A compound command (`a && b | c`) is evaluated per segment, so
	 * a grant has to be stored per segment too — a single chained pattern would match no segment and
	 * the allowance would silently do nothing.
	 */
	patterns: string[];
	/**
	 * Extra surfaces the same patterns get written to. A file outside the workspace is decided by the
	 * `external_directory` surface as well as by the tool's own, so a grant that only names the tool
	 * would leave the outside-path question open and ask again forever.
	 */
	alsoSurfaces?: string[];
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
 * then.
 *
 * It is absolute: while it is active no `tool_call` reaches the dialog — not a protected path, not
 * pi's own config, not a config file too broken to parse. That is the point: it is chosen by a human
 * who is about to walk away (an overnight run), and a switch that keeps asking is not a switch.
 * Floors stay as *labels* on a decision, so an audit log still says why a call looked unusual.
 *
 * Two things still hold, and neither can produce a dialog: a `deny` rule blocks (an explicit
 * instruction outranks a mode), and the mode is never inferable from config or from the model.
 */
export interface AllowAll {
	until: number | null;
}

/** Length of the "Allow everything for 5 minutes" window. */
export const ALLOW_ALL_WINDOW_MS = 5 * 60 * 1000;

/** Tools that only ever read, so a protected path behind them is a look, not a rewrite. */
export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

export function allowAllActive(allowAll: AllowAll | undefined, now: number): boolean {
	if (!allowAll) return false;
	return allowAll.until === null || now < allowAll.until;
}

export function resolveConfigPaths(cwd: string, trusted: boolean, agentDir: string = getAgentDir()): { globalFile: string; projectFile: string | null } {
	return { globalFile: getGlobalConfigFile(agentDir), projectFile: trusted ? getProjectConfigFile(cwd) : null };
}

// ---------------------------------------------------------------------------
// loading (mtime-cached: step 9 and `/gatec reload` see edits without a restart)
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
	if (surface === "path" || surface === "external_directory") return pathPatternMatches(pattern, value);
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

/** {@link matchRule} plus how specifically the winning rule talks about this value. */
function matchFact(surface: string, value: string, policy: Policy, isToolSurface: boolean, segments?: readonly string[]): { rule?: Rule; specificity: number } {
	const rule = matchRule(surface, value, policy, isToolSurface, segments);
	if (!rule) return { specificity: SPECIFICITY.fallback };
	if (rule.surface === "*") return { rule, specificity: SPECIFICITY.generic };
	return { rule, specificity: rule.pattern === "*" ? SPECIFICITY.classWide : SPECIFICITY.scoped };
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
	const readOnly = READ_ONLY_TOOLS.includes(facts.toolName);
	const checks: FactCheck[] = [];

	const push = (surface: string, value: string, fallback: Action | undefined, fallbackSpecificity: number = SPECIFICITY.fallback) => {
		const segments = shell && surface === facts.toolName ? shellValues : undefined;
		const matched = matchFact(surface, value, policy, surface === facts.toolName, segments);
		const rule = matched.rule;
		const resolved = rule?.action ?? fallback;
		if (resolved === undefined) return;
		let action = resolved;
		const specificity = rule ? matched.specificity : fallbackSpecificity;
		// Floors are facts about the call, not about whichever rule happened to speak last: an `ask` from
		// `external_directory: "ask"` is the same external access as a defaulted one, and labelling only the
		// latter made every floor of the shipped config invisible to "allow everything".
		const named = !!rule && isExactRule(rule, value);
		let floor: FactCheck["floor"];
		if (surface === "external_directory") floor = "external_directory";
		else if ((surface === "path" && isProtectedPath([value], policy.protectedGlobs)) || (surface !== "path" && protectedHit))
			floor = readOnly ? "protected_read" : "protected_path";
		else if (shell && surface === facts.toolName && !named && (isWrappedSegment(value, inPipeline) || hasUnparsedExpansion(value)))
			floor = "wrapper";
		else if (policy.degraded) floor = "degraded_config";
		// A floor escalates, never downgrades: `allow` on a guarded value is still an ask — unless the rule
		// that allowed it really speaks about this call (an exact command) or, for an outside path, about
		// this location (a concrete `…/*` grant). Without that exception no click could ever allow a file
		// outside the workspace, because the surface that asks is a class-wide one.
		if (floor && action === "allow" && !answersFloor(floor, rule, surface, value, named)) action = "ask";
		checks.push({ surface, value, action, rule, floor, specificity });
	};

	for (const [surface, values] of facts.surfaces) {
		for (const value of values) push(surface, value, policy.defaultAction);
	}
	for (const spelling of facts.paths) {
		// The cross-cutting surfaces are the gate's own statement about location, so their documented
		// defaults outrank the tool-name wildcard: that is what makes an in-workspace file operation pass
		// by default even in a config that only sets `permission["*"] = "ask"`.
		push("path", spelling, "allow", SPECIFICITY.classWide);
		if (isExternalPath([spelling], facts.cwd)) push("external_directory", spelling, "ask", SPECIFICITY.classWide);
	}

	// Facts that name the *same thing* — a file tool's value for `/x/a.ts` and the `path` fact for that
	// very spelling — are judged once, by the most specific rule about them. Facts that name different
	// things (every segment of a shell call, every path it touches) still combine most-restrictive.
	const { action, matched } = decide(checks, policy);
	return {
		action,
		facts,
		matched,
		checks,
		floors: [...new Set(checks.flatMap((check) => (check.floor ? [check.floor] : [])))],
		grant: offerGrant(facts),
	};
}

/** Can this rule answer this floor, or does the floor keep the call at `ask`? */
function answersFloor(floor: NonNullable<FactCheck["floor"]>, rule: Rule | undefined, surface: string, value: string, exact: boolean): boolean {
	if (!rule) return false;
	// A config too broken to trust is not answerable by any rule.
	if (floor === "degraded_config") return false;
	// An exact rule is the human naming this call. A scoped one (`/dir/*`, not `"*"`) is the human
	// naming this location — which is exactly what a folder grant for an outside path writes.
	if (floor === "external_directory") return exact || (rule.surface === surface && isScopedRule(rule));
	return exact;
}

/** The call's action, and the rule that decided it. */
function decide(checks: FactCheck[], policy: Policy): { action: Action; matched?: Rule } {
	const groups = new Map<string, FactCheck[]>();
	for (const check of checks) {
		const group = groups.get(check.value);
		if (group) group.push(check);
		else groups.set(check.value, [check]);
	}
	let action: Action = policy.defaultAction;
	let matched: Rule | undefined;
	let decided = false;
	for (const group of groups.values()) {
		const top = Math.max(...group.map((check) => check.specificity));
		const winners = group.filter((check) => check.specificity === top);
		// Within one value: the most restrictive of the most specific rules; ties resolve towards the
		// later (higher-precedence) scope, as they do inside a single surface.
		const winner = winners.reduce((best, check) => (severityOf(check.action) >= severityOf(best.action) ? check : best));
		if (!decided) {
			action = winner.action;
			matched = winner.rule;
			decided = true;
			continue;
		}
		if (severityOf(winner.action) > severityOf(action)) {
			action = winner.action;
			matched = winner.rule;
		} else if (severityOf(winner.action) === severityOf(action) && winner.rule) {
			matched = winner.rule;
		}
	}
	return decided ? { action, matched } : { action: policy.defaultAction };
}

function severityOf(action: Action): number {
	return action === "deny" ? 2 : action === "ask" ? 1 : 0;
}

/**
 * What the dialog offers to remember: one wildcard pattern per command segment, identical for every
 * scope. Persisted grants used to store the exact command while a session grant stored a wildcard, so
 * one click meant two different things — and an exact multi-argument command is useless as a rule.
 * `suggestBashPattern` keeps dangerous and wrapper segments exact, so the wildcard is not naive.
 *
 * For a file tool the offer is the **containing folder** (`/x/y/*`), not the one file: a human who
 * allowed one file in a directory means "stop asking me about that directory", which is how every
 * other harness scopes a sandbox grant. An outside path additionally lands on `external_directory`,
 * the surface that actually asked.
 */
export function offerGrant(facts: Facts): GrantOffer | undefined {
	const values = facts.surfaces.find(([surface]) => surface === facts.toolName)?.[1] ?? [];
	if (values.length === 0) return undefined;
	if (isShellTool(facts.toolName)) {
		const patterns = values.map((seg) => suggestBashPattern(seg));
		return { surface: facts.toolName, patterns, label: patterns.join(" && ") };
	}
	const spellings = new Set(facts.paths);
	const pathValued = values.every((value) => spellings.has(value));
	if (!pathValued) {
		const pattern = values[0]!;
		return { surface: facts.toolName, patterns: [pattern], label: pattern };
	}
	const patterns = [...new Set(values.map((value) => directoryPattern(value)))];
	const external = facts.paths.some((spelling) => isExternalPath([spelling], facts.cwd));
	return {
		surface: facts.toolName,
		patterns,
		label: patterns.join(" "),
		...(external ? { alsoSurfaces: ["external_directory"] } : {}),
	};
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
