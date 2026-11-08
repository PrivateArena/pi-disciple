/**
 * The frontend status vocabulary a subagent card branches on.
 *
 * The leaf of the `card/` package: it needs nothing but the `Exit` union, and `card/details.ts` builds on it
 * — `card/progress.ts` through that. Split out of `run.ts`, which keeps re-exporting both symbols as its facade.
 */

import type { Exit } from "../run-exit.ts";

/**
 * The run status a frontend understands.
 *
 * `@gotgenes/pi-subagents` put this vocabulary into the session JSONL first, so a frontend that draws a
 * subagent card at all keys its branches off these strings — a status it has never seen matches no
 * branch, and the card keeps showing the activity list instead of the result. Our own, finer exit
 * stays in `details.exit`; `uiStatus` is the bridge.
 */
export type SubagentUiStatus = "queued" | "running" | "completed" | "stopped" | "aborted" | "error";

/** Map our exit onto the frontend status vocabulary. */
export function uiStatus(exit: Exit): SubagentUiStatus {
	switch (exit) {
		case "done":
			return "completed";
		case "aborted":
		case "timeout":
			return "stopped";
		case "maxTurns":
		case "callLimit":
		case "overflow":
			return "aborted";
		case "error":
			return "error";
	}
}
