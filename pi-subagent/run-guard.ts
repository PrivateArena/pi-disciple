/**
 * The run guard: the one-child-at-a-time rule and the process-global slot that holds it (plan step 15).
 *
 * Split out of `run.ts`, which keeps re-exporting its public surface as a facade. This is the only code in
 * the extension that holds process-global mutable state — `globalThis[Symbol.for("pi-subagent.run")]` — and it
 * shares no constant with the rest of `run.ts`: the guard is about *whether* a child may start, the rest of
 * `run.ts` is about what a finished child hands back.
 */

import type { RoleId } from "./roles.ts";

/**
 * One child at a time, stored on `globalThis` under a well-known symbol so a `/reload` — which
 * replaces the module registry but not the process — cannot start a second one (FM-14).
 */
export const RUN_GUARD_KEY = Symbol.for("pi-subagent.run");

export interface RunGuard {
	callId: string;
	role: RoleId;
	/** The role came from `subagent.defaultRole`, not from the model. Only the UI cares. */
	defaulted?: boolean;
	startedAt: number;
	abort: () => void;
}

type GuardStore = typeof globalThis & { [RUN_GUARD_KEY]?: RunGuard };

export function currentGuard(): RunGuard | undefined {
	return (globalThis as GuardStore)[RUN_GUARD_KEY];
}

/** Throws when another child holds the guard; the message tells the model what to do instead. */
export function claimGuard(guard: RunGuard): never | void {
	const running = currentGuard();
	if (running) {
		throw new Error(
			`pi-subagent: one subagent at a time — ${running.role} (call ${running.callId}) has been running for ` +
				`${Math.round((Date.now() - running.startedAt) / 1000)}s. Wait for it to finish or press Esc.`,
		);
	}
	(globalThis as GuardStore)[RUN_GUARD_KEY] = guard;
}

export function releaseGuard(callId: string): void {
	if (currentGuard()?.callId === callId) delete (globalThis as GuardStore)[RUN_GUARD_KEY];
}
