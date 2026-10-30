/**
 * `/subagentc` text — the config the human is shown, and the one thing they asked it to answer:
 * which model does a child run on, and where is that decided.
 */

import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { buildConfigView, buildModelCatalog, effectiveBudget, formatRunning, modelRef } from "../config-view.ts";
import { DEFAULT_LIMITS } from "../config-file.ts";
import { ROLES } from "../roles.ts";
import type { ChildModelResolution } from "../model-override.ts";

const model = (provider: string, id: string, reasoning = true): Model<any> =>
	({ provider, id, name: `${provider} ${id}`, reasoning, contextWindow: 200_000, maxTokens: 8_000 }) as unknown as Model<any>;

const SESSION = model("local", "qwen3.8-flash-next", false);
const PINNED = model("kilo", "kilo-auto/free");

const resolved = (m: Model<any>): ChildModelResolution => ({ status: "resolved", model: m, ref: `${m.provider}/${m.id}`, overridden: true });

function input(over: Partial<Parameters<typeof buildConfigView>[0]> = {}) {
	return {
		limits: DEFAULT_LIMITS,
		files: ["/home/u/.pi/agent/extensions/pi-gate/config.json"],
		defaultConfigFile: "/home/u/.pi/agent/extensions/pi-gate/config.json",
		errors: [],
		cwd: "/repo",
		trusted: true,
		sessionModel: SESSION,
		thinkingLevel: "high" as const,
		parentTools: ["read", "bash", "subagent", "edit"],
		sessionDir: "/repo/.pi/sessions/abc",
		...over,
	};
}

