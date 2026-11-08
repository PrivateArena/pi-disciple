/**
 * What a dialog click actually writes: the grant rule each question offers and the patterns it covers
 * (plan steps 7 and 9, split out of `policy.ts`).
 */

import { directoryPattern } from "../pattern/path-spellings.ts";
import { isExternalPath, isProtectedPath } from "../pattern/protected-locations.ts";
import { normaliseCommand, suggestBashPattern } from "../pattern/shell-commands.ts";
import { type Facts, isShellTool } from "../inspect.ts";
import { NETWORK_SURFACE, isMetadataEndpoint } from "../network.ts";
import { type FactCheck, type GrantOffer, type Policy } from "./call-decision.ts";
import { pushUnique } from "../ordered-unique.ts";

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
		pushUnique(list, pattern);
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

/**
 * The rule that closes the **network** question (plan step B3): one host pattern per asked-about host,
 * written on the surface that asked.
 *
 * Kept minimal on purpose. It is *not* also written on `bash`: a rule like `bash: "curl https://host/*"`
 * is a command-shaped string that matches one spelling of one URL and nothing else, so it would widen
 * the click (any argument of that command form) while failing to cover the next host the same command
 * fetches. The host is the decision, so the host is the rule — and `alsoSurfaces` names the tool's own
 * surface only when that surface is itself the one asking (an unknown tool whose fact is the URL).
 *
 * A metadata endpoint is called out in the label: that host answers with credentials, and a human should
 * see the word before they click "allow for all projects".
 */
export function offerNetworkGrant(facts: Facts, policy: Policy, checks: readonly FactCheck[]): GrantOffer | undefined {
	void policy;
	const hosts: string[] = [];
	for (const check of checks) {
		// Only what this stage is actually asking about, and never a `deny` — an explicit rule is edited in
		// the config file, not negotiated away by a dialog click.
		if (check.action !== "ask") continue;
		pushUnique(hosts, check.value);
	}
	if (hosts.length === 0) return undefined;
	const asking = new Set(checks.filter((check) => check.action === "ask").map((check) => check.surface));
	const also = asking.has(facts.toolName) && facts.toolName !== NETWORK_SURFACE ? [facts.toolName] : [];
	const metadata = hosts.filter((host) => isMetadataEndpoint(host));
	return {
		surface: NETWORK_SURFACE,
		patterns: hosts,
		...(also.length > 0 ? { alsoSurfaces: also } : {}),
		surfacePatterns: { [NETWORK_SURFACE]: hosts },
		label: `${hosts.join(" ")}${metadata.length ? ` (metadata endpoint: ${metadata.join(" ")})` : ""}`,
	};
}
