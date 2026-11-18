/**
 * Live reproduction of the aborted-subagent report, and the proof that it no longer reaches the parent.
 *
 * The bug, from the field (a local Qwen child, 40 minutes into an implementation task): the child writes its
 * next call as *text* — `Now I'll write the code. Starting with deps and lib.rs:\n[Tool call: bash]` — pi sees no
 * tool call, the child's run ends, and the parent's REPORT section shows exactly that sentence. The caller cannot
 * tell it from an answer. `tool_calls.txt` holds the real transcript line.
 *
 * What unit tests cannot settle is the claim this file exists for: that a steer queued from a `message_end`
 * subscriber is drained by pi's own loop before it stops, and that a second, tool-less `prompt()` on a session
 * that was just cut off really runs. That lives in pi's loop and the real child session, so this runs:
 *
 *   pi-subagent/index.ts + pi-gate/index.ts loaded as extensions → pi's agent loop → the shim's nested call →
 *   the ceiling/report machinery → the `openai-completions` adapter → HTTP, against a fake server playing the
 *   broken model. No provider, no quota, no network; `PI_CODING_AGENT_DIR` points at a scratch dir.
 *
 * Two scenarios, one per half of the fix:
 *
 *   1. the child corrects itself after the reminder, and reports
 *   2. the child writes markup again and again, so the tool-less final turn has to write the report
 *
 * In both, the assertion that matters is the same one the bug violated: what the parent reads back is a report,
 * never the child's narration about a call that never ran.
 *
 *   node verification/subagent-report-guarantee.mjs
 */

import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");

/** The emission from `tool_calls.txt`, verbatim: text where a call belonged, and a stop reason. */
const LEAKED_CALL = "Now I'll write the code. Starting with deps and lib.rs:\n[Tool call: bash]";

/** What the child says once it is told, and what the final turn makes it say. */
const FIXED_REPORT = "REPORT: read src/, 2 files, and ran echo. Nothing blocked.";
const RESCUED_REPORT = "RESCUED REPORT: I wrote lib.rs and mod.rs. cargo check was never run, and that is all I did.";

/** The role a request belongs to: only a child's system prompt says it is working *as* a subagent. */
const isChild = (body) => JSON.stringify(body.messages?.[0] ?? "").includes("subagent working in");

/** `parent` is a queue (delegate, then relay); `child` answers every child request however often it comes. */
let script = { parent: [], parentIndex: 0, child: null };
let requests = [];

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		const parsed = JSON.parse(body || "{}");
		requests.push(parsed);
		const child = isChild(parsed);
		const handler = child ? script.child : script.parent[script.parentIndex++];
		if (!handler) {
			// Anything the script did not foresee is a bug in the script: answer plainly and let the check fail loudly.
			return send(res, parsed, { text: "UNSCRIPTED REQUEST" });
		}
		handler(parsed, (choice) => send(res, parsed, choice));
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

