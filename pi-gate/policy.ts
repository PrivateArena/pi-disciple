/**
 * Policy loading and evaluation: the single source of truth for a call's action (plan step 5).
 *
 * Three separate rules, never conflated:
 *  1. **within one fact** — rules of all layers concatenate in precedence order
 *     `builtin → global.permission → project.permission → grants.global → grants.project →
 *     grants.session` and the last matching pattern wins;
 *  2. **within one question** ({@link Stage}) — facts that name the *same thing* are judged once, by the
 *     most specific rule about them, most restrictive among those;
 *  3. **across the questions of one call** — `command` (what it does) and `location` (where it goes) are
 *     decided separately and combined most-restrictive, `deny > ask > allow`, because each has its own
 *     grantable rule and its own dialog.
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

	normaliseCommand,
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
	 *
	 * Also the union across {@link surfacePatterns}, which is what the dialog labels show.
	 */
	patterns: string[];
	/**
	 * Extra surfaces the same patterns get written to. A file outside the workspace is decided by the
	 * `external_directory` surface as well as by the tool's own, so a grant that only names the tool
	 * would leave the outside-path question open and ask again forever.
	 */
	alsoSurfaces?: string[];
	/**
	 * Per-surface patterns, for an offer whose surfaces do not all want the same rule (a location
	 * offer writes a folder pattern on `external_directory` and only the exact command on the tool's
	 * own surface). Falls back to `patterns` for any surface not listed.
	 */
	surfacePatterns?: Record<string, string[]>;
	/** Single-line summary of `patterns`, for the dialog. */
	label: string;
}

/**
 * The two questions one call can raise, asked one dialog at a time.
 *
 * `command` is *what the call does* (its own surface: the shell segments, the tool name), `location`
 * is *where it touches* (`path`, `external_directory`). They are separate because the rules that
 * answer them are different shapes: `cat *` says nothing about a directory, and a directory rule says
 * nothing about `cat`. Merged into one dialog, the only offer available was the command rule — so a
 * shell call that touched a path outside the workspace could not be granted by any click, and asked
 * again on every retry.
 */
export type Stage = "command" | "location";

export interface StageDecision {
	stage: Stage;
	action: Action;
	matched?: Rule;
	checks: FactCheck[];
	floors: string[];
	/** A rule that closes *this* question, or `undefined` when nothing grantable can (a protected path). */
	grant?: GrantOffer;
	/** Short human name of the question, used in the dialog title. */
	heading: string;
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
	/** Every question this call raises, in the order they get asked. */
	stages: StageDecision[];
	/** Set on the per-stage view the dialog shows (see {@link stageView}); absent on the raw decision. */
	stage?: Stage;
	question?: { index: number; total: number };
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
	const callExact = exactCallRules(facts, policy, shell, shellValues);
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
		// A broken config is one question about the whole call, not one per fact: keeping it off the
		// location surfaces stops a degraded config from opening a second dialog for the same call.
		else if (policy.degraded && !isLocationSurface(surface)) floor = "degraded_config";
		// A floor escalates, never downgrades: `allow` on a guarded value is still an ask — unless the rule
		// that allowed it really speaks about this call (an exact command) or, for an outside path, about
		// this location (a concrete `…/*` grant). Without that exception no click could ever allow a file
		// outside the workspace, because the surface that asks is a class-wide one.
		if (floor && action === "allow" && !answersFloor(floor, rule, surface, value, named, callExact)) action = "ask";
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
	// That grouping happens *within* a stage, never across stages: what a command does and where it
	// goes are separate questions, each answered by its own rules and its own dialog (see {@link Stage}).
	const stages = buildStages(facts, policy, checks);
	const { action, matched } = decideCall(stages, policy);
	const asking = stages.filter((entry) => entry.action === "ask");
	return {
		action,
		facts,
		matched,
		checks,
		floors: floorsOf(checks),
		stages,
		// The rule a click would write: the first question that still needs answering, so the headless
		// "add this rule" hint names what is actually blocking the call.
		grant: (asking[0] ?? stages[0])?.grant,
	};
}

function floorsOf(checks: readonly FactCheck[]): string[] {
	return [...new Set(checks.flatMap((check) => (check.floor ? [check.floor] : [])))];
}

