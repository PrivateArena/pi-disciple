/**
 * What a *running* child shows on the card: the progress line and the complete `details` that goes with an
 * update.
 *
 * Split out of `run.ts`, which keeps re-exporting its public symbols as a facade. This is the top of the
 * `card/` package — it composes `card/details.ts` (and through it `card/ui-status.ts`) for a state the child
 * has not reached yet. Its callers are `index.ts`, which emits every progress update, and the `run.ts` facade.
 */

import type { RunProgress } from "../child.ts";
import type { CeilingReport } from "../budget/ceiling-vocabulary.ts";
import type { RoleId } from "../roles.ts";
import { cardFields, type SubagentDetails } from "./details.ts";

export function formatProgress(progress: RunProgress, toolCount: number): string {
	return (
		`subagent running · turn ${progress.turns} · ${progress.toolCalls} calls · ` +
		`${progress.lastTool ?? "thinking"} · ${Math.round(progress.elapsedMs / 1000)}s · ${toolCount} tools`
	);
}

/** The parts of a run that do not change between progress updates. */
export interface ProgressContext {
	role: RoleId;
	roleDefaulted?: boolean;
	task: string;
	model?: string;
	/** The role's thinking level, pre-formatted for the card (see `SubagentDetails.thinking`). */
	thinking?: string;
	/** The role's sampling, pre-formatted for the card (see `SubagentDetails.sampling`). */
	sampling?: string;
	shimTools: string[];
	nestedCalls: number;
	/** A granted extension, so a card that stays open for minutes says the run has more rope than it started with. */
	ceiling?: CeilingReport;
}

/**
 * A complete `details` for a progress update. An update that carries an empty object is not a
 * status the UI can draw — that is what left the tool card on its "no activity" placeholder.
 */
export function progressDetails(progress: RunProgress, host: ProgressContext): SubagentDetails {
	return {
		status: "running",
		role: host.role,
		roleDefaulted: host.roleDefaulted,
		turns: progress.turns,
		toolCalls: progress.toolCalls,
		truncated: false,
		elapsedMs: progress.elapsedMs,
		activity: progress.lastTool ?? "thinking",
		ceiling: host.ceiling,
		task: host.task,
		model: host.model,
		thinking: host.thinking,
		sampling: host.sampling,
		shimTools: host.shimTools,
		nestedCalls: host.nestedCalls,
		...cardFields(host, { toolCalls: progress.toolCalls, elapsedMs: progress.elapsedMs }),
	};
}
