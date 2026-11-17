/**
 * A stand-in *client* for the subagent stop API, for the RPC verification drivers.
 *
 * It is what Amulet's bridge is, minus the IDE: it waits for a `subagent` call to start, then asks pi-subagent to
 * stop that very run — and it deliberately does NOT claim a human already answered (`answered: false`), because
 * that is the path an IDE never exercises: the run's own extension has to put the question up itself, in whatever
 * room the session happens to be in. The driver beside this file prints the dialog and answers it.
 *
 * Load it beside the real extensions:
 *   pi --mode rpc --no-extensions -e pi-gate/index.ts -e pi-subagent/index.ts -e verification/stop-client.ts
 */

const STOP_KEY = Symbol.for("pi-subagent.stop");

/** How long after the child starts to ask. Slow enough that it is doing something worth interrupting. */
const ASK_AFTER_MS = Number(process.env.STOP_AT_MS || 4_000);

export default function stopClient(pi) {
	/** The `subagent` call being watched, so the stop can be addressed to it and to nothing else. */
	let running = null;
	/** One attempt per run: a second press would test the "already asked" guard instead of the dialog. */
	let attempted = false;

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName !== "subagent" || event.parentToolCallId) return;
		running = event.toolCallId;
		console.error(`[stop-client] watching ${running}; asking in ${ASK_AFTER_MS}ms`);
		setTimeout(async () => {
			if (attempted || !running) return;
			attempted = true;
			const api = globalThis[STOP_KEY];
			if (!api) {
				console.error("[stop-client] no stop API is published");
				return;
			}
			const result = await api.stop({
				callId: running,
				reason: "Stopped by user with note: the answer is in the README",
				answered: false,
			});
			console.error(`[stop-client] stop returned ${JSON.stringify(result)}`);
		}, ASK_AFTER_MS);
	});
}
