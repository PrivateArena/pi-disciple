/**
 * Stopping *one* running child, from inside the same process, without aborting the turn.
 *
 * Why this file exists: the child is an in-process `AgentSession` (`child.ts`), so a hanging nested command
 * is a process the *parent* pi owns and a client can already signal (that is Amulet's "Stop this command").
 * But a child that hangs somewhere else — a model request that never returns, an in-process tool, a budget
 * dialog nobody answers — has no process to signal, and the only lever a client has had is aborting the whole
 * run, which takes the parent's turn down with the child. This module is the missing lever: a per-call stop,
 * addressed by the id of the `subagent` tool call, which ends the child and lets the parent read the reason at
 * the head of the tool result and carry on.
 *
 * Why it is on `globalThis`: pi loads each extension as its own module graph, so a second extension cannot
 * `import` this one — but every extension in a session shares one process, and `Symbol.for` is the one name
 * space both can reach. Same mechanism as `run-guard.ts`'s `RUN_GUARD_KEY`, and the same reason: a `/reload`
 * replaces the module registry, not the process, so the registry must outlive the module.
 *
 * The rule that keeps this safe: **a stop is addressed, never broadcast.** `stop()` only ever acts on the
 * `callId` the caller names — the id of the tool call a human is looking at — and refuses anything else. A
 * client that cannot name the run does not get to end it, which is what makes it acceptable that this is
 * reachable from any extension in the process.
 *
 * Vocabulary note for clients: `reason` is an opaque sentence this extension only *places*, never writes.
 * The caller owns the wording, so a client that already says "Stopped by user with note: …" elsewhere (the
 * Amulet bridge, for its command stops) can say exactly the same thing here.
 */

/** The process-global slot this API is published under. A well-known name, so a client needs no import. */
export const SUBAGENT_STOP_KEY = Symbol.for("pi-subagent.stop");

/**
 * Internal: the live registrations, kept beside the API rather than inside it.
 *
 * Two keys, because they have two audiences. What hangs off {@link SUBAGENT_STOP_KEY} is the *contract* a client
 * calls, so it must be exactly the API object and nothing wrapped around it; what hangs off this one is our own
 * state, and nobody outside this file is meant to find it. Both are on `globalThis` for the run guard's reason: a
 * `/reload` replaces the module instance, and a stop offered for a child that is still executing has to survive it.
 */
const RUNS_KEY = Symbol.for("pi-subagent.stop.runs");

/** Bumped when the shape below changes incompatibly. A client refuses a version it does not know. */
export const SUBAGENT_STOP_API_VERSION = 1;

/** One child that is executing right now. */
export interface RunningSubagent {
	/** The *parent's* `subagent` tool call id — the address a `stop()` takes. */
	callId: string;
	role: string;
	/** The task, truncated by the caller that registered it. Only a UI reads this. */
	task: string;
	startedAt: number;
}

/** Why a stop did not happen. Three answers, because they are three different sentences in a UI. */
export type SubagentStopErrorCode =
	/** No child is running at all, so there was nothing to stop. */
	| "no-run"
	/** A child is running, but it is not the one that was named. Nothing was aborted. */
	| "unknown-call"
	/** The human was asked and did not say yes: declined, timed out, or dismissed. */
	| "not-answered";

/** A stop request from a client in this process. */
export interface SubagentStopRequest {
	/** The *parent's* `subagent` tool call id — the only thing a stop may address. */
	callId: string;
	/**
	 * The sentence the parent model will read at the head of the child's report. May be empty: a stop with no
	 * words is still a stop, and the extension writes its own sentence when none came (see `stopNote` in `run.ts`).
	 */
	reason: string;
	/**
	 * Whether a human has already answered for this stop, in the caller's own dialog.
	 *
	 * `false` (or absent) means the request arrived with nobody asked — a keyboard shortcut, an IDE button that
	 * fires on click — and this extension then asks first, because "a human has to make the decision that ends a
	 * child's run" is this extension's rule, not the caller's to waive. `true` is not a privilege granted to a
	 * caller: it is a statement that a person already chose, which is why the caller's words travel with it.
	 */
	answered?: boolean;
}

