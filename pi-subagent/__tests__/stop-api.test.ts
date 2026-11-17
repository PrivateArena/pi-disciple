/**
 * The per-call stop API: the address rule, the asking rule, the reason handoff, and the registry's own life cycle.
 *
 * What is load-bearing here is not the abort — one function call the run guard could already make. It is three
 * rules a wrong implementation loses silently:
 *  1. a stop only acts on the run it was **addressed** by id (what makes a process-global symbol safe to expose);
 *  2. a stop with no human answer gets **asked**, and only an explicit "stop it" answers yes (which is what keeps
 *     an unreachable client, a dismissed dialog or `pi -p` from ending a child nobody agreed to end);
 *  3. `takeStop()` hands the reason over **once, at composition time**, so a stop that raced the child's own finish
 *     still reaches the parent model instead of looking like a run that ended itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	SUBAGENT_STOP_API_VERSION,
	SUBAGENT_STOP_KEY,
	publishStopApi,
	registerRun,
	stopApi,
	stopNote,
	type LiveRun,
	type LiveRunHandle,
	type StopQuestion,
} from "../stop-api.ts";

function makeRun(over: Partial<LiveRun> = {}): { run: LiveRun; aborted: () => number; asked: () => number } {
	let aborts = 0;
	let asks = 0;
	const run: LiveRun = {
		callId: over.callId ?? "call_root",
		role: over.role ?? "explore",
		task: over.task ?? "read the repo",
		startedAt: over.startedAt ?? 1_000,
		abort: () => {
			aborts++;
		},
		askStop:
			over.askStop ??
			(async () => {
				asks++;
				return true;
			}),
	};
	return { run, aborted: () => aborts, asked: () => asks };
}

const handles: LiveRunHandle[] = [];

function register(run: LiveRun): LiveRunHandle {
	const handle = registerRun(run);
	handles.push(handle);
	return handle;
}

/** A request from a client whose human already answered — the IDE's reason dialog, a confirmed shortcut. */
const answered = (callId: string, reason = "note") => ({ callId, reason, answered: true });

afterEach(() => {
	for (const handle of handles.splice(0)) handle.release();
});

describe("publishStopApi", () => {
	it("publishes the callable API itself under the well-known name, not a wrapper", () => {
		const api = publishStopApi();
		expect(stopApi()).toBe(api);
		// The contract a client in another extension reads: this exact shape, at this exact name.
		expect((globalThis as Record<symbol, unknown>)[SUBAGENT_STOP_KEY]).toBe(api);
		expect(api.version).toBe(SUBAGENT_STOP_API_VERSION);
		expect(typeof api.stop).toBe("function");
		expect(typeof api.running).toBe("function");
	});

	it("keeps one registry across a module reload, so a stop survives it", async () => {
		const api = publishStopApi();
		const { run, aborted } = makeRun({ callId: "call_reload" });
		const handle = register(run);
		// A reload hands out a fresh module instance; `ensureRegistry` must find the old API and the old map.
		expect(publishStopApi()).toBe(api);
		expect((await api.stop(answered("call_reload"))).ok).toBe(true);
		expect(aborted()).toBe(1);
		handle.release();
	});

	it("answers a client that asks before anything is running", () => {
		expect(publishStopApi().running()).toEqual([]);
	});
});

describe("addressing", () => {
	it("refuses a call id it does not own, and says which run is live", async () => {
		const { run, aborted } = makeRun();
		register(run);
		const result = await publishStopApi().stop(answered("call_other"));
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.code).toBe("unknown-call");
		expect(result.ok === false && result.error).toContain("call_root");
		expect(aborted()).toBe(0);
	});

	it("distinguishes nothing-running from a wrong address", async () => {
		await expect(publishStopApi().stop(answered("call_root"))).resolves.toMatchObject({
			ok: false,
			code: "no-run",
		});
	});

	it("reports nothing once the run retired, and never re-aborts a recycled id", async () => {
		const first = makeRun();
		const handle = register(first.run);
		handle.release();
		expect((await publishStopApi().stop(answered("call_root"))).ok).toBe(false);

		// A second registration under the same id is a different run; releasing the first must not retire it.
		const second = makeRun();
		register(second.run);
		handle.release();
		expect(publishStopApi().running().length).toBe(1);
		expect((await publishStopApi().stop(answered("call_root"))).ok).toBe(true);
	});
});

