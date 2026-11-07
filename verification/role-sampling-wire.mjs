/**
 * Live check: does a role's `sampling` block reach the request body a *child* sends?
 *
 * This is the one claim the unit tests cannot make on their own. `sampling.test.ts` asserts against pi's own
 * merge function, and the config parsing is asserted in `schema.test.ts` / `config-parity.test.ts`; what is
 * left unproven by those is the wiring in `index.ts` and the wire itself — that a child session started by
 * the real tool sends the role's parameters, and not the model's, the parent's, or nothing.
 *
 * So this runs the real chain against a fake OpenAI-compatible server that records what it was sent:
 * `pi-subagent/index.ts` → `runChild` → `createAgentSession` → pi's `openai-completions` adapter → HTTP.
 * Nothing touches `~/.pi/agent`: `PI_CODING_AGENT_DIR` points at a scratch dir holding `models.json` — one model
 * that declares its own `samplingParams`, to prove the precedence, and one Qwen-shaped model whose
 * `thinkingLevelMap` hides rungs and whose compat writes `enable_thinking`, for the level fold, the thinking-switch
 * warning and the level the card reports — plus the gate config with the roles.
 *
 *   node verification/role-sampling-wire.mjs
 *
 * No provider, no quota, no network: the "server" is this file.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = join(import.meta.dirname, "..");

/** A model that already declares sampling params, the way a real `models.json` entry does. */
const MODEL_PARAMS = { temperature: 1, top_p: 0.95, top_k: 40 };

const requests = [];

