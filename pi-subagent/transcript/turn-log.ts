/**
 * turn-log.ts — one JSONL file per child run, in `<tmp>/pi-subagent/`, for the runs nobody could debug any
 * other way.
 *
 * A child is an in-process session with no extensions, no UI of its own and a card that shows one line of
 * state, so the three failures people actually hit are invisible from the parent: what the child was *thinking*
 * when its turn was aborted, whether the ceiling fired while a tool was still running, and what the final report
 * turn said. pi already writes the child's transcript under `<sessionDir>/subagent/`, but that file is the model's
 * history — it says nothing about steers, ceilings, reminders or the exit, and finding it means knowing the
 * parent session's path. This is the harness's own record of one run, in the same JSONL shape, at a path nobody
 * has to look up.
 *
 * `subagent.debugLog` switches it (default on, one file per child, the newest `subagent.keepTranscripts` kept),
 * and `subagent.debugLogDir` says where. Writing it must never change a run: every failure is swallowed, the
 * appends are serialised on one tail so a line is never interleaved, and the bulky halves of a tool result are
 * cut rather than buffered.
 */

import { appendFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Where a child's log lands when the config says nothing. `TMPDIR` is honoured, as everywhere. */
export const DEFAULT_DEBUG_LOG_DIR = () => join(tmpdir(), "pi-subagent");

/** What one line of a tool result is worth on disk. The transcript holds the rest. */
export const LOG_RESULT_CHARS = 2_000;

/** The directory of the shipped default, exported for `/subagentc` and the tests. */
export function debugLogDir(override?: string): string {
	const text = override?.trim();
	return text ? text : DEFAULT_DEBUG_LOG_DIR();
}

/** `<tmp>/pi-subagent/2026-11-18T10-30-00-000_general-purpose_<tail>.jsonl` — sortable, and one per run. */
export function debugLogFileName(startedAt: number, role: string, id: string): string {
	const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
	const safeRole = role.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "child";
	return `${stamp}_${safeRole}_${id.replace(/[^A-Za-z0-9]+/g, "").slice(-8) || "run"}.jsonl`;
}

/**
 * A run's log holds its thinking and its tool arguments, which is what makes it worth reading and what makes it
 * private: `0700`/`0600`, because `<tmp>` is world-readable and a child may have read a `.env`.
 */
const LOG_DIR_MODE = 0o700;
const LOG_FILE_MODE = 0o600;

/** Credentials live in command lines; never copy them into a shared temp dir verbatim. */
const SECRET_RE =
	/(\b[\w-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s;|&]+)/gi;

export function logRedact(text: string): string {
	return text.replace(SECRET_RE, "$1<redacted>");
}

export interface TurnLog {
	/** The file this log writes to, or `undefined` when logging is off or the directory could not be made. */
	readonly file: string | undefined;
	line(kind: string, detail?: unknown): void;
	/** Wait for the lines already queued to land. Bounded: a hung filesystem is not a reason to hang a run. */
	close(): Promise<void>;
}

/** How long a finished run waits for its own log. */
const LOG_FLUSH_MS = 1_000;

/** A log that writes nothing, so callers never branch on the switch. */
const NULL_LOG: TurnLog = { file: undefined, line: () => undefined, close: async () => undefined };

export interface TurnLogInput {
	enabled: boolean;
	/** Already resolved by `debugLogDir`, so the default is spelled once. */
	dir?: string;
	role: string;
	/** Anything stable and short: the parent's tool call id, or the child's session id. */
	id: string;
	startedAt?: number;
	/** The first line: how the run was configured, which is half of every answer. */
	meta?: unknown;
}

/**
 * Open the log for one run. Never throws: a directory that cannot be created leaves a run whose log is absent,
 * which is the entire cost of a debug feature being broken.
 */
export function openTurnLog(input: TurnLogInput): TurnLog {
	if (!input.enabled || !input.dir) return NULL_LOG;
	const dir = input.dir;
	const file = join(dir, debugLogFileName(input.startedAt ?? Date.now(), input.role, input.id));
	// One tail for everything: the directory and the file are created *on* the tail, so no line can ever be
	// queued against a path that does not exist yet (that is how `run_start` used to go missing), and the file is
	// created with its own mode because `appendFile`'s is honoured only on creation.
	let tail: Promise<unknown> = mkdir(dir, { recursive: true })
		.then(() => chmod(dir, LOG_DIR_MODE))
		.then(() => appendFile(file, "", { encoding: "utf8", mode: LOG_FILE_MODE }))
		.then(() => chmod(file, LOG_FILE_MODE))
		.catch(() => undefined);
	let closed = false;
	return {
		file,
		line(kind: string, detail?: unknown): void {
			if (closed) return;
			let line: string;
			try {
				line = `${JSON.stringify({ ts: new Date().toISOString(), kind, ...(detail === undefined ? {} : { detail }) })}\n`;
			} catch {
				line = `${JSON.stringify({ ts: new Date().toISOString(), kind, detail: "<unserialisable>" })}\n`;
			}
			// Redact the whole line, not just the tool arguments: a token survives in a `bash` command string, an
			// `edit` body, and the model's own narration about it.
			tail = tail.then(() => appendFile(file, logRedact(line), "utf8").catch(() => undefined));
		},
		close(): Promise<void> {
			closed = true;
			return Promise.race([tail.then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, LOG_FLUSH_MS).unref?.())]);
		},
	};
}

/** Cut a string to the log's budget, saying how much fell off. */
export function logSlice(text: string, maxChars = LOG_RESULT_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[… ${text.length - maxChars} more chars, in the transcript]`;
}
