/**
 * Live check: does `gate.guard` really keep a run alive after the model writes a tool call as text?
 *
 * The unit tests (`pi-gate/__tests__/guard.test.ts`) prove what the guard detects and what it returns. One
 * claim is left unproven by them, and it is the whole point of the feature: that Pi accepts a `turn_end`
 * boundary result of `{ entries: [custom_message], continue: true }`, runs another turn, and delivers that entry
 * to the model as a message. That claim lives in Pi's own loop, so only the real chain can settle it.
 *
 * So this runs: `pi-gate/index.ts` loaded as an extension by `createAgentSession` → Pi's agent loop → Pi's
 * `turn_end` boundary dispatch → Pi's `openai-completions` adapter → HTTP, against a fake server playing the
 * broken model. No provider, no quota, no network: the "server" is this file, and `PI_CODING_AGENT_DIR` points
 * at a scratch dir, so nothing touches `~/.pi/agent`.
 *
 * Two scenarios, because a continuation is only meaningful next to its absence:
 *
 *   with the guard on   → the run continues and the second request carries the reminder
 *   with the guard off  → the run stops on the malformed call, which is the bug being fixed
 *
 *   node verification/guard-turn-end.mjs
 */

import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");

/** What the broken model writes on its first turn: a call envelope on the text channel, and nothing else. */
const LEAKED_CALL = "Let me read that.\n<tool_call>\n<\n</function>\n</tool_call>";

/** What it writes once it has been told. */
const FIXED_ANSWER = "The file reads: 42.";

let requests = [];
let turns = 0;

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		const parsed = JSON.parse(body || "{}");
		requests.push(parsed);
		const text = ++turns === 1 ? LEAKED_CALL : FIXED_ANSWER;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
		const chunk = (delta, finishReason = null) =>
			`data: ${JSON.stringify({ id: "resp-fake", object: "chat.completion.chunk", created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
		res.write(chunk({ role: "assistant", content: text }));
		res.write(chunk({}, "stop"));
		if (parsed.stream_options?.include_usage) {
			res.write(`data: ${JSON.stringify({ id: "resp-fake", object: "chat.completion.chunk", created: 1, model: parsed.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\n`);
		}
		res.end("data: [DONE]\n\n");
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

/** A scratch agent dir with the real `pi-gate` loaded as an extension — its `.ts` files symlinked in. */
function makeAgentDir() {
	const dir = mkdtempSync(join(tmpdir(), "pi-guard-agent-"));
	const ext = join(dir, "extensions", "pi-gate");
	mkdirSync(ext, { recursive: true });
	for (const file of readdirSync(join(REPO, "pi-gate"))) {
		if (file.endsWith(".ts") && !file.startsWith("__")) symlinkSync(join(REPO, "pi-gate", file), join(ext, file));
	}
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
	return dir;
}

const { createAgentSession, ModelRuntime } = await import("@earendil-works/pi-coding-agent");

/** One run of the real chain: load pi-gate as an extension, ask, and report what the server was sent. */
async function probe(guard) {
	requests = [];
	turns = 0;
	const dir = makeAgentDir();
	const config = { gate: { enabled: true, permission: { "*": "allow" }, ...(guard === undefined ? {} : { guard }) }, subagent: { enabled: false } };
	writeFileSync(join(dir, "extensions", "pi-gate", "config.json"), JSON.stringify(config, null, 2));
	process.env.PI_CODING_AGENT_DIR = dir;

	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
	const model = runtime.getModel("echo", "fake");
	if (!model) throw new Error("the fake model was not registered");
	const cwd = mkdtempSync(join(tmpdir(), "pi-guard-cwd-"));
	const { session, extensionsResult } = await createAgentSession({ cwd, agentDir: dir, modelRuntime: runtime, model, noTools: "all" });
	if (extensionsResult.errors?.length) throw new Error(`extension load errors: ${extensionsResult.errors.map((e) => `${e.path}: ${e.error}`).join(" | ")}`);
	if (!extensionsResult.extensions.some((e) => String(e.path ?? "").includes("pi-gate"))) {
		throw new Error(`pi-gate was not loaded as an extension (loaded: ${extensionsResult.extensions.map((e) => e.path).join(", ") || "none"})`);
	}
	const assistantTexts = [];
	const sub = session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			assistantTexts.push(event.message.content.map((block) => block.text ?? block.type).join(""));
		}
	});
	await session.prompt("what is in the file?");
	sub();
	session.dispose();
	return { requests: [...requests], assistantTexts };
}

let ok = true;
const check = (label, pass, detail = "") => {
	console.log(`${pass ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	if (!pass) ok = false;
};

console.log("scenario 1: gate.guard on (remind)");
const on = await probe(undefined);
for (const [i, r] of on.requests.entries()) console.log(`  request ${i + 1}: ${r.messages.map((m) => m.role).join(" → ")}`);
const reminder = on.requests[1]?.messages?.find((m) => JSON.stringify(m).includes("Malformed tool call"));
check("the run continued past the malformed call", on.requests.length === 2, `requests: ${on.requests.length}`);
check("the reminder reached the model", !!reminder);
check("it arrives as a user message", reminder?.role === "user", `role: ${reminder?.role}`);
check("it names the fix", JSON.stringify(reminder).includes("tool interface"));
check("the broken message is still in context", JSON.stringify(on.requests[1]?.messages).includes("tool_call"));
check("the run finished on the answer, not on the markup", on.assistantTexts.at(-1) === FIXED_ANSWER, `last text: ${JSON.stringify(on.assistantTexts.at(-1))}`);
check("the model spoke twice: the leak, then the answer", on.assistantTexts.length === 2, `turns: ${on.assistantTexts.length}`);

console.log("\nscenario 2: gate.guard off");
const off = await probe({ enabled: false });
for (const [i, r] of off.requests.entries()) console.log(`  request ${i + 1}: ${r.messages.map((m) => m.role).join(" → ")}`);
check("without the guard the run stops on the malformed call", off.requests.length === 1, `requests: ${off.requests.length}`);
check("and nothing was ever reminded", !JSON.stringify(off.requests).includes("Malformed tool call"));
check("and the human got the markup as the answer", off.assistantTexts.at(-1)?.includes("<tool_call>") === true);

server.close();
process.exit(ok ? 0 : 1);
