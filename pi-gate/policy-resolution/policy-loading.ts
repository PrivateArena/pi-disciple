/**
 * Reading the config files and assembling one layered `Policy`: defaults, global file, project file and
 * persisted grants, inside the mtime cache that lets `/gatec reload` see an edit without a restart
 * (plan steps 6 and 9, split out of `policy.ts`).
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Action, type GrantRule, type HardDenyRule, type PermissionEntry, SCOPE_PRECEDENCE, type Scope, isAction } from "../config-contract/action-vocabulary.ts";
import { DEFAULT_GATE_CONFIG, type GateConfig, type PartialGateConfig, flattenPermission, parseGateConfig } from "../config-contract/gate-section.ts";
import { type GuardConfig, mergeGuardConfigs } from "../config-contract/guard-section.ts";
import { configFileMtime, getGlobalConfigFile, getProjectConfigFile, isMissingFileRead, readConfigFile } from "../config-file.ts";
import { protectedPathGlobs } from "../pattern/protected-locations.ts";
import { type Policy, type Rule, isLocationSurface, isNetworkSurface } from "./call-decision.ts";

export function resolveConfigPaths(cwd: string, trusted: boolean, agentDir: string = getAgentDir()): { globalFile: string; projectFile: string | null } {
	return { globalFile: getGlobalConfigFile(agentDir), projectFile: trusted ? getProjectConfigFile(cwd) : null };
}

const cache = new Map<string, { stamp: string; policy: Policy }>();

export function clearPolicyCache(): void {
	cache.clear();
}

export function loadPolicy(cwd: string, trusted: boolean, agentDir: string): Policy {
	const { globalFile, projectFile } = resolveConfigPaths(cwd, trusted, agentDir);
	const stamp = [globalFile, projectFile]
		.filter((file): file is string => !!file)
		.map((file) => `${file}=${configFileMtime(file)}`)
		.join("|");
	const key = `${cwd}\u0000${trusted}\u0000${agentDir}`;
	const hit = cache.get(key);
	if (hit && hit.stamp === stamp) return hit.policy;
	const policy = buildPolicy({ cwd, trusted, agentDir, globalFile, projectFile });
	cache.set(key, { stamp, policy });
	return policy;
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
	/** Surfaces a config file named, so the defaulted-in ones below do not duplicate or outrank them. */
	const configuredSurfaces = new Set<string>();
	const hardDeny: HardDenyRule[] = [];
	/**
	 * One `gate.guard` block per file that had one, lowest precedence first. Folded by
	 * {@link mergeGuardConfigs}: scalars are last-file-wins like every other gate key, the rule lists are
	 * concatenated, because an extra detector is an addition and not a rival.
	 */
	const guardFiles: Partial<GuardConfig>[] = [];
	let degraded = false;
	let globalConfig: PartialGateConfig = {};

	const absorb = (file: string, scope: "global" | "project") => {
		const read = readConfigFile(file);
		if (read.json === undefined) {
			if (read.error && !isMissingFileRead(read)) {
				errors.push(read.error);
				degraded = true;
			}
			return;
		}
		files.push(file);
		if (read.error) errors.push(read.error);
		const parsed = parseGateConfig(read.json, file);
		errors.push(...parsed.errors);
		for (const entry of parsed.entries) configuredSurfaces.add(entry.surface);
		rules.push(...parsed.entries.map(toRule(scope === "global" ? "global" : "project")));
		if (scope === "global") globalConfig = { ...globalConfig, ...parsed.config };
		rules.push(...parsed.grants.global.map(toRule("grants.global")));
		// hardDeny is not a precedence layer, so it is *concatenated*, never ordered: an entry in either
		// file blocks, and a project file may add to it but never remove a global one (plan step C2).
		hardDeny.push(...parsed.hardDeny);
		if (parsed.config.guard) guardFiles.push(parsed.config.guard);
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
	//
	// With a permission map present, the built-in layer is *not* replayed: deviation 7 says the file owns
	// that layer, and a built-in `bash: "ask"` sitting next to the human's `bash: "deny"` would un-hide a
	// tool they meant to remove. What it does get instead is one fallback rule per surface it named without
	// a class-wide rule — see {@link fallbackRulesFor}. Pushed first, so `orderRules` keeps every file layer
	// and every grant scope above it.
	const builtinRules = globalConfig.permission === undefined
		? flattenPermission(DEFAULT_GATE_CONFIG.permission).map(toRule("builtin"))
		: fallbackRulesFor(permission, configuredSurfaces);
	// A hardDeny whose `surface` names nothing is a dead rule that *looks* live — the one failure mode a
	// mode-proof deny must not have. The surface may legitimately be any tool name, so this can only be a
	// warning rather than a rejection: naming it is what makes a typo visible in `/gatec status` instead of
	// invisible in the one call it was written to stop.
	for (const rule of hardDeny) {
		const surface = rule.surface ?? "*";
		if (surface === "*" || isLocationSurface(surface) || isNetworkSurface(surface) || surface in permission) continue;
		errors.push(`gate.hardDeny names surface "${surface}", which no rule or known surface uses — it blocks nothing unless a tool is called exactly that`);
	}

	return {
		rules: orderRules([...builtinRules, ...rules]),
		files,
		errors,
		invalidScopes,
		hardDeny,
		config: {
			enabled: globalConfig.enabled ?? DEFAULT_GATE_CONFIG.enabled,
			reviewLog: globalConfig.reviewLog ?? DEFAULT_GATE_CONFIG.reviewLog,
			promptTimeoutMs: globalConfig.promptTimeoutMs ?? DEFAULT_GATE_CONFIG.promptTimeoutMs,
			permission,
			// The parsed entries, not `globalConfig.hardDeny`: a project file may add one (it is only ever
			// read when the cwd is trusted), and the effective list is what `/gatec status` has to show.
			hardDeny,
			guard: mergeGuardConfigs(guardFiles),
		},
		defaultAction,
		degraded,
		cwd: o.cwd,
		trusted: o.trusted,
		agentDir: o.agentDir,
		protectedGlobs: protectedPathGlobs(o.cwd, o.agentDir),
		configuredSurfaces,
	};
}

