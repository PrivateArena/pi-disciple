/**
 * Milestone-A/B RPC verification (plan §11 A6, M2, OQ-1): drive `pi --mode rpc` with pi-gate loaded,
 * answer (or ignore) the gate dialog from the front-end, and report what happened.
 *   node /tmp/rpc-driver.mjs ["Allow once" | "Abort with reason" | "timeout"]
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PROJ = process.argv[3] ?? process.cwd();
const REPO = new URL("../", import.meta.url).pathname;
const answerWith = process.argv[2] ?? "Allow once";
const secondCommand = process.argv[4] ?? "git status --short && echo MORE";

const child = spawn("pi", ["--mode", "rpc", "--no-extensions", "--extension", `${REPO}/pi-gate/index.ts`], {
	cwd: PROJ,
	env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR },
	stdio: ["pipe", "pipe", "inherit"],
});

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
let dialogs = 0;

createInterface({ input: child.stdout }).on("line", (line) => {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event.type === "extension_ui_request" && event.method === "select") {
		dialogs++;
		console.log(`\n[DIALOG #${dialogs}] ${event.title}`);
		for (const option of event.options ?? []) console.log(`   option: ${option}`);
		if (answerWith === "timeout") {
			console.log("   -> leaving unanswered (promptTimeoutMs test)");
			return;
		}
		const options = event.options ?? [];
		const chosen = /^\d+$/.test(answerWith)
			? options[Number(answerWith)]
			: options.find((option) => option.toLowerCase().includes(answerWith.toLowerCase()));
		if (!chosen) {
			console.error(`\nno option matches "${answerWith}" — refusing to answer rather than skewing the run`);
			process.exitCode = 2;
			child.kill("SIGTERM");
			process.exit(2);
		}
		console.log(`   -> answering: ${chosen}`);
		setTimeout(() => send({ type: "extension_ui_response", id: event.id, value: chosen }), 200);
		return;
	}
	if (event.type === "extension_ui_request" && event.method === "input") {
		console.log(`[ui input] ${event.title}`);
		send({ type: "extension_ui_response", id: event.id, value: "use rg instead of grep, then stop" });
		return;
	}
	if (event.type === "extension_ui_request") return;
	if (event.type === "tool_execution_end") {
		console.log(`[tool result] ${JSON.stringify(event.result?.content ?? "").slice(0, 200)}`);
		return;
	}
	if (event.type === "agent_end") {
		console.log("[agent end]");
		askAgain();
		return;
	}
	if (event.type === "message_end") {
		for (const part of event.message?.content ?? []) {
			if (part.type === "toolCall") console.log(`[tool call] ${part.name} ${JSON.stringify(part.arguments).slice(0, 100)}`);
			if (part.type === "text" && part.text.trim()) console.log(`[assistant] ${part.text.slice(0, 160)}`);
		}
	}
});

send({ type: "prompt", message: "Run the bash command: ls -la src && echo DONE -- and tell me what it printed." });

// Second, identical prompt: an allow that was supposed to be remembered must make this turn dialog-free.
let prompts = 1;
const askAgain = () => {
	if (prompts > 1) return;
	prompts++;
	setTimeout(
		() =>
			send({
				type: "prompt",
				message: `Run this exact bash command now with the bash tool, never reuse earlier output: ${secondCommand} -- then tell me what it printed.`,
			}),
		400,
	);
};
setTimeout(() => {
	console.log(`\nprompts: ${prompts} · dialogs seen: ${dialogs} (second command: "${secondCommand}")`);
	child.kill("SIGTERM");
	process.exit(0);
}, 90_000);