/** Stand-in for the parent's callable tools: `buildShims` needs at least one, and the child never calls it. */
const readTool = { name: "read", description: "read a file", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "" }] }) };

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		const parsed = JSON.parse(body || "{}");
		requests.push(parsed);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
		const chunk = (delta, finishReason = null) =>
			`data: ${JSON.stringify({ id: "resp-fake", object: "chat.completion.chunk", created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
		res.write(chunk({ role: "assistant", content: "The child reports: nothing to read." }));
		res.write(chunk({}, "stop"));
		if (parsed.stream_options?.include_usage) {
			res.write(`data: ${JSON.stringify({ id: "resp-fake", object: "chat.completion.chunk", created: 1, model: parsed.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\n`);
		}
		res.end("data: [DONE]\n\n");
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

/** A model that speaks the Qwen shape: `enable_thinking`, and a level map that hides three rungs. */
const QWEN = {
	id: "qwen",
	name: "Qwen-shaped",
	input: ["text"],
	reasoning: true,
	contextWindow: 100_000,
	maxTokens: 2048,
	compat: { thinkingFormat: "qwen", supportsReasoningEffort: true },
	thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null },
	samplingParams: MODEL_PARAMS,
	samplingParamsByThinkingLevel: { off: { temperature: 0.7 }, xhigh: { temperature: 1.0 } },
};

/** One scratch agent dir: the model, the gate config, and the role table under test. */
function agentDir(roles, models = []) {
	const dir = mkdtempSync(join(tmpdir(), "pi-sampling-agent-"));
	mkdirSync(join(dir, "extensions", "pi-gate"), { recursive: true });
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify(
			{
				providers: {
					echo: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: "test-key",
						models: [{ id: "fake", name: "Fake", input: ["text"], reasoning: true, contextWindow: 100_000, maxTokens: 2048, samplingParams: MODEL_PARAMS }, ...models],
					},
				},
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(dir, "extensions", "pi-gate", "config.json"),
		JSON.stringify({
			gate: { enabled: false, permission: { "*": "allow" } },
			subagent: { enabled: true, model: "inherit", defaultRole: "explore", askToExtend: false, roles },
		}),
	);
	return dir;
}

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { default: piSubagent } = await import(pathToFileURL(join(REPO, "pi-subagent", "index.ts")).href);

let tool;
piSubagent({
	registerTool: (definition) => (tool = definition),
	registerCommand: () => undefined,
	on: () => () => undefined,
});

/** Run one child, exactly as a parent session would, and hand back the body its request carried. */
async function runChild(roleConfig, sessionThinkingLevel, modelId = "fake", models = []) {
	const dir = agentDir({ explore: roleConfig }, models);
	process.env.PI_CODING_AGENT_DIR = dir;
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
	const model = runtime.getModel("echo", modelId);
	const cwd = mkdtempSync(join(tmpdir(), "pi-sampling-cwd-"));
	const before = requests.length;
	const notes = [];
	const ctx = {
		cwd,
		isProjectTrusted: () => false,
		model,
		thinkingLevel: sessionThinkingLevel,
		tools: [readTool], // a child with nothing callable would be refused by shims.ts; one read tool is enough
		modelRegistry: { getAll: () => [model], getAvailable: () => [model] },
		sessionManager: { getSessionDir: () => join(cwd, "sessions") },
		executeTool: async () => ({ content: [{ type: "text", text: "" }] }),
		ui: { notify: (text) => notes.push(text) },
		hasUI: true,
		signal: new AbortController().signal,
	};
	const result = await tool.execute("call-1", { role: "explore", task: "Report and stop." }, new AbortController().signal, undefined, ctx);
	return { body: requests[before] ?? {}, details: result.details, notes };
}

let failures = 0;
function check(label, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

console.log("--- role at thinking off: the flat block applies, the level block does not ---");
const flat = await runChild(
	{
		thinkingLevel: "off",
		sampling: { temperature: 0.2, min_p: 0.05, chat_template_kwargs: { use_audio: false } },
		samplingByThinkingLevel: { high: { temperature: 0.6 } },
	},
	"high",
);
check("temperature (role over models.json)", flat.body.temperature, 0.2);
check("min_p (server-only key, passed through)", flat.body.min_p, 0.05);
check("chat_template_kwargs (structured value)", flat.body.chat_template_kwargs, { use_audio: false });
check("top_p (unnamed, so the model's own value stands)", flat.body.top_p, 0.95);
check("top_k (unnamed, so the model's own value stands)", flat.body.top_k, 40);
check("the level block did not leak into thinking=off", flat.body.temperature !== 0.6, true);
check("the card reports it", flat.details.sampling, "temperature=0.2 · min_p=0.05 · chat_template_kwargs={\"use_audio\":false}");
console.log(`     body: ${JSON.stringify(flat.body)}`);

console.log("--- role at thinking high: the level block wins for the keys it names ---");
const levelled = await runChild(
	{ thinkingLevel: "high", sampling: { temperature: 0.2 }, samplingByThinkingLevel: { high: { temperature: 0.6 } } },
	"off",
);
check("temperature (level block over the flat one)", levelled.body.temperature, 0.6);
check("top_k still from the model", levelled.body.top_k, 40);
check("the session's level was replaced by the role's", levelled.body.reasoning_effort ?? levelled.body.thinking ?? "(provider field)", "high");
console.log(`     body: ${JSON.stringify(levelled.body)}`);

console.log("--- a sampling key that is not sampling: sent, and named as an override ---");
const hijacked = await runChild({ sampling: { model: "gpt-4-turbo", temperature: 0.1 } }, "off");
check("pi merges the bag over its own fields, so the request really did change", hijacked.body.model, "gpt-4-turbo");
check("and the human was told, not left to notice", hijacked.notes.some((note) => note.includes("overrides a field pi sets itself")), true);
console.log(`     notices: ${JSON.stringify(hijacked.notes)}`);

console.log("--- a level block for a level this model hides: folded onto the level that runs ---");
const folded = await runChild(
	{ thinkingLevel: "xhigh", sampling: { temperature: 0.2 }, samplingByThinkingLevel: { high: { top_p: 0.7, top_k: 7 }, xhigh: { top_k: 99 } } },
	"off",
	"qwen",
	[QWEN],
);
check("the level the model has, sent to the server", folded.body.reasoning_effort, "xhigh");
check("the thinking switch pi writes for this compat", folded.body.enable_thinking, true);
check("the role's own xhigh block wins the key it names", folded.body.top_k, 99);
check("the folded-in high block fills a key xhigh left open", folded.body.top_p, 0.7);
check("and the flat block still outranks the model's level entry", folded.body.temperature, 0.2);
check("the card says what ran", folded.details.sampling, "temperature=0.2 · top_p=0.7 · top_k=99");
console.log(`     body: ${JSON.stringify(folded.body)}`);

console.log("--- a role that names the thinking switch pi writes: sent, and named ---");
const crossed = await runChild({ thinkingLevel: "off", sampling: { enable_thinking: true } }, "off", "qwen", [QWEN]);
check("pi's own field really was overridden", crossed.body.enable_thinking, true);
check("no reasoning_effort: the level really is off", crossed.body.reasoning_effort, undefined);
check("naming it is told, not discovered on the wire", crossed.notes.some((note) => note.includes("enable_thinking overrides a field pi sets itself")), true);
console.log(`     notices: ${JSON.stringify(crossed.notes)}`);

console.log("--- the level the child ran at is reported when the model moved it ---");
const moved = await runChild({ thinkingLevel: "max", sampling: { temperature: 0.2 } }, "off", "qwen", [QWEN]);
check("max is not a level this model has, so the wire says xhigh", moved.body.reasoning_effort, "xhigh");
check("and the result names both", moved.details.thinking, 'max → xhigh (this model has no "max")');

console.log("--- a role that keeps the session's level says nothing about thinking ---");
const same = await runChild({ sampling: { temperature: 0.2 } }, "medium", "qwen", [QWEN]);
check("the session's level carried through", same.body.reasoning_effort, "medium");
check("no thinking line for an unremarkable run", same.details.thinking, undefined);

console.log(failures ? `\n${failures} FAILED` : "\nall good");
server.close();
process.exit(failures ? 1 : 0);
