/**
 * Where a spilled report goes and how it is written: the file a run's complete report is copied to when the
 * model-facing budget cuts it.
 *
 * Split out of `pi-subagent/run.ts`; `run.ts` imports this one function and does *not* re-export it, because
 * it was never part of its public surface. Naming the file is `transcript/paths.ts::reportFileFor`'s job —
 * imported from the sibling directly, never through the `child.ts` facade.
 */

import { writeFileSync } from "node:fs";
import { reportFileFor } from "./paths.ts";

/**
 * Where the complete report goes when it does not fit the model-facing budget: `reportFileFor` beside the
 * child's transcript. A file holding *only* the report is the cheap recovery path — reading the JSONL
 * transcript instead would cost the parent the whole exchange it delegated to avoid.
 */
export function writeReport(transcriptFile: string | undefined, report: string): string | undefined {
	if (!transcriptFile) return undefined;
	const file = reportFileFor(transcriptFile);
	try {
		writeFileSync(file, report, "utf8");
		return file;
	} catch {
		return undefined;
	}
}
