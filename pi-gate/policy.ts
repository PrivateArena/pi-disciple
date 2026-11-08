/**
 * Policy loading and evaluation: the single source of truth for a call's action (plan step 5).
 *
 * Three separate rules, never conflated:
 *  1. **within one fact** — rules of all layers concatenate in precedence order
 *     `builtin → global.permission → project.permission → grants.global → grants.project →
 *     grants.session` and the last matching pattern wins;
 *  2. **within one question** ({@link Stage}) — facts that name the *same thing* are judged once, by the
 *     most specific rule about them, most restrictive among those;
 *  3. **across the questions of one call** — `command` (what it does), `location` (where it goes) and
 *     `network` (who it talks to) are decided separately and combined most-restrictive,
 *     `deny > ask > allow`, because each has its own grantable rule and its own dialog.
 * Floors are applied per fact after rule matching and can only ever escalate.
 */

/**
 * The facade over the `policy-resolution/` package: every symbol this module used to declare is still
 * reachable from here, including the re-exports it already served (`GrantRule`, `HardDenyRule`,
 * `NETWORK_SURFACE`, `mostRestrictive`, `severity`). Nothing under `policy-resolution/` imports this file.
 */

export type { GrantRule, HardDenyRule } from "./config-contract/action-vocabulary.ts";
export { NETWORK_SURFACE } from "./network.ts";
export { mostRestrictive } from "./config-contract/action-vocabulary.ts";
export { severityOf as severity } from "./policy-resolution/fact-evaluation.ts";

export * from "./policy-resolution/call-decision.ts";
export * from "./policy-resolution/override-mode.ts";
export * from "./policy-resolution/policy-loading.ts";
export * from "./policy-resolution/surface-matching.ts";
export * from "./policy-resolution/fact-evaluation.ts";
export * from "./policy-resolution/grant-offers.ts";
