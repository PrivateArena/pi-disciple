/**
 * The `details` object a subagent card is drawn from — the frontend contract.
 *
 * Split out of `run.ts`, which keeps re-exporting its public symbols as a facade. Everything here is about
 * what a card *shows*: the `@gotgenes/pi-subagents` field names (`displayName`, `subagentType`, `agent`,
 * `pendant`, …) that a frontend already knows how to read, the fields that feed them, and the `details`
 * shape a finished run settles to. It sits on top of `card/ui-status.ts` (the status vocabulary) and is
 * imported by `card/progress.ts`, by `render.ts` for the `details` type, and by the `run.ts` facade.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { ChildResult } from "../child.ts";
import type { CeilingReport } from "../budget/ceiling-vocabulary.ts";
import { clip, roleDisplayName, taskLabel } from "../labels.ts";
import type { RoleId } from "../roles.ts";
import type { SubagentUiStatus } from "./ui-status.ts";

/** `4.2k token`, or "" when the run reported no usage — never a guessed count. */
export function formatTokens(usage: Usage | undefined): string {
	const total = usage?.totalTokens ?? 0;
	if (total <= 0) return "";
	if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M token`;
	if (total >= 1000) return `${(total / 1000).toFixed(1)}k token`;
	return `${total} token`;
}

/** First non-empty line of a report, stripped of heading marks and clipped. */
export function previewOf(report: string, maxChars = 200): string {
	const line = report.split("\n").map((candidate) => candidate.trim()).find(Boolean) ?? "";
	return clip(line.replace(/^#+\s*/, ""), maxChars);
}

/**
 * The fields a subagent card is drawn from, named the way `@gotgenes/pi-subagents` names them
 * (`AgentDetails`, `GetResultDetails`) — that is the shape a frontend already knows how to read. They
 * sit beside our own fields; our renderer keeps reading `exit`, `elapsedMs`, `toolCalls`.
 */
export interface SubagentCardFields {
	/** Human-readable role, e.g. `Explore`. */
	displayName: string;
	/** The role id, e.g. `explore`. */
	subagentType: RoleId;
	/** The role id again, under the key the frontend vocabulary uses for a step's agent name. */
	agent: RoleId;
	/** What was asked of the child, whole, flattened onto one line (a header slot is one line, a hover is not). */
	description: string;
	toolUses: number;
	durationMs: number;
	/** Pre-formatted token total; "" when the run reported none. */
	tokens: string;
	agentId?: string;
	modelName?: string;
	/** First line of the report, clipped — never the report itself, which `content` already carries. */
	preview?: string;
	/**
	 * Header labels for the Pendant frontend, which draws its own subagent card and never calls our
	 * renderers. It reads this object when the call finishes; pi's terminal ignores it. An empty string
	 * counts as missing there, so a label that is not available is left out rather than sent blank. The
	 * subtitle carries the entire task: Pendant puts a label that does not fit the header behind a hover
	 * tooltip, and that tooltip is where a human reads what the child was actually told to do.
	 */
	pendant: { title: string; subtitle?: string };
}

/** The card fields for one state of a run. */
export function cardFields(
	host: { role: RoleId; task: string; model?: string },
	run: { toolCalls: number; elapsedMs: number; agentId?: string; usage?: Usage; report?: string },
): SubagentCardFields {
	return {
		displayName: roleDisplayName(host.role),
		subagentType: host.role,
		agent: host.role,
		description: taskLabel(host.task),
		toolUses: run.toolCalls,
		durationMs: run.elapsedMs,
		tokens: formatTokens(run.usage),
		agentId: run.agentId,
		modelName: host.model,
		...(run.report ? { preview: previewOf(run.report) } : {}),
		...pendantHeader(host),
	};
}

/** The Pendant header: the role names the card, the whole task subtitles it. */
function pendantHeader(host: { role: RoleId; task: string }): { pendant: SubagentCardFields["pendant"] } {
	const subtitle = taskLabel(host.task);
	return { pendant: { title: roleDisplayName(host.role), ...(subtitle ? { subtitle } : {}) } };
}

export interface SubagentDetails extends SubagentCardFields {
	/** Frontend status vocabulary (see `uiStatus`); our own exit is in `exit`. */
	status: SubagentUiStatus;
	role: RoleId;
	/**
	 * The model did not name a role, so `subagent.defaultRole` decided. Carried so the card can say the
	 * child ran on a role the human configured rather than one the model asked for.
	 */
	roleDefaulted?: boolean;
	/** The settled exit; absent while the child is still running. Drives our renderer's wording. */
	exit?: ChildResult["exit"];
	turns: number;
	toolCalls: number;
	childSessionFile?: string;
	childSessionId?: string;
	truncated: boolean;
	elapsedMs: number;
	removedTranscripts?: number;
	nestedCalls?: number;
	shimTools?: string[];
	/** Which model the child actually ran on, e.g. `local/qwen3.8-flash-next (inherited)`. */
	model?: string;
	/**
	 * The thinking level the child actually ran at, pre-formatted, e.g. `off` or `high → xhigh (this model has no
	 * "high")`. Absent when the child ran on the session's level at a level the model has — the two cases where
	 * reporting it would only repeat what the parent already knows (see `childThinkingLabel`).
	 */
	thinking?: string;
	/**
	 * What the role put on the request body, e.g. `temperature=0.3 · top_p=0.9`. Absent when the role names no
	 * sampling: a run whose parameters changed is not visible anywhere else, and the whole point of the knob is
	 * that the answer stops depending on which role happened to run.
	 */
	sampling?: string;
	error?: string;
	/** The task, so a running card can say what the child is doing. */
	task?: string;
	/** What the child was last seen doing (`bash`, `read`, …) — only while running. */
	activity?: string;
	/**
	 * The one budget-extension offer this run got, if a budget was ever spent: what the human was asked, and
	 * what they answered. Absent means no ceiling was reached, which is the ordinary run.
	 */
	ceiling?: CeilingReport;
	/**
	 * The child's report on its own, without the model-facing header, and always the *whole* thing: the
	 * `maxResultBytes` cap bounds what the *model* is sent, never what the human is shown (see
	 * `composeResult`, which writes the omitted part to `reportFile`).
	 */
	report?: string;
	/** Where the complete report was written, when the model-facing copy had to be cut. */
	reportFile?: string;
}
