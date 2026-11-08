/**
 * Transcript retention: which of a role's transcripts survive a run, and what happens to the reports of
 * the ones that do not (FM-15). Split out of `child.ts`, which keeps re-exporting it as its facade.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { reportFileFor } from "./paths.ts";

/**
 * Keep the newest `keep` transcripts and delete the rest (FM-15). Report spill files are not counted as
 * transcripts — they follow their own: a deleted transcript takes its report with it, and a report left
 * behind by an already-deleted transcript is swept here too.
 */
export async function pruneTranscripts(dir: string, keep: number): Promise<number> {
	if (!existsSync(dir)) return 0;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	const stamped = names
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => {
			const path = join(dir, name);
			let mtimeMs = 0;
			try {
				mtimeMs = statSync(path).mtimeMs;
			} catch {
				/* ignore unreadable entries */
			}
			return { path, mtimeMs };
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const kept = stamped.slice(0, Math.max(0, keep));
	const keptReports = new Set(kept.map((entry) => reportFileFor(entry.path)));
	const victims = stamped.slice(kept.length).map((entry) => entry.path);
	// Every report whose transcript is not in the kept set is stale — deleted this pass or in an earlier one.
	const staleReports = names.filter((name) => name.endsWith(".report.md")).map((name) => join(dir, name)).filter((report) => !keptReports.has(report));
	let removed = 0;
	for (const victim of [...victims, ...staleReports]) {
		try {
			await rm(victim, { force: true });
			removed += victim.endsWith(".jsonl") ? 1 : 0;
		} catch {
			/* best effort */
		}
	}
	return removed;
}
