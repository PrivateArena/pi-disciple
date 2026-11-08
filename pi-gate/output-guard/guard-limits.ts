/**
 * The output guard's budgets, ids and message type — the constants every other module of the package
 * reads and none of them owns.
 */

/** The `customType` of the reminder the model is handed. */
export const GUARD_MESSAGE_TYPE = "pi-gate.malformed-tool-call";

/** Stop reasons worth reminding about: the model chose to stop, or ran out of output room. */
export const REMINDABLE_STOP_REASONS: ReadonlySet<string> = new Set(["stop", "length"]);

/** How much of a thinking block counts as "the reasoning stopped on the markup of a call". */
export const THINKING_TAIL_CHARS = 240;

/** Evidence budget in the reminder and the log line. */
export const EVIDENCE_CHARS = 160;

/** Largest JSON candidate the plain-text call rules will parse. */
export const JSON_CANDIDATE_CHARS = 2000;

/** How many `{` positions are tried from the end, so the scan stays a scan of a small window. */
export const JSON_CANDIDATE_LIMIT = 12;

/** Assistant messages remembered per session, so `seen` cannot grow without bound. */
export const REMINDER_MEMORY_LIMIT = 32;

/** The rule id of the thinking-tail check, which runs only for a message with no text at all. */
export const THINKING_RULE_ID = "call-in-thinking";