describe("/subagentc config view", () => {
	it("names the inherited model when nothing is pinned", () => {
		const view = buildConfigView(input());
		expect(view).toContain("child model: local/qwen3.8-flash-next (inherited from the session model)");
		expect(view).toContain("subagent.model: not set");
		expect(view).not.toContain("NOT RESOLVED");
	});

	it("shows the pin, the file it came from, and what it resolves to", () => {
		const view = buildConfigView(
			input({
				limits: { ...DEFAULT_LIMITS, model: "kilo/kilo-auto/free" },
				origins: { model: "/repo/.pi/extensions/pi-gate/config.json" },
				files: ["/home/u/.pi/agent/extensions/pi-gate/config.json", "/repo/.pi/extensions/pi-gate/config.json"],
				pin: { reference: "kilo/kilo-auto/free", resolution: resolved(PINNED) },
			}),
		);
		expect(view).toContain("child model: kilo/kilo-auto/free (pinned by subagent.model)");
		expect(view).toContain('subagent.model: "kilo/kilo-auto/free" (from /repo/.pi/extensions/pi-gate/config.json) -> kilo/kilo-auto/free');
	});

	it("says so when a pin does not resolve, and keeps the inherited model in the headline", () => {
		const view = buildConfigView(
			input({
				limits: { ...DEFAULT_LIMITS, model: "kilo/nope" },
				pin: { reference: "kilo/nope", resolution: { status: "error", message: 'model "nope" not found for provider "kilo"' } },
			}),
		);
		expect(view).toContain("child model: local/qwen3.8-flash-next");
		expect(view).toContain("NOT RESOLVED, the child stays on the session model");
		expect(view).toContain('model "nope" not found for provider "kilo"');
	});

	it("forces the child thinking level off for a non-reasoning model and says why", () => {
		expect(buildConfigView(input())).toContain('child thinking level: off (session asks "high", the model has no such level)');
	});

	it("labels the source of every limit, default included", () => {
		const view = buildConfigView(input({ limits: { ...DEFAULT_LIMITS, maxTurns: 4 }, origins: { maxTurns: "/repo/.pi/x.json" } }));
		expect(view).toMatch(/maxTurns\s+4 \(a ceiling[^·]*·\s+from \/repo\/\.pi\/x\.json/);
		expect(view).toMatch(/timeoutMinutes\s+20 \(a ceiling[^·]*·\s+from built-in default/);
	});

	it("states the deadline model: ceiling, settle, and a report that is never cut", () => {
		const view = buildConfigView(input());
		expect(view).toContain("at the role's minutes the child is told to conclude; 60s later the ceiling fires");
		expect(view).toContain("never cut mid-report or mid-tool-call");
		expect(view).toContain("Longest possible run: budget + 4 min");
	});

	it("expands a role's \"*\" to the parent's callable tools and caps the budget", () => {
		const view = buildConfigView(input({ limits: { ...DEFAULT_LIMITS, maxTurns: 5, timeoutMinutes: 3 } }));
		expect(view).toContain("tools: * → read, bash, edit — the parent's 3 callable tool(s)");
		expect(view).toContain("→ effective 5 turns · 3 min (capped by subagent.maxTurns/timeoutMinutes)");
		expect(view).not.toContain("subagent, edit");
	});

	it("keeps the project file marked and warns when the cwd is untrusted", () => {
		const view = buildConfigView(
			input({ files: ["/home/u/.pi/agent/extensions/pi-gate/config.json", "/repo/.pi/extensions/pi-gate/config.json"], cwd: "/repo" }),
		);
		expect(view).toContain("/repo/.pi/extensions/pi-gate/config.json · project scope");
		expect(buildConfigView(input({ trusted: false }))).toContain("project scope ignored: this cwd is not trusted");
	});

	it("reports config errors instead of hiding them", () => {
		const view = buildConfigView(input({ errors: ["/x/config.json: subagent.maxTurns must be a positive number, ignored"] }));
		expect(view).toContain("problems (1):");
		expect(view).toContain("must be a positive number");
	});

	it("shows the default role and the delegation switch, since both change what the model gets", () => {
		const view = buildConfigView(input({ limits: { ...DEFAULT_LIMITS, defaultRole: "explore", delegationPrompt: false } }));
		expect(view).toContain("defaultRole");
		expect(view).toContain("explore — what a call gets when the model names no role");
		expect(view).toContain("delegationPrompt");
		expect(view).toContain("off — subagent.delegationPrompt: false");
		expect(buildConfigView(input())).toContain("delegation prompt: on");
		// The roles list must mark the role an unnamed call actually gets.
		expect(buildConfigView(input({ limits: { ...DEFAULT_LIMITS, defaultRole: "review" } }), "roles")).toContain("review · Critique of existing code, plans or diffs · the default for an unnamed call");
	});

	it("shows the running child, and says what \"none\" means", () => {
		const view = buildConfigView(input({ running: { callId: "c1", role: "explore", startedAt: 1_000, abort: () => undefined }, now: 46_000 }));
		expect(view).toContain("running: explore for 45s (call c1)");
		expect(buildConfigView(input())).toContain("running: none");
		expect(formatRunning(undefined)).toContain("only ever filled during a run");
		expect(formatRunning({ callId: "c2", role: "general-purpose", defaulted: true, startedAt: 1_000, abort: () => undefined }, 2_000)).toContain("general-purpose (default role) for 1s");
	});

	it("prints one section on its own", () => {
		const view = buildConfigView(input(), "model");
		expect(view.startsWith("pi-subagent · model")).toBe(true);
		expect(view).not.toContain("roles (built-ins");
		expect(view).toContain("config files read");
	});

	it("computes effective budgets and refs", () => {
		expect(effectiveBudget(ROLES["general-purpose"], DEFAULT_LIMITS)).toEqual({ turns: 30, minutes: 20 });
		expect(modelRef(undefined)).toContain("none selected");
	});
});

describe("/subagentc models", () => {
	it("lists provider/id refs and flags the session model, the pin and the missing auth", () => {
		const catalog = buildModelCatalog([PINNED, SESSION, model("openrouter", "minimax-m3.1", true)], {
			sessionModel: SESSION,
			pinnedRef: "kilo/kilo-auto/free",
			available: new Set(["local/qwen3.8-flash-next"]),
		});
		expect(catalog).toContain("kilo/kilo-auto/free");
		expect(catalog).toContain("local/qwen3.8-flash-next · local qwen3.8-flash-next · 200k · session model, non-reasoning (child thinking forced off)");
		expect(catalog).toMatch(/openrouter\/minimax-m3\.1.*no auth configured/);
		expect(catalog).toContain("pinned as subagent.model");
		expect(catalog.indexOf("kilo/")).toBeLessThan(catalog.indexOf("local/"));
	});
});

describe("the ceiling switch", () => {
	it("shows the switch, the ladder it unlocks, and the window the clock holds", () => {
		const view = buildConfigView(input({}));
		expect(view).toContain("askToExtend");
		expect(view).toContain("+20t/+5m · +40t/+10m · +60t/+15m · +100t/+25m");
		expect(view).toContain("One dialog per run is allowed at a spent budget");
	});

	it("says so when the human turned it off", () => {
		const view = buildConfigView(input({ limits: { ...DEFAULT_LIMITS, askToExtend: false } }));
		expect(view).toContain("no — a spent budget ends the run as it always did");
		expect(view).toContain("subagent.askToExtend is off");
	});
});
