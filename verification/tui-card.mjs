/**
 * Verification: what pi's own terminal component actually draws for a subagent call.
 *
 * `probe-subagent-render.mjs` drives our renderers; this one drives pi's REAL `ToolExecutionComponent`
 * with them, which is the only way to see the card as the TUI shows it — including the states a unit
 * test cannot reach: arguments still streaming (`argsComplete: false`), the settled call, the expanded
 * card, and the pi-side fallback that swallows a throw. If a title loses the role here, the human never
 * sees it at all.
 *
 *   node verification/tui-card.mjs [width]
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const sdk = await import.meta.resolve("@earendil-works/pi-coding-agent");
const { initTheme, theme } = await import(new URL("./modes/interactive/theme/theme.js", sdk).href);
initTheme(process.env.PI_PROBE_THEME ?? "dark");
const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", sdk).href);
const { renderSubagentCall, renderSubagentResult } = await import(pathToFileURL(join(REPO, "pi-subagent", "render.ts")).href);
const { composeResult } = await import(pathToFileURL(join(REPO, "pi-subagent", "run.ts")).href);

/** The tool's renderer pair, wired the way `index.ts` wires it. */
const def = {
	name: "subagent",
	label: "subagent",
	renderCall: (args, t, ctx) => renderSubagentCall(args, t, { argsComplete: ctx?.argsComplete, expanded: ctx?.expanded }),
	renderResult: (result, options, t) => renderSubagentResult(result, options, t),
};
const ui = { requestRender() {} };
const task =
	"Read pi-subagent/render.ts and summarize what formatCallBlock prints, then say which line decides the role that appears in the card title.";
const result = composeResult(
	{
		text: "It prints the role first, then a summary of the task, on one line.",
		exit: "done",
		turns: 4,
		toolCalls: 6,
		childSessionFile: "/tmp/child.jsonl",
		childSessionId: "01a175a1",
		usage: { totalTokens: 4200 },
	},
	"explore",
	64_000,
	4100,
	{ task, model: "local/qwen3.8-flash-next (inherited)", nestedCalls: 6, shimTools: ["read"], activity: "read" },
);

const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
const width = Number(process.argv[2] ?? 100);
const component = (args) =>
	new ToolExecutionComponent("subagent", `call-${Math.random().toString(36).slice(2)}`, args, { outputPad: 1 }, def, ui, REPO);
function dump(label, c) {
	console.log(`\n--- ${label} ---`);
	for (const line of c.render(width)) console.log(`|${strip(line)}`);
}

const streaming = component({ task });
dump("arguments still streaming (role may still arrive)", streaming);

const running = component({ role: "explore", task });
running.setArgsComplete();
running.markExecutionStarted();
dump("settled arguments, child running", running);

running.updateResult({ content: result.content, details: result.details, isError: false, durationMs: 4100 });
dump("finished", running);

running.setExpanded(true);
dump("finished, expanded (whole task under the role)", running);

const defaulted = component({ task });
defaulted.setArgsComplete();
dump("no role in the arguments at all (default runs)", defaulted);
