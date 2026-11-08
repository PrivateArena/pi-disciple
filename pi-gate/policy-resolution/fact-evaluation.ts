/**
 * Evaluation: the facts of a call against a policy, the per-fact checks, the stages they fold into, the
 * floors that make an answer stick, and the action that comes back (plan step 7, split out of `policy.ts`).
 */

import { type Action } from "../config-contract/action-vocabulary.ts";
import { DEFAULT_GATE_CONFIG } from "../config-contract/gate-section.ts";
import { beginRegexRound } from "../pattern/regex-dialect.ts";
import { isExactRule, isScopedRule } from "../pattern/rule-shape.ts";
import { isExternalPath, isProtectedPath } from "../pattern/protected-locations.ts";
import { hasUnparsedExpansion } from "../pattern/shell-segmentation.ts";
import { isWrappedSegment } from "../pattern/shell-commands.ts";
import { type Facts, extract, isShellTool } from "../inspect.ts";
import { NETWORK_SURFACE } from "../network.ts";
import { type Decision, type FactCheck, type Policy, type Rule, type StageDecision, SPECIFICITY, isLocationSurface, isNetworkSurface } from "./call-decision.ts";
import { classWideAction } from "./policy-loading.ts";
import { matchFact, matchRule } from "./surface-matching.ts";
import { offerGrant, offerLocationGrant, offerNetworkGrant } from "./grant-offers.ts";

/** Tools that only ever read, so a protected path behind them is a look, not a rewrite. */
export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

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

export function evaluate(facts: Facts, policy: Policy): Decision {
	// One wall-clock budget per `re:` rule per call, so a slow pattern cannot mark itself dead for the rest
	// of the session (see `pattern/regex-dialect.ts::beginRegexRound`).
	beginRegexRound();
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
		// Egress is a floor for the same reason a directory is one: a coarse `bash: curl *` says nothing about
		// *which* host, exactly as it says nothing about which directory (plan step B3).
		//
		// It is raised **unconditionally** — a host is a fact about the call, not about whichever rule happened
		// to be silent (the project's own floor axiom). What the shipped `allow` default must not do is
		// *escalate*: so the floor is answered by the surface's own class-wide default, and only by that. Any
		// other allow — a `curl *` grant, a `"*": "allow"` shortcut — leaves the escalation in force, which is
		// how "stop asking me about this command" cannot silently become "never ask about a host again".
		else if (surface === NETWORK_SURFACE) floor = "network_egress";
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
		if (floor && action === "allow" && !answersFloor(floor, rule, surface, value, named, callExact, specificity === SPECIFICITY.classWide && !rule)) action = "ask";
		checks.push({ surface, value, action, rule, floor, specificity });
	};

	for (const [surface, values] of facts.surfaces) {
		for (const value of values) push(surface, value, policy.defaultAction);
	}
	// A surface no rule at all speaks about takes its documented default, not `permission["*"]`: that is a
	// tool-name default, and an egress fact is not a tool. This is the case of a config naming neither
	// `network` nor anything else about egress — the common one, since the surface is new.
	const networkFallback: Action | undefined = policy.config.permission.network === undefined
		? classWideAction(DEFAULT_GATE_CONFIG.permission.network)
		: undefined;
	for (const host of facts.surfaces.find(([surface]) => surface === NETWORK_SURFACE)?.[1] ?? []) {
		push(NETWORK_SURFACE, host, networkFallback, SPECIFICITY.classWide);
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
	// things (every segment of a shell call, every path it touches, every host it reaches) still combine
	// most-restrictive. That grouping happens *within* a stage, never across stages: what a command does,
	// where it goes and who it talks to are separate questions, each with its own rules and its own
	// dialog (see {@link Stage}).
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
	// A host is not a path spelling, so a network check can never be swallowed by the location question;
	// the explicit test says so, because "a URL is a path" was exactly the conflation step D removes.
	const isLocationCheck = (check: FactCheck) => !isNetworkSurface(check.surface) && (isLocationSurface(check.surface) || pathValues.has(check.value));
	const isNetworkCheck = (check: FactCheck) => isNetworkSurface(check.surface);
	const command = checks.filter((check) => !isLocationCheck(check) && !isNetworkCheck(check));
	const location = checks.filter(isLocationCheck);
	const network = checks.filter(isNetworkCheck);
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
	if (network.length > 0) {
		stages.push({
			stage: "network",
			heading: `network for ${facts.toolName}`,
			...decide(network, policy),
			checks: network,
			floors: floorsOf(network),
			grant: offerNetworkGrant(facts, policy, network),
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
	/** True when the `allow` came from no rule at all — the surface's own documented default. */
	fromSurfaceDefault: boolean,
): boolean {
	// Egress is the one floor a *default* may answer: the surface ships as `allow`, and a config that never
	// mentions hosts must not prompt for them. Nothing else can — not `"*": "allow"`, not `curl *`. And a
	// config that **does** name the surface has opted in, so its own class-wide rule (`network: "*": "ask"`,
	// or a `{ "github.com": "allow" }` map with no `"*"`) is a decision about hosts and answers it too;
	// without that, a domain allowlist would still prompt for every host it allows.
	if (floor === "network_egress") {
		if (fromSurfaceDefault || !rule) return fromSurfaceDefault;
		if (exact || surface !== NETWORK_SURFACE) return exact || (rule.surface === surface && isScopedRule(rule));
		return rule.pattern === "*" || isScopedRule(rule);
	}
	if (!rule) return false;
	// A config too broken to trust is not answerable by any rule.
	if (floor === "degraded_config") return false;
	// An exact rule is the human naming this call. A scoped one (`/dir/*`, `aliyuncs.com`, not `"*"`) is
	// the human naming this location or this domain — which is exactly what a folder grant and a
	// host-typed rule say. A coarse `bash: curl *` never does either job: it says nothing about this
	// directory, and nothing about this host.
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

export function severityOf(action: Action): number {
	return action === "deny" ? 2 : action === "ask" ? 1 : 0;
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
