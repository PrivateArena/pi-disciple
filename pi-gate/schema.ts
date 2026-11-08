/**
 * Config document types and tolerant parsers, shared by pi-gate and pi-subagent (plan step 2).
 *
 * The two extensions read the same `config.json` file(s) but only ever import this module's types
 * and pure parsers — never each other (see the plan's ownership boundary).
 */

/**
 * The facade over the `config-contract/` package, and the one public surface pi-subagent is allowed to
 * import (see the ownership boundary in the plan): every symbol this module used to declare is still
 * reachable from here, and the implementations live one per config section under `config-contract/`.
 */

export * from "./config-contract/action-vocabulary.ts";
export * from "./config-contract/guard-section.ts";
export * from "./config-contract/gate-section.ts";
export * from "./config-contract/role-vocabulary.ts";
export * from "./config-contract/sampling-vocabulary.ts";
export * from "./config-contract/subagent-section.ts";