function buildStages(facts: Facts, policy: Policy, checks: FactCheck[]): StageDecision[] {
	const stages: StageDecision[] = [];
	// A file tool's own fact *is* the path, so its check and the `path` fact name the same thing and belong
	// to the same question — that is the "internal files pass by default" rule, and it is why the split is
	// by what a fact names, not by which surface it came from. Shell segments name a command, so they never
	// join a location group and the two questions really do separate there.
	const pathValues = new Set(facts.paths);
	const isLocationCheck = (check: FactCheck) => isLocationSurface(check.surface) || pathValues.has(check.value);
	const command = checks.filter((check) => !isLocationCheck(check));
	const location = checks.filter(isLocationCheck);
	if (command.length > 0) {
		stages.push({
			stage: "command",
			heading: facts.toolName,
			...decide(command, policy),
			checks: command,
			floors: floorsOf(command),
			grant: offerGrant(facts, policy),
		});
	}
	if (location.length > 0) {
		stages.push({
			stage: "location",
			heading: `location for ${facts.toolName}`,
			...decide(location, policy),
			checks: location,
			floors: floorsOf(location),
			grant: offerLocationGrant(facts, policy, location),
		});
	}
	return stages;
}

/** The call's action across its stages: most restrictive wins, `deny > ask > allow`.
 */
function decideCall(stages: StageDecision[], policy: Policy): { action: Action; matched?: Rule } {
	if (stages.length === 0) return { action: policy.defaultAction };
	let { action, matched } = stages[0]!;
	for (const stage of stages.slice(1)) {
		if (severityOf(stage.action) > severityOf(action)) ({ action, matched } = stage);
		else if (severityOf(stage.action) === severityOf(action) && stage.matched) matched = stage.matched;
	}
	return { action, matched };
}

/**
 * True when every fact on the tool's *own* surface is decided by a rule whose pattern *is* that fact:
 * the human named this exact command, this exact path. That is the strongest thing a grant can say, and
 * it is what lets a protected-path floor be closed by a rule that cannot be reused for anything else
 * (`bash: cat /x/gate/config.json 2>&1`) instead of by a cross-cutting `path` allow — which would open
 * the same file for writing, from a dialog the human answered to let one `cat` through.
 */
function exactCallRules(facts: Facts, policy: Policy, shell: boolean, shellValues: readonly string[]): boolean {
	const surfaces = facts.surfaces.filter(([surface]) => !isLocationSurface(surface));
	if (surfaces.length === 0) return false;
	let seen = 0;
	for (const [surface, values] of surfaces) {
		const segments = shell && surface === facts.toolName ? shellValues : undefined;
		for (const value of values) {
			const rule = matchRule(surface, value, policy, surface === facts.toolName, segments);
			if (!rule || !isExactRule(rule, value)) return false;
			seen++;
		}
	}
	return seen > 0;
}

