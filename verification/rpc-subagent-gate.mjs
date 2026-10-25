/**
 * Milestone-B RPC verification: a subagent child's tool call must raise the gate dialog in the PARENT
 * (plan §11 A6/A7, M3), with the dialog titled by the owning subagent call.
 *   node /tmp/rpc-subagent.mjs ["Allow once" | "Abort"]
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PROJ = process.argv[3] ?? process.cwd();
const REPO = new URL("../", import.meta.url).pathname;
const answerWith = process.argv[2] ?? "Allow once";

const child = spawn(
	"pi",
	["--mode", "rpc", "--no-extensions", "--extension", `${REPO}/pi-gate/index.ts`, "--extension", `${REPO}/pi-subagent/index.ts`],
	{ cwd: PROJ, env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR }, stdio: ["pipe", "pipe", "inherit"] },
);

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
const answered = [];

createInterface({ input: child.stdout }).on("line", (line) => {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event.type === "extension_ui_request" && event.method === "select") {
		const chosen = (event.options ?? []).find((o) => o.includes(answerWith)) ?? event.options?.[0];
		answered.push(chosen);
		console.log(`\n[DIALOG] ${event.title}\n   -> ${chosen}`);
		setTimeout(() => send({ type: "extension_ui_response", id: event.id, value: chosen }), 120);
		return;
	}
	if (event.type === "extension_ui_request") return;
	if (event.type === "tool_execution_end") {
		console.log(`[result ${event.toolName}] ${JSON.stringify(event.result?.content ?? "").slice(0, 240)}`);
		return;
	}
	if (event.type === "message_end") {
		for (const part of event.message?.content ?? []) {
			if (part.type === "toolCall") console.log(`[call] ${part.name} ${JSON.stringify(part.arguments).slice(0, 110)}`);
			if (part.type === "text" && part.text.trim()) console.log(`[assistant] ${part.text.slice(0, 200)}`);
		}
	}
});

send({
	type: "prompt",
	message: "Call the subagent tool exactly once with role=explore and task='run the bash command: ls -la src, then report the two file names'. Then relay its answer.",
});
setTimeout(() => {
	console.log(`\nanswered dialogs: ${JSON.stringify(answered)}`);
	child.kill("SIGTERM");
	process.exit(0);
}, 55_000);