/** The `"*"` action of a `{ pattern: action }` permission value, when it has one. */
export function classWideAction(value: unknown): Action | undefined {
	if (isAction(value)) return value;
	if (!value || typeof value !== "object") return undefined;
	const star = (value as Record<string, unknown>)["*"];
	return isAction(star) ? star : undefined;
}

/**
 * One class-wide fallback rule per surface the config names but leaves without a `"*"` rule of its own.
 *
 * A fact no rule matches falls through to `permission["*"]`, which is a *tool-name* default — so a config
 * whose whole map is `{"*": "allow"}` would decide a cross-cutting surface the file never spoke about, and
 * the same config would decide it in the other direction if it said `"*": "ask"`. Giving each named surface
 * its own fallback makes the surface's documented default win, and keeps it a *class-wide* rule so a
 * concrete pattern the human wrote (`path: "*.env": "deny"`) still out-ranks it.
 *
 * Only surfaces the file actually named get one: a surface it never mentioned is not this config's to
 * decide, and replaying the built-in map wholesale would let a built-in `bash: "ask"` coexist with the
 * human's `bash: "deny"` and un-hide a tool they meant to remove.
 */
function fallbackRulesFor(permission: GateConfig["permission"], named: ReadonlySet<string>): Rule[] {
	const out: Rule[] = [];
	for (const surface of named) {
		const value = (permission as Record<string, unknown>)[surface];
		if (isAction(value)) continue; // `"read": "allow"` already IS the class-wide rule
		if (!value || typeof value !== "object") continue;
		const star = (value as Record<string, unknown>)["*"];
		if (isAction(star)) continue; // the map already states its own default
		const documented = (DEFAULT_GATE_CONFIG.permission as Record<string, unknown>)[surface];
		const action = isAction(documented) ? documented : undefined;
		if (action === undefined) continue;
		out.push({ surface, pattern: "*", action, scope: "builtin", origin: "policy" });
	}
	return out;
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
