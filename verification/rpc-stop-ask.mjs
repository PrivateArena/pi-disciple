/**
 * Live check of the stop that has to ask: `stop({ answered: false })` must put a real dialog in front of the
 * human, and only an explicit "Stop it" may end the child.
 *
 *   node verification/rpc-stop-ask.mjs "Keep it running"      # the child must finish its work
 *   node verification/rpc-stop-ask.mjs "Stop it"             # the child must come back stopped, with the note
 *
 * What it proves that no unit test can: the dialog crosses the RPC wire with its options intact and the body
 * lines readable (that is the text a human decides on), the answer arrives back as a decision rather than as a
 * string somebody guessed at, and a "keep running" answer leaves the run alone — the safe half of the rule.
 *
 * The gate's own approval prompts are answered with "Allow once" so the probe tests the stop and not the gate.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const REPO = new URL("../", import.meta.url).pathname;
const PROJ = process.argv[2] ?? process.cwd();
const answerWith = process.argv[3] ?? "Stop it";
const COMMAND = process.env.COMMAND || "sleep 300";

const child = spawn(
	"pi",
	[
		"--mode", "rpc", "--no-extensions",
		"-e", `${REPO}/pi-gate/index.ts`,
		"-e", `${REPO}/pi-subagent/index.ts`,
		"-e", `${REPO}/verification/stop-client.ts`,
	],
	{ cwd: PROJ, env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR }, stdio: ["pipe", "pipe", "inherit"] },
);

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
const seen = { dialogs: [], stoppedResult: null, settled: null };

createInterface({ input: child.stdout }).on("line", (line) => {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event.type === "extension_ui_request" && event.method === "select") {
		const isStop = (event.options ?? []).some((o) => o.includes("Keep it running"));
		const wanted = isStop ? answerWith : "Allow once";
		const chosen = (event.options ?? []).find((o) => o.includes(wanted)) ?? event.options?.[0];
		seen.dialogs.push({ kind: isStop ? "stop" : "other", chosen });
		console.log(`\n[${isStop ? "STOP DIALOG" : "other dialog"}]\n${event.title}\n   options: ${JSON.stringify(event.options)}\n   -> ${chosen}`);
		setTimeout(() => send({ type: "extension_ui_response", id: event.id, value: chosen }), 120);
		return;
	}
	if (event.type === "extension_ui_request") return;
	if (event.type === "tool_execution_end" && !event.parentToolCallId && event.toolName === "subagent") {
		seen.stoppedResult = {
			isError: event.isError,
			text: (event.result?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n"),
			stoppedBy: event.result?.details?.stoppedBy ?? null,
		};
		console.log(`[subagent result] ${JSON.stringify(seen.stoppedResult.text.split("\n").slice(0, 2).join(" ⏎ "))}`);
	}
	if (event.type === "agent_settled") seen.settled = { aborted: event.aborted };
});

send({
	type: "prompt",
	message:
		`Use the subagent tool with role "explore" and the task: "Run the bash command \`${COMMAND}\` exactly once, then report what it printed." ` +
		"Then tell me what the subagent reported.",
});

setTimeout(() => {
	const stopped = seen.stoppedResult;
	const yes = /stop it/i.test(answerWith);
	console.log("\n=== verdict ===");
	console.log(` - stop dialog shown to the human: ${seen.dialogs.some((d) => d.kind === "stop")}`);
	console.log(` - answered with: ${JSON.stringify(seen.dialogs)}`);
	console.log(` - parent's subagent result: ${stopped ? JSON.stringify(stopped.text.split("\n").slice(0, 2).join(" ⏎ ")) : "never came back"}`);
	console.log(` - details.stoppedBy: ${JSON.stringify(stopped?.stoppedBy ?? null)}`);
	console.log(` - run aborted (must be false either way): ${JSON.stringify(seen.settled)}`);
	console.log(
		yes
			? ` - expected: the child stopped, note on the report — got stoppedBy=${stopped?.stoppedBy !== null}`
			: ` - expected: the child kept working and reported normally — got stoppedBy=${JSON.stringify(stopped?.stoppedBy ?? null)} (must be null)`,
	);
	child.kill("SIGTERM");
	process.exit(0);
}, Number(process.env.PROBE_TIMEOUT || 120_000));