describe("asking", () => {
	it("asks the human when the request arrives with nobody answered", async () => {
		const { run, aborted } = makeRun();
		register(run);
		const result = await publishStopApi().stop({ callId: "call_root", reason: "note" });
		expect(result).toEqual({ ok: true, callId: "call_root", role: "explore", asked: true });
		expect(aborted()).toBe(1);
	});

	it("passes the question the human needs: role, elapsed work, and the sentence the parent will read", async () => {
		let question: StopQuestion | undefined;
		const { run } = makeRun({
			askStop: async (q) => {
				question = q;
				return true;
			},
		});
		register(run);
		await publishStopApi().stop({ callId: "call_root", reason: "Stopped by user with note: I did it myself" });
		expect(question).toEqual({
			role: "explore",
			task: "read the repo",
			elapsedSeconds: Math.max(0, Math.round((Date.now() - 1_000) / 1000)),
			reason: "Stopped by user with note: I did it myself",
		});
	});

	it("does not abort when the answer is not yes", async () => {
		for (const answer of [false]) {
			const { run, aborted } = makeRun({ askStop: async () => answer });
			register(run);
			const result = await publishStopApi().stop({ callId: "call_root", reason: "note" });
			expect(result.ok).toBe(false);
			expect(result.ok === false && result.code).toBe("not-answered");
			expect(aborted()).toBe(0);
		}
	});

	it("treats a dialog that cannot be drawn as no answer at all", async () => {
		const { run, aborted } = makeRun({
			askStop: async () => {
				throw new Error("no front-end");
			},
		});
		register(run);
		// An un-drawable question is an unanswered one: the caller gets a sentence, not another extension's stack.
		const result = await publishStopApi().stop({ callId: "call_root", reason: "note" });
		expect(result).toMatchObject({ ok: false, code: "not-answered" });
		expect(aborted()).toBe(0);
		// ...and a failed ask must not leave the slot stuck on "asking", or one broken dialog makes the run
		// unstoppable by anything else.
		const retried = publishStopApi().stop(answered("call_root"));
		expect((await retried).ok).toBe(true);
		expect(aborted()).toBe(1);
	});

	it("asks once: a second press while the dialog is open is refused", async () => {
		let release = () => undefined as void;
		const gate = new Promise<boolean>((resolve) => {
			release = () => resolve(true);
		});
		const { run, aborted } = makeRun({ askStop: () => gate });
		register(run);
		const first = publishStopApi().stop({ callId: "call_root", reason: "note" });
		const second = await publishStopApi().stop({ callId: "call_root", reason: "note again" });
		expect(second.ok).toBe(false);
		expect(second.ok === false && second.code).toBe("not-answered");
		expect(second.ok === false && second.error).toContain("already being asked");
		expect(aborted()).toBe(0);
		release();
		expect((await first).ok).toBe(true);
		expect(aborted()).toBe(1);
	});

	it("refuses to stop a run that finished while the question was on screen", async () => {
		const { run, aborted } = makeRun({ askStop: async () => true });
		const handle = register(run);
		const pending = publishStopApi().stop({ callId: "call_root", reason: "note" });
		handle.release();
		const result = await pending;
		expect(result).toMatchObject({ ok: false, code: "no-run" });
		expect(aborted()).toBe(0);
	});

	it("never asks a client whose human already answered", async () => {
		const asked = vi.fn(async () => true);
		const { run } = makeRun({ askStop: asked });
		register(run);
		expect((await publishStopApi().stop(answered("call_root"))).ok).toBe(true);
		expect(asked).not.toHaveBeenCalled();
	});
});

describe("the reason handoff", () => {
	it("gives the run the sentence the parent will read", async () => {
		const { run } = makeRun();
		const handle = register(run);
		await publishStopApi().stop(answered("call_root", "Stopped by user with note: enough"));
		expect(handle.takeStop()).toBe("Stopped by user with note: enough");
	});

	it("hands the reason to exactly one reader", async () => {
		const handle = register(makeRun().run);
		await publishStopApi().stop(answered("call_root", "note"));
		expect(handle.takeStop()).toBe("note");
		expect(handle.takeStop()).toBeUndefined();
	});

	it("writes its own sentence when the caller brought none", async () => {
		const handle = register(makeRun().run);
		await publishStopApi().stop(answered("call_root", ""));
		expect(handle.takeStop()).toContain("was stopped before it reported");
	});
});

describe("stopNote", () => {
	it("passes a caller's sentence through untouched — the vocabulary is the caller's", () => {
		expect(stopNote("Stopped by user with note: x")).toBe("Stopped by user with note: x");
		expect(stopNote("  padded  ")).toBe("padded");
	});

	it("substitutes for nothing but whitespace", () => {
		expect(stopNote(undefined)).toContain("was stopped before it reported");
		expect(stopNote("   ")).toContain("was stopped before it reported");
	});
});
