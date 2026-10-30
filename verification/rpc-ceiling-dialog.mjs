/**
 * Live verification of the ceiling dialog (`pi-subagent/ceiling.ts`): a child whose role budget is tiny must
 * stop at its turn limit and ask the human, through the parent, for an extension — and a granted extension has
 * to keep that same child running past the limit it just hit.
 *
 *   node verification/rpc-ceiling-dialog.mjs ["Extend by 20 turns / 5 min" | "Reject" | "no answer"] [project dir]
 *
 * It builds its own scratch agent dir (credentials copied, config written) so the run cannot touch your real
 * `~/.pi/agent/extensions/pi-gate/config.json` or your grants, and so the tiny `explore` budget needed to reach
 * a ceiling in seconds is nobody's config but this file's. The gate is set to allow everything: the dialog
 * under test is the ceiling's, not the gate's.
 *
 * Needs a live provider, so it consumes quota.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REAL_AGENT = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const REPO = new URL("../", import.meta.url).pathname;
const answerWith = process.argv[2] ?? "Extend by 20 turns";

// --- scratch agent dir: real credentials, a config whose only job is a budget the child will overrun -------
const agentDir = mkdtempSync(join(tmpdir(), "pi-ceiling-agent-"));
mkdirSync(join(agentDir, "extensions", "pi-gate"), { recursive: true });
for (const file of ["auth.json", "models.json"]) {
	if (existsSync(join(REAL_AGENT, file))) copyFileSync(join(REAL_AGENT, file), join(agentDir, file));
}
writeFileSync(join(agentDir, "settings.json"), existsSync(join(REAL_AGENT, "settings.json")) ? readFileSync(join(REAL_AGENT, "settings.json")) : "{}", "utf8");
writeFileSync(
	join(agentDir, "extensions", "pi-gate", "config.json"),
	JSON.stringify(
		{
			gate: { enabled: true, permission: { "*": "allow" } },
			subagent: { enabled: true, askToExtend: true, defaultRole: "explore", roles: { explore: { maxTurns: 2, timeoutMinutes: 1 } } },
		},
		undefined,
		2,
	),
	"utf8",
);

// --- scratch project: enough files that two turns cannot finish the task -------------------------------------
const project = process.argv[3] ?? mkdtempSync(join(tmpdir(), "pi-ceiling-proj-"));
mkdirSync(project, { recursive: true });
for (let i = 1; i <= 6; i++) writeFileSync(join(project, `note-${i}.md`), `# Note ${i}\n\nBody of note ${i}.\n`, "utf8");

const child = spawn(
	"pi",
	["--mode", "rpc", "--no-extensions", "--extension", `${REPO}/pi-gate/index.ts`, "--extension", `${REPO}/pi-subagent/index.ts`],
	{ cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["pipe", "pipe", "inherit"] },
);

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
const seen = [];

createInterface({ input: child.stdout }).on("line", (line) => {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (event.type === "extension_ui_request" && event.method === "select") {
		const isCeiling = String(event.title).startsWith("pi-subagent:");
		// "no answer" leaves the question standing: it must enforce the ceiling, after the dialog times out (FM-11).
		const chosen = answerWith === "no answer" ? undefined : (event.options ?? []).find((o) => o.toLowerCase().includes(answerWith.toLowerCase()));
		seen.push({ kind: isCeiling ? "ceiling" : "other", chosen });
		console.log(`\n[${isCeiling ? "CEILING DIALOG" : "other dialog"}] ${event.title}`);
		for (const option of event.options ?? []) console.log(`   option: ${option}`);
		if (!isCeiling && chosen === undefined) {
			console.error("   -> a non-ceiling dialog would go unanswered; the run would stall. Aborting.");
			process.exitCode = 2;
			child.kill("SIGTERM");
			process.exit(2);
		}
		console.log(`   -> ${chosen ?? "(left unanswered: Esc)"}`);
		if (chosen) setTimeout(() => send({ type: "extension_ui_response", id: event.id, value: chosen }), 200);
		return;
	}
	if (event.type === "extension_ui_request") return;
	if (event.type === "tool_execution_end") {
		const text = (event.result?.content ?? []).map((part) => part.text ?? "").join("\n");
		console.log(`\n[result ${event.toolName}]\n${text.slice(0, 900)}`);
		return;
	}
	if (event.type === "message_end") {
		for (const part of event.message?.content ?? []) {
			if (part.type === "toolCall") console.log(`[call] ${part.name} ${JSON.stringify(part.arguments).slice(0, 140)}`);
			if (part.type === "text" && part.text.trim()) console.log(`[assistant] ${part.text.slice(0, 200)}`);
		}
	}
	if (event.type === "agent_end") {
		console.log("[agent end]");
		finish();
	}
});

const finish = () => {
	console.log(`\ndialogs: ${JSON.stringify(seen)}`);
	console.log(`scratch agent dir: ${agentDir}\nscratch project: ${project}`);
	child.kill("SIGTERM");
	process.exit(0);
};

send({
	type: "prompt",
	message:
		"Call the subagent tool exactly once with role=explore and task=\"Read every .md file in this directory, one file per read call, and report each file's title as a list\". Then relay its answer verbatim.",
});
// "no answer" has to outlive the dialog's own 5-minute timeout before the ceiling is allowed to land.
setTimeout(finish, answerWith === "no answer" ? 8 * 60_000 : 180_000);