function send(res, parsed, choice) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
	const chunk = (delta, finishReason = null) =>
		`data: ${JSON.stringify({ id: "resp-fake", object: "chat.completion.chunk", created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
	if (choice.toolCall) {
		res.write(
			chunk({
				role: "assistant",
				tool_calls: [{ index: 0, id: choice.toolCall.id ?? "call_fake_1", type: "function", function: { name: choice.toolCall.name, arguments: JSON.stringify(choice.toolCall.args ?? {}) } }],
			}),
		);
		res.write(chunk({}, "tool_calls"));
	} else {
		res.write(chunk({ role: "assistant", content: choice.text }));
		res.write(chunk({}, "stop"));
	}
	if (parsed.stream_options?.include_usage) {
		res.write(`data: ${JSON.stringify({ id: "resp-fake", object: "chat.completion.chunk", created: 1, model: parsed.model, choices: [], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } })}\n\n`);
	}
	res.end("data: [DONE]\n\n");
}

/** A scratch agent dir with both extensions loaded, their `.ts` files symlinked in. */
function makeAgentDir() {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagent-guarantee-agent-"));
	for (const name of ["pi-gate", "pi-subagent"]) linkExtension(join(REPO, name), join(dir, "extensions", name));
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({
			providers: {
				echo: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "test-key",
					models: [{ id: "fake", name: "Fake", input: ["text"], reasoning: false, contextWindow: 100_000, maxTokens: 2048 }],
				},
			},
		}),
	);
	mkdirSync(join(dir, "extensions", "pi-disciple"), { recursive: true });
	return dir;
}
/**
 * Mirror one extension's `.ts` tree into `<agentDir>/extensions/<name>`, whole. Symlinking only the root files
 * is not enough: the loaders resolve `./policy-resolution/fact-evaluation.ts` against the link, not the target,
 * so a subsystem directory that is not there is a module that cannot be found.
 */
function linkExtension(src, dest) {
	mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		if (entry.name === "__tests__") continue;
		if (entry.isDirectory()) linkExtension(join(src, entry.name), join(dest, entry.name));
		else if (entry.name.endsWith(".ts") || entry.name.endsWith(".json")) symlinkSync(join(src, entry.name), join(dest, entry.name));
	}
}

const { createAgentSession, ModelRuntime } = await import("@earendil-works/pi-coding-agent");

/**
 * One run of the real chain: the parent delegates, the child answers the way `script` says, and the tool
 * result the parent reads is what gets asserted on.
 */
async function probe(label, childReply) {
	const agentDir = makeAgentDir();
	const logDir = join(agentDir, "child-logs");
	writeFileSync(
		join(agentDir, "extensions", "pi-disciple", "config.json"),
		JSON.stringify(
			{
				gate: { enabled: true, permission: { "*": "allow" } },
				subagent: {
					enabled: true,
					defaultRole: "general-purpose",
					askToExtend: false,
					debugLog: true,
					debugLogDir: logDir,
					roles: { "general-purpose": { tools: ["bash"], maxTurns: 8, timeoutMinutes: 5 } },
				},
			},
			null,
			2,
		),
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
	const model = runtime.getModel("echo", "fake");
	if (!model) throw new Error("the fake model was not registered");
	const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-guarantee-cwd-"));
	const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model });
	if (extensionsResult.errors?.length) throw new Error(`extension load errors: ${extensionsResult.errors.map((e) => `${e.path}: ${e.error}`).join(" | ")}`);
	const loaded = (extensionsResult.extensions ?? []).map((e) => String(e.path ?? ""));
	for (const name of ["pi-gate", "pi-subagent"]) {
		if (!loaded.some((path) => path.includes(name))) throw new Error(`${name} was not loaded as an extension (loaded: ${loaded.join(", ") || "none"})`);
	}

	requests = [];
	script = {
		parentIndex: 0,
		child: childReply,
		parent: [
			// The parent delegates, once, and then relays.
			(_body, reply) => reply({ toolCall: { id: "call_sub", name: "subagent", args: { role: "general-purpose", task: "read src/ with bash and report the file names" } } }),
			(_body, reply) => reply({ text: "PARENT RELAYED IT" }),
		],
	};

	let toolResult = "";
	let toolDetails;
	const sub = session.subscribe((event) => {
		if (event.type !== "tool_execution_end") return;
		if (event.toolName !== "subagent") return;
		toolResult = (event.result?.content ?? []).map((part) => part.text ?? "").join("\n");
		toolDetails = event.result?.details;
	});
	await session.prompt("Call the subagent tool exactly once with role=general-purpose, then relay its answer.", { expandPromptTemplates: false });
	sub();
	session.dispose();

	const logs = existsSync(logDir) ? readdirSync(logDir).filter((name) => name.endsWith(".jsonl")) : [];
	const lines = logs.length ? readFileSync(join(logDir, logs[0]), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
	return { label, toolResult, toolDetails, requests: [...requests], lines, logs };
}

const textOf = (body) => JSON.stringify(body.messages ?? "");

let ok = true;
const check = (label, pass, detail = "") => {
	console.log(`${pass ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	if (!pass) ok = false;
};

