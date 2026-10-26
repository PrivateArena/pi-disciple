/**
 * Probe: do pi-subagent's renderCall/renderResult actually produce lines for a frontend?
 *
 * The unit tests in pi-subagent/__tests__/render.test.ts assert strings against a fake theme. That
 * cannot fail the way a frontend fails: a frontend calls renderResult, then component.render(width),
 * and swallows any throw (pi's own ToolExecutionComponent and export-html tool-renderer both do
 * `catch { fallback }`). This probe drives the REAL pi-tui Text component with the REAL pi Theme and
 * prints what a frontend would get, or the throw it would swallow.
 *
 *   node verification/probe-subagent-render.mjs [width]
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const sdkIndex = await import.meta.resolve("@earendil-works/pi-coding-agent");
const themeModUrl = new URL("./modes/interactive/theme/theme.js", sdkIndex).href;
void pathToFileURL;

const { initTheme, theme } = await import(themeModUrl);
initTheme(process.env.PI_PROBE_THEME ?? "dark");

const { renderSubagentCall, renderSubagentResult, formatResultBlock } = await import(
	pathToFileURL(join(REPO, "pi-subagent", "render.ts")).href
);
const { composeResult, progressDetails } = await import(pathToFileURL(join(REPO, "pi-subagent", "run.ts")).href);

const report = [
	"## package.json summary",
	"",
	"- `name`: `pi-sub-gate`",
	"- `version`: `0.3.0`",
	"Scripts: `test`, `typecheck`.",
].join("\n");

// Built the way the tool builds them, so the probe shows exactly what a frontend receives.
const settledResult = composeResult(
	{
		text: report,
		exit: "done",
		turns: 5,
		toolCalls: 6,
		childSessionFile: "/tmp/child.jsonl",
		childSessionId: "01a175a1-9510",
		usage: { totalTokens: 4200 },
	},
	"explore",
	64_000,
	49_127,
	{ task: "Read package.json and summarize it", model: "local/qwen3.8-flash-next (inherited)", nestedCalls: 6, shimTools: ["read", "bash"], activity: "bash" },
);
const settledDetails = settledResult.details;

const runningDetails = progressDetails(
	{ turns: 2, toolCalls: 3, lastTool: "bash", elapsedMs: 12_000 },
	{ role: "explore", task: "Read package.json and summarize it", model: "local/qwen3.8-flash-next (inherited)", shimTools: ["read", "bash"], nestedCalls: 3 },
);

const width = Number(process.argv[2] ?? 100);
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function attempt(label, fn) {
	try {
		const out = fn();
		console.log(`\n=== ${label}: OK (${out.length} rendered lines) ===`);
		for (const line of out) console.log(`| ${strip(line)}`);
	} catch (error) {
		console.log(`\n=== ${label}: THREW -> a frontend falls back and shows nothing ===`);
		console.log(`    ${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)}`);
		if (error instanceof Error && error.stack) console.log(error.stack.split("\n").slice(1, 5).join("\n"));
	}
}

const runningResult = { content: [{ type: "text", text: "subagent running" }], details: runningDetails };
/** How pi's own ToolExecutionComponent calls a result renderer: content and details, nothing else. */
const asSeenByFrontend = (r) => ({ content: r.content, details: r.details, isError: r.isError });

console.log("=== settled details (what a frontend parses) ===");
console.log(JSON.stringify(settledDetails, null, 1));
console.log("\n=== running (partial) details ===");
console.log(JSON.stringify(runningDetails, null, 1));

attempt("renderCall(explore, task)", () => {
	const c = renderSubagentCall({ role: "explore", task: settledDetails.task }, theme);
	// A TUI renders components with a width; pi-tui Text also needs measure for some containers.
	if (typeof c.invalidate === "function") c.invalidate();
	return c.render(width);
});

for (const expanded of [false, true]) {
	attempt(`renderResult(settled, expanded=${expanded})`, () =>
		renderSubagentResult(asSeenByFrontend(settledResult), { expanded, isPartial: false }, theme).render(width),
	);
}
attempt("renderResult(running partial update)", () =>
	renderSubagentResult(runningResult, { expanded: false, isPartial: true }, theme).render(width),
);

// Same call shape pi's ToolExecutionComponent uses: only { content, details } reach the renderer.
attempt("formatResultBlock(settled, no usage field at all)", () => [formatResultBlock(settledDetails, settledResult, false, theme)]);
