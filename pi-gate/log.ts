/**
 * Permission review log (plan step 18). Off by default (`gate.reviewLog`).
 *
 * One JSON line per ask resolution, so "which handler approved this and with what facts" is auditable
 * even when another extension mutated `event.input` after us (FM-17).
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Scope } from "./config-contract/action-vocabulary.ts";
import { EXTENSION_CONFIG_SLUG } from "./config-file.ts";

export interface LogEntry {
	ts: string;
	callId: string;
	parentCallId?: string;
	toolName: string;
	surface: string;
	pattern?: string;
	scope?: Scope;
	resolution: string;
	/** Which question of the call this line answers: `command` (what it does), `location` (where it writes)
	 *  or `network` (whom it reaches). */
	stage?: string;
	reason?: string;
	sub?: { role: string; taskExcerpt: string };
	/** The exact facts that were approved (FM-17 audit trail). */
	preview?: string;
	floors?: string[];
}

/** `<agentDir>/extensions/pi-gate/logs/<name>` — one spelling for both artefacts the gate writes. */
function gateLogFile(name: string): string {
	return join(getAgentDir(), "extensions", EXTENSION_CONFIG_SLUG, "logs", name);
}

export function defaultLogPath(): string {
	return gateLogFile("review.jsonl");
}

/**
 * Where guard hits go: a different event kind on a different file, because a malformed call is not a
 * permission decision and a human reading one log should not have to filter the other out of it.
 */
export function defaultGuardLogPath(): string {
	return gateLogFile("guard.jsonl");
}

export interface GuardLogEntry {
	ts: string;
	kind: "malformed-tool-call";
	/** Every detector that fired, first one named by `label`. */
	rules: string[];
	label: string;
	evidence: string;
	/** What the gate did about it: `notify` (human only) or `remind` (the model was told and the run went on). */
	action: string;
	turnIndex: number;
	stopReason?: string;
	model?: string;
	/** Reminders spent in this session, after this one. */
	reminders: number;
}

const SECRET_RE =
	/(\b[\w-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s;|&]+)/gi;

/** Bash commands carry credentials; never log them verbatim. */
export function redact(text: string): string {
	return text.replace(SECRET_RE, "$1<redacted>");
}

async function appendLine(path: string, line: string): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${line}\n`, "utf8");
	} catch {
		/* logging must never change a decision */
	}
}

export async function reviewLog(path: string, entry: LogEntry): Promise<void> {
	await appendLine(path, JSON.stringify(entry));
}

export async function guardLog(path: string, entry: GuardLogEntry): Promise<void> {
	await appendLine(path, JSON.stringify(entry));
}