console.log("scenario 1: the child writes its call as text, then corrects itself");
/** One scripted answer per child turn, with a hard cap so a broken chain cannot spin here either. */
function childScript(replies) {
	let turn = 0;
	return (body, reply) => {
		const step = replies[turn++] ?? (() => ({ text: "SCRIPT OVER" }));
		return reply(step(body));
	};
}

const fixed = await probe(
	"corrects",
	childScript([
		// 1. the call, written as text — the emission from `tool_calls.txt`
		() => ({ text: LEAKED_CALL }),
		// 2. reminded, so the call is really made
		() => ({ toolCall: { id: "call_bash", name: "bash", args: { command: "ls src" } } }),
		// 3. and the run ends with a report
		() => ({ text: FIXED_REPORT }),
	]),
);
const childRequests = fixed.requests.filter(isChild);
console.log(`  child requests: ${childRequests.length}; parent requests: ${fixed.requests.length - childRequests.length}`);
check("the child's run went on past the written-out call", childRequests.length >= 2, `requests: ${childRequests.length}`);
check("the reminder reached the model as a message", textOf(childRequests[1] ?? {}).includes("Malformed tool call"));
check("the log records the reminder", fixed.lines.some((line) => line.kind === "call_text_reminder"), fixed.lines.map((l) => l.kind).join(","));
check("the parent read a report", fixed.toolResult.includes(FIXED_REPORT), fixed.toolResult.slice(0, 120));
check("and never the narration it stopped on", !fixed.toolResult.includes("[Tool call: bash]"));
check("reported as the child's own report", fixed.toolDetails?.reportSource === "final", `source: ${fixed.toolDetails?.reportSource}`);

console.log("\nscenario 2: the child keeps writing calls, so the final turn writes the report");
// Every turn with tools writes markup, however many reminders it gets; only the tool-less final turn — a child
// request with no tools offered to it, which is what `requireFinalReport` asks for — can be talked into answering.
const stubborn = childScript([
	() => ({ text: LEAKED_CALL }),
	() => ({ text: LEAKED_CALL }),
	() => ({ text: LEAKED_CALL }),
	// The tool-less final turn: with no tools offered, it finally answers.
	({ tools }) => (tools?.length ? { text: LEAKED_CALL } : { text: RESCUED_REPORT }),
]);
const rescued = await probe("rescued", stubborn);
const rescueRequest = rescued.requests.find((body) => isChild(body) && !body.tools?.length);
const reminderSpent = rescued.requests.filter((body) => isChild(body) && !body.tools?.length);
console.log(`  child requests: ${rescued.requests.filter(isChild).length}; tool-less: ${reminderSpent.length}`);
check("the reminders stopped at the cap", rescued.lines.filter((line) => line.kind === "call_text_reminder").length === 2);
check("a tool-less final turn was really asked for", !!rescueRequest);
check("its prompt says the tools are off", JSON.stringify(rescueRequest?.messages?.at(-1) ?? "").match(/switched off/)?.length === 1);
check("the parent read the rescued report", rescued.toolResult.includes(RESCUED_REPORT), rescued.toolResult.slice(0, 160));
check("and never the markup", !rescued.toolResult.includes("[Tool call: bash]"));
check("the result says where the report came from", rescued.toolResult.includes("tool-less turn"));
check("details carry the source", rescued.toolDetails?.reportSource === "rescued", `source: ${rescued.toolDetails?.reportSource}`);
check("the child's ceiling never ran away", rescued.toolDetails?.exit === "done" || rescued.toolDetails?.exit === "timeout", `exit: ${rescued.toolDetails?.exit}`);
const finalTurn = rescued.lines.find((line) => line.kind === "final_report_end");
check("the final turn wrote the report, not the fragment it was called on", finalTurn?.detail?.status === "reported" && finalTurn?.detail?.text === RESCUED_REPORT, JSON.stringify(finalTurn?.detail?.status));
const runEnd = rescued.lines.find((line) => line.kind === "run_end");
check("the log closes with the run", runEnd?.detail?.reportSource === "rescued", JSON.stringify(runEnd?.detail ?? {}));

server.close();
process.exit(ok ? 0 : 1);
