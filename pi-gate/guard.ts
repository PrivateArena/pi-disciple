/**
 * The output guard: a tool call the model **wrote** instead of **making**.
 *
 * A local or XML-dialect model sometimes ends its message with the *markup* of a call as plain text —
 * `<tool_call>…</tool_call>`, an `<invoke name=…>` envelope, a `<parameter=path>` fragment, a JSON body, or a
 * tail cut off in the middle of one — because the sampler produced the shape of a call on the text channel
 * instead of the structured block the harness reads. Pi sees text, so no tool runs and the run ends as if the
 * agent had answered: the turn is gone, and the human is left with a confident sentence about work that never
 * happened.
 *
 * The guard turns that into a message from the harness. At `turn_end` — on the one turn where the model spoke
 * and nothing ran — it reads the tail of the assistant text, and when the shape really is a call it appends a
 * reminder entry and asks Pi to continue the run, so the model is told "that call did not execute" while it
 * still has the work in context.
 *
 * **A false positive costs the exact thing this saves** — a turn the model did not intend — so every shape
 * test is strict: fenced and inline code is never a call, one balanced tag with no payload is prose, a
 * plain-JSON call has to parse and sit at the very end of the message, only the tail is read at all,
 * `gate.guard.allowPatterns` is a human-written veto, and the whole thing is bounded by a reminder budget the
 * next real tool call refills. Rule ids are config-addressable (`gate.guard.rules`, `.disableRules`,
 * `/gatec guard`), because the dialects are endless and a false positive has to be fixable without code.
 */

/**
 * The facade over the `output-guard/` package: every symbol this module used to declare is still reachable
 * from here, and the detectors, the registry, the budget and the `turn_end` pipeline each live in their own
 * module. Nothing under `output-guard/` imports this file.
 */

export * from "./output-guard/guard-limits.ts";
export * from "./output-guard/tag-shapes.ts";
export * from "./output-guard/message-scan.ts";
export * from "./output-guard/guard-rule.ts";
export * from "./output-guard/rule-registry.ts";
export * from "./output-guard/detection.ts";
export * from "./output-guard/reminder-copy.ts";
export * from "./output-guard/session-budget.ts";
export * from "./output-guard/turn-end-pipeline.ts";
