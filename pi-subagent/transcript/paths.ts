/**
 * Where a child's on-disk artifacts live and how they are named: the directory its transcript is written
 * to, and the report file that is spilled beside it, so one child is one pair of files. Split out of
 * `child.ts`, which keeps re-exporting both symbols as its facade.
 */

import { join } from "node:path";

export function childSessionDir(parentSessionDir: string): string {
	return join(parentSessionDir, "subagent");
}

/**
 * The sibling file a run's complete report is spilled to (see `pi-subagent/run.ts::composeResult`): the
 * transcript's own directory and basename, so one child's artifacts are one pair of files and pruning can
 * pair them without a second index.
 */
export function reportFileFor(transcriptFile: string): string {
	return transcriptFile.endsWith(".jsonl") ? `${transcriptFile.slice(0, -".jsonl".length)}.report.md` : `${transcriptFile}.report.md`;
}
