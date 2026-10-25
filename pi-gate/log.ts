/**
 * Permission review log (plan step 18). Off by default (`gate.reviewLog`).
 *
 * One JSON line per ask resolution, so "which handler approved this and with what facts" is auditable
 * even when another extension mutated `event.input` after us (FM-17).
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Scope } from "./schema.ts";

export interface LogEntry {
	ts: string;
	callId: string;
	parentCallId?: string;
	toolName: string;
	surface: string;
	pattern?: string;
	scope?: Scope;
	resolution: string;
	reason?: string;
	sub?: { role: string; taskExcerpt: string };
	/** The exact facts that were approved (FM-17 audit trail). */
	preview?: string;
	floors?: string[];
}

export function defaultLogPath(): string {
	return join(getAgentDir(), "extensions", "pi-gate", "logs", "review.jsonl");
}

const SECRET_RE =
	/(\b[\w-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s;|&]+)/gi;

/** Bash commands carry credentials; never log them verbatim. */
export function redact(text: string): string {
	return text.replace(SECRET_RE, "$1<redacted>");
}

export async function reviewLog(path: string, entry: LogEntry): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		/* logging must never change a decision */
	}
}