/** Can this rule answer this floor, or does the floor keep the call at `ask`? */
function answersFloor(
	floor: NonNullable<FactCheck["floor"]>,
	rule: Rule | undefined,
	surface: string,
	value: string,
	exact: boolean,
	callExact: boolean,
): boolean {
	if (!rule) return false;
	// A config too broken to trust is not answerable by any rule.
	if (floor === "degraded_config") return false;
	// An exact rule is the human naming this call. A scoped one (`/dir/*`, not `"*"`) is the human
	// naming this location — which is exactly what a folder grant for an outside path writes. A coarse
	// `bash: cat *` never does either job: it says nothing about this directory.
	if (floor === "external_directory") return exact || (rule.surface === surface && isScopedRule(rule));
	// Protected paths: `exact` (a rule naming this very file) or a call whose own rules were all written
	// about this exact call, which is the shape of a grant made from a protected-path dialog.
	return exact || callExact;
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

/** The `path` and `external_directory` facts: the gate's statement about *where*, not *what*. */
export const LOCATION_SURFACES: readonly string[] = ["path", "external_directory"];

export function isLocationSurface(surface: string): boolean {
	return LOCATION_SURFACES.includes(surface);
}

/**
 * The rule the **command** question offers: one wildcard pattern per command segment, identical for every
 * scope. Persisted grants used to store the exact command while a session grant stored a wildcard, so
 * one click meant two different things — and an exact multi-argument command is useless as a rule.
 * `suggestBashPattern` keeps dangerous and wrapper segments exact, so the wildcard is not naive.
 *
 * This is the offer for a shell call (every command segment) and for a tool whose fact is not a path (an
 * MCP tool's argument rendering). A file tool's fact *is* a path, so that call raises only the location
 * question and {@link offerLocationGrant} is the one that speaks.
 *
 * A call that touches a **protected path** (the gate's own config, pi's settings, a git hook) is offered
 * as the *exact* command or the *exact* file instead: a wildcard there would let the agent rewrite the
 * rules that decide what runs, and a cross-cutting `path` allow would open the same file to every other
 * tool. Exact is also the only shape the protected floor accepts, so this is what makes such a call
 * grantable at all instead of something to abort or walk past.
 */
export function offerGrant(facts: Facts, policy?: Policy): GrantOffer | undefined {
	const values = facts.surfaces.find(([surface]) => surface === facts.toolName)?.[1] ?? [];
	if (values.length === 0) return undefined;
	const guarded = !!policy && facts.paths.some((spelling) => isProtectedPath([spelling], policy.protectedGlobs));
	if (isShellTool(facts.toolName)) {
		const patterns = [...new Set(values.map((seg) => (guarded ? normaliseCommand(seg) : suggestBashPattern(seg))))];
		return { surface: facts.toolName, patterns, label: patterns.join(" && ") };
	}
	const spellings = new Set(facts.paths);
	const pathValued = values.every((value) => spellings.has(value));
	if (!pathValued) {
		const pattern = values[0]!;
		return { surface: facts.toolName, patterns: [pattern], label: pattern };
	}
	const patterns = [...new Set(guarded ? values : values.map((value) => directoryPattern(value)))];
	const external = facts.paths.some((spelling) => isExternalPath([spelling], facts.cwd));
	return {
		surface: facts.toolName,
		patterns,
		label: patterns.join(" "),
		...(external ? { alsoSurfaces: ["external_directory"] } : {}),
	};
}

/**
 * The rule that closes the **location** question: the folder the asked-about path sits in, written on
 * every surface that is asking — the tool's own surface (a file tool's fact is the path), `path` for a
 * rule the human wrote themselves (`path: "/secrets/*": "ask"`), and `external_directory` for the
 * workspace boundary. The folder is the unit of the decision — a human who allowed one file in a
 * directory means "stop asking me about that directory" — which is what makes an outside directory
 * grantable in one click instead of file by file, forever.
 *
 * A **protected** path is the exception: there the offer is the exact file, never the folder, and never a
 * `path` rule at all — `path` and `external_directory` are cross-cutting, so a folder grant made while
 * approving one look would silently open every file that decides what runs, for every tool.
 */
export function offerLocationGrant(facts: Facts, policy: Policy, checks: readonly FactCheck[]): GrantOffer | undefined {
	const perSurface = new Map<string, string[]>();
	const add = (surface: string, pattern: string) => {
		const list = perSurface.get(surface) ?? [];
		if (!list.includes(pattern)) list.push(pattern);
		perSurface.set(surface, list);
	};
	for (const check of checks) {
		// Only what this stage is actually asking about, and never a `deny` (an explicit rule is edited in
		// the config file, not negotiated away by a dialog click).
		if (check.action !== "ask") continue;
		const guarded = isProtectedPath([check.value], policy.protectedGlobs);
		if (guarded && check.surface === "path") continue;
		add(check.surface, guarded ? check.value : directoryPattern(check.value));
	}
	if (perSurface.size === 0) return undefined;
	const surfaces = [...perSurface.keys()];
	// The tool's own surface leads when it is the one asking (a file tool), otherwise the boundary surface
	// that asked leads the label.
	const preferred = [facts.toolName, "external_directory", "path"];
	const primary = preferred.find((surface) => surfaces.includes(surface)) ?? surfaces[0]!;
	const rest = surfaces.filter((surface) => surface !== primary);
	const patterns = [...new Set(surfaces.flatMap((surface) => perSurface.get(surface)!))];
	return {
		surface: primary,
		patterns,
		...(rest.length > 0 ? { alsoSurfaces: rest } : {}),
		surfacePatterns: Object.fromEntries(surfaces.map((surface) => [surface, perSurface.get(surface)!])),
		label: patterns.join(" "),
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