export type SubagentStopResult =
	/** The child was told to stop; its report comes back with the request's reason at the head of it. */
	| { ok: true; callId: string; role: string; asked: boolean }
	/** Nothing was aborted. */
	| { ok: false; code: SubagentStopErrorCode; error: string };

/** What a client in this process can ask of a running child. */
export interface SubagentStopApi {
	version: number;
	/** Every child executing now — one today (the run guard), but never a guess about which one. */
	running(): RunningSubagent[];
	/**
	 * Stop the child whose parent tool call is `request.callId`, asking the human first unless the request says a
	 * human already answered. Resolves: an answer can take as long as a person takes.
	 *
	 * Returns whether the named child was found, so a client can report a miss honestly instead of reporting a
	 * stop that aborted somebody else's run.
	 */
	stop(request: SubagentStopRequest): Promise<SubagentStopResult>;
}

/** The registration a run makes for as long as it executes. */
export interface LiveRun {
	callId: string;
	role: string;
	task: string;
	startedAt: number;
	/** Same lever the run guard holds: the child's own `AbortController`. */
	abort: () => void;
	/**
	 * Ask the human whether this run may end, and report what they said.
	 *
	 * Provided by the run rather than by this module because only the run knows how to put the question in the
	 * room it is actually in: `index.ts` hands over the same dialog helper the budget offer uses, which renders a
	 * real TUI dialog in a terminal and an `extension_ui_request` under an RPC client. A stop that could not ask
	 * does not happen at all — an unanswered question is not a yes.
	 */
	askStop: (question: StopQuestion) => Promise<boolean>;
}

/** What the question is about, in the human's terms. */
export interface StopQuestion {
	role: string;
	task: string;
	/** Seconds the child has already been running. */
	elapsedSeconds: number;
	/** The sentence that will reach the parent if the answer is yes. */
	reason: string;
}

/** The run's half of the registration. */
export interface LiveRunHandle {
	/**
	 * Take the reason a human gave for stopping this run, once.
	 *
	 * Called by the run itself while composing its result, so a stop that arrived one tick after the child
	 * finished still lands on the report the parent reads — the alternative is a stop that silently looks
	 * like a run that ended on its own.
	 */
	takeStop(): string | undefined;
	/** Retire the registration. Always called from a `finally`: a stale address is a wrong target. */
	release(): void;
}

interface Registration {
	run: LiveRun;
	reason?: string;
	/** Set while a stop that had to ask is awaiting its answer, so a double press is one question. */
	asking?: boolean;
}

interface StopRegistry {
	api: SubagentStopApi;
	/** callId → the run. `run-guard.ts` permits one child, but a Map keeps this honest if that changes. */
	live: Map<string, Registration>;
}

function publishedApi(): SubagentStopApi | undefined {
	const value = (globalThis as Record<symbol, unknown>)[SUBAGENT_STOP_KEY];
	return value && typeof value === "object" ? (value as SubagentStopApi) : undefined;
}

function runs(): Map<string, Registration> | undefined {
	return (globalThis as Record<symbol, unknown>)[RUNS_KEY] as Map<string, Registration> | undefined;
}

/**
 * The one registry in this process: the API a client calls, plus the runs it can address.
 *
 * Idempotent across module instances — after a reload the old API object (and the map it closes over) is what
 * both the client and the reloaded extension keep using, so a stop can still reach a child the previous instance
 * started.
 */
function ensureRegistry(): StopRegistry {
	const api = publishedApi();
	const live = runs();
	if (api && live) return { api, live };
	const map = live ?? new Map<string, Registration>();
	const made: StopRegistry = {
		live: map,
		api: {
			version: SUBAGENT_STOP_API_VERSION,
			running: () => [...map.values()].map((r) => publicOf(r.run)),
			stop: (request) => stopRun(made, request),
		},
	};
	const globals = globalThis as Record<symbol, unknown>;
	globals[SUBAGENT_STOP_KEY] = made.api;
	globals[RUNS_KEY] = map;
	return made;
}

function publicOf(run: LiveRun): RunningSubagent {
	return { callId: run.callId, role: run.role, task: run.task, startedAt: run.startedAt };
}

