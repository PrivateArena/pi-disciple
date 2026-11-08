/**
 * The decision vocabulary of the gate: a `Rule`, a `Policy`, the facts of one call, the stages a call
 * is asked about and the `Decision` that comes back (plan steps 6 and 7, split out of `policy.ts`).
 *
 * Types, the severity table and the surface taxonomy only — no matching, no loading, no evaluation.
 */

import { type Action, type HardDenyRule, type PermissionEntry, type Scope } from "../config-contract/action-vocabulary.ts";
import { type GateConfig } from "../config-contract/gate-section.ts";
import { type Facts } from "../inspect.ts";
import { NETWORK_SURFACE } from "../network.ts";

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
	/**
	 * The `gate.hardDeny` rules of the files that were read — global, plus project when the cwd is
	 * trusted (plan step C2). Kept beside `rules` rather than mixed into them: these are not a layer of
	 * the precedence ladder, they are the one thing above it, so they must never be reordered by scope,
	 * overridden by a grant, or answered by a dialog click.
	 */
	hardDeny: HardDenyRule[];
	/** `permission["*"]` when it is an action, else `ask` (least privilege). */
	defaultAction: Action;
	/** A config file could not be parsed: every `allow` escalates to `ask` (FM-9). */
	degraded: boolean;
	cwd: string;
	trusted: boolean;
	agentDir: string;
	protectedGlobs: string[];
	/**
	 * The `gate.permission` surfaces a config file named. A built-in class-wide default for one of these is
	 * the fallback under the human's own rule for it (`bash: "ask"`), not a rival — see {@link matchFact}.
	 */
	configuredSurfaces: ReadonlySet<string>;
}

export interface FactCheck {
	surface: string;
	value: string;
	action: Action;
	rule?: Rule;
	floor?:
		| "protected_path"
		| "protected_read"
		| "wrapper"
		| "external_directory"
		| "network_egress"
		| "degraded_config";
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
 *
 * `network` is the third question (plan step B): *who this call talks to*. It is separate from
 * `location` for the same reason a directory is separate from a command — a host is neither, and the
 * rule that answers it (`aliyuncs.com`) is a shape no path or command pattern reaches.
 */
export type Stage = "command" | "location" | "network";

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

/** The `path` and `external_directory` facts: the gate's statement about *where*, not *what*. */
export const LOCATION_SURFACES: readonly string[] = ["path", "external_directory"];

export function isLocationSurface(surface: string): boolean {
	return LOCATION_SURFACES.includes(surface);
}

/**
 * The egress surface (plan step B3): one fact per host a call can reach. The name itself lives in
 * `network.ts`, which owns the facts, so there is one spelling of it; it is deliberately **not** in
 * {@link LOCATION_SURFACES} — a host is not a location the gate has a rule about, and folding egress
 * into the location question would let a folder grant answer it, the same mistake as letting `cat *`
 * answer a domain.
 */
export { NETWORK_SURFACE };

export function isNetworkSurface(surface: string): boolean {
	return surface === NETWORK_SURFACE;
}
