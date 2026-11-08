/**
 * Pure matching primitives for pi-gate (plan step 3).
 *
 * `segmentCommands()` is the only seam for a future real shell parser: everything else in the gate
 * consumes its output and never re-parses bash.
 */

/**
 * The facade over the `pattern/` and `render/` packages: it is the module the tests and the older
 * consumers import, and it re-exports every symbol each of them used to declare. The implementations
 * live in the sub-packages, one per matching concern, and nothing in `pattern/` imports this file.
 */

export * from "./pattern/regex-dialect.ts";
export * from "./pattern/glob.ts";
export * from "./pattern/rule-shape.ts";
export * from "./pattern/path-spellings.ts";
export * from "./pattern/protected-locations.ts";
export * from "./pattern/shell-segmentation.ts";
export * from "./pattern/shell-commands.ts";
export * from "./pattern/compound-patterns.ts";
export * from "./render/text.ts";