/** The question a run puts to the human when a stop arrives with nobody asked. */
export function stopQuestion(run: LiveRun, reason: string, now = Date.now()): StopQuestion {
	return {
		role: run.role,
		task: run.task,
		elapsedSeconds: Math.max(0, Math.round((now - run.startedAt) / 1000)),
		reason,
	};
}

/** Where a reason is absent or all whitespace: the extension's own sentence, not the caller's. */
export const STOP_WITHOUT_NOTE = "Stopped by user: the subagent was stopped before it reported.";

/** The sentence that reaches the parent, with the caller's words when it brought any. */
export function stopNote(reason: string | undefined): string {
	const text = reason?.trim();
	return text ? text : STOP_WITHOUT_NOTE;
}

async function stopRun(registry: StopRegistry, request: SubagentStopRequest): Promise<SubagentStopResult> {
	const { callId } = request;
	const found = registry.live.get(callId);
	if (!found) {
		const running = [...registry.live.values()].map((r) => publicOf(r.run));
		if (!running.length)
			return { ok: false, code: "no-run", error: "no subagent is running in this session." };
		return {
			ok: false,
			code: "unknown-call",
			error:
				`call ${callId} is not the subagent that is running (this one is: ${running
					.map((r) => `${r.role} ${r.callId}`)
					.join(", ")}).`,
		};
	}
	const note = stopNote(request.reason);
	const asked = request.answered !== true;
	if (asked) {
		// One question at a time: a second press while the first is on screen would open a second dialog over
		// the same decision, and two "yes" answers cannot stop a child twice.
		if (found.asking)
			return {
				ok: false,
				code: "not-answered",
				error: `the ${found.run.role} subagent is already being asked whether to stop — answer the dialog on screen.`,
		};
		found.asking = true;
		let yes = false;
		try {
			yes = await found.run.askStop(stopQuestion(found.run, note));
		} catch {
			// An asker that could not draw the question did not get an answer. That is a refusal, and the caller
			// hears a sentence about it rather than an exception out of another extension's dialog code.
			yes = false;
		} finally {
			found.asking = false;
		}
		if (!yes)
			return {
				ok: false,
				code: "not-answered",
				error: `the ${found.run.role} subagent kept running — stopping it was not answered yes.`,
		};
	}
	// The run may have reported while the question was on screen; a stop then is a refusal, not a surprise.
	const still = registry.live.get(callId);
	if (!still) return { ok: false, code: "no-run", error: "that subagent finished while it was being asked." };
	// Recorded before the abort, so a child that dies instantly cannot miss its own reason.
	still.reason = note;
	still.run.abort();
	return { ok: true, callId, role: still.run.role, asked };
}

/**
 * Publish the API for this process and hand it back. Idempotent, and called at extension load: a client
 * probes it while nothing is running, which is the only moment it can decide whether to draw the control.
 *
 * What lands on the well-known symbol is the API object itself — `api.stop`, `api.running`, `api.version` — never
 * a wrapper around it, because a client that has to guess at our internals is a client that fails silently.
 */
export function publishStopApi(): SubagentStopApi {
	return ensureRegistry().api;
}

/** The published API, or undefined when pi-subagent is not loaded in this process. */
export function stopApi(): SubagentStopApi | undefined {
	return publishedApi();
}

/** Whether some pi-subagent in this process has published a stop API of a version we can call. */
export function hasStopApi(): boolean {
	return publishedApi()?.version === SUBAGENT_STOP_API_VERSION;
}

/**
 * Register one executing child. Called where the run guard is claimed, released where it is released — the
 * two live and die on the same moments, and a run the guard does not know about is a run nothing can stop.
 */
export function registerRun(run: LiveRun): LiveRunHandle {
	const store = ensureRegistry();
	store.live.set(run.callId, { run });
	return {
		takeStop: () => {
			const found = store.live.get(run.callId);
			if (!found) return undefined;
			const reason = found.reason;
			delete found.reason;
			return reason;
		},
		release: () => {
			// Only ever this registration: a re-issued call id (a resumed session, a reloaded extension) must
			// not have a *new* run retired by an old one's `finally`.
			if (store.live.get(run.callId)?.run === run) store.live.delete(run.callId);
		},
	};
}
