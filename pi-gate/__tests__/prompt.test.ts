import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ask, CHOICES, dialogTitle, optionLabels } from "../prompt.ts";
import type { Decision } from "../policy.ts";

function decision(overrides: Partial<Decision> = {}): Decision {
	return {
		action: "ask",
		checks: [],
		floors: [],
		facts: { toolName: "bash", preview: "sudo rm -rf /", callId: "c", cwd: "/repo", surfaces: [["bash", ["sudo rm -rf /"]]], paths: [] },
		grant: { surface: "bash", patterns: ["sudo rm *"], label: "sudo rm *" },
		...overrides,
	} as Decision;
}

interface Captured {
	title?: string;
	options?: string[];
	selectOpts?: { signal?: AbortSignal; timeout?: number };
	inputs: { title: string; opts?: unknown }[];
}

function ctxWith(selectResult: string | undefined, inputResult: string | undefined, capture: Captured): ExtensionContext {
	return {
		ui: {
			select: async (title: string, options: string[], opts: { signal?: AbortSignal; timeout?: number }) => {
				capture.title = title;
				capture.options = options;
				capture.selectOpts = opts;
				return selectResult;
			},
			input: async (title: string, _placeholder?: string, opts?: unknown) => {
				capture.inputs.push({ title, opts });
				return inputResult;
			},
		},
	} as unknown as ExtensionContext;
}

afterEach(() => undefined);

describe("option labels", () => {
	it("are exactly the nine choices, index-aligned with CHOICES", () => {
		const labels = optionLabels(decision(), "/repo");
		expect(labels).toEqual([
			"Allow once",
			"Allow with reason…",
			"Allow `sudo rm *` for this session",
			"Allow `sudo rm *` for this project (/repo)",
			"Allow `sudo rm *` for all projects",
			"Abort",
			"Abort with reason…",
			"Allow everything for this session",
			"Allow everything for 5 minutes",
		]);
		expect(labels).toHaveLength(CHOICES.length);
	});

	it("code-wraps the rule so markdown cannot reinterpret it", () => {
		const labels = optionLabels(decision(), "/repo");
		for (const label of labels.slice(2, 5)) expect(label).toContain("`");
	});

	it("offers one identical rule for every scope — session, project and global", () => {
		const labels = optionLabels(decision(), "/repo");
		const rule = (label: string) => label.match(/`[^`]*`/)?.[0];
		expect(rule(labels[2])).toBe("`sudo rm *`");
		expect(rule(labels[3])).toBe(rule(labels[2]));
		expect(rule(labels[4])).toBe(rule(labels[2]));
		expect(labels.join("\n")).not.toMatch(/exactly/);
	});

	it("keeps the option list single-line, and puts the whole rule in the title instead", () => {
		const long = `sudo rm -rf /repo/node_modules ${"x".repeat(120)} --preserve-root`;
		const withLong = decision({ grant: { surface: "bash", patterns: [long], label: long } });
		const labels = optionLabels(withLong, "/repo");
		for (const label of labels) {
			expect(label).not.toMatch(/\n/);
			expect(label).not.toContain("[…truncated]");
		}
		expect(dialogTitle(withLong)).toContain(long);
	});

	it("shows the whole call in the title — nothing is cut with a truncation marker", () => {
		const long = `echo ${"y".repeat(900)} && cat pi-gate/prompt.ts`;
		const title = dialogTitle(decision({ facts: { toolName: "bash", preview: long, callId: "c", cwd: "/repo", surfaces: [["bash", [long]]], paths: [] } }));
		expect(title).toContain(long);
		expect(title).not.toContain("[…truncated]");
	});

	it("lists every surfaced fact, not the first four", () => {
		const checks = Array.from({ length: 6 }, (_, i) => ({ surface: `surface${i}`, value: `/very/long/path/${"z".repeat(200)}/file${i}.ts`, action: "ask" as const, specificity: 2 }));
		const title = dialogTitle(decision({ checks }));
		for (let i = 0; i < 6; i++) expect(title).toContain(`surface${i}`);
		expect(title).toContain("z".repeat(200));
	});

	it("falls back to a bare wildcard when nothing is grantable", () => {
		const labels = optionLabels(decision({ grant: undefined }), "/repo");
		expect(labels[2]).toBe("Allow `*` for this session");
	});
});

describe("ask", () => {
	it("maps the selected label back to its choice", async () => {
		const capture: Captured = { inputs: [] };
		const ctx = ctxWith("Allow once", undefined, capture);
		expect((await ask(ctx, decision(), { cwd: "/repo" })).choice).toBe("once");
		expect(capture.title).toContain("sudo rm -rf /");
	});

	it("treats a dismissal, Esc or timeout as abort, never as allow", async () => {
		const capture: Captured = { inputs: [] };
		const result = await ask(ctxWith(undefined, "ignored", capture), decision(), { cwd: "/repo" });
		expect(result.choice).toBe("abort");
		expect(capture.inputs).toHaveLength(0);
	});

	it("chains exactly one input for abort-with-reason", async () => {
		const capture: Captured = { inputs: [] };
		const ctx = ctxWith("Abort with reason…", "use the make target", capture);
		const result = await ask(ctx, decision(), { cwd: "/repo" });
		expect(result.choice).toBe("abort_reason");
		expect(result.reason).toBe("use the make target");
		expect(capture.inputs).toHaveLength(1);
		expect(capture.inputs[0]?.title).toMatch(/instead/);
	});

	it("chains one input for allow-with-reason and keeps the note", async () => {
		const capture: Captured = { inputs: [] };
		const ctx = ctxWith("Allow with reason…", "use the make target", capture);
		const result = await ask(ctx, decision(), { cwd: "/repo" });
		expect(result.choice).toBe("allow_reason");
		expect(result.reason).toBe("use the make target");
		expect(capture.inputs).toHaveLength(1);
		expect(capture.inputs[0]?.title).toMatch(/should know/);
	});

	it("escalates a dismissed note input to abort — Esc on the note never grants", async () => {
		const capture: Captured = { inputs: [] };
		const ctx = ctxWith("Allow with reason…", undefined, capture);
		expect((await ask(ctx, decision(), { cwd: "/repo" })).choice).toBe("abort");
	});

	it("keeps the allow itself when the note is entered empty", async () => {
		const capture: Captured = { inputs: [] };
		const ctx = ctxWith("Allow with reason…", "   ", capture);
		expect((await ask(ctx, decision(), { cwd: "/repo" })).choice).toBe("once");
	});

	it("falls back to a plain abort when the reason is empty", async () => {
		const capture: Captured = { inputs: [] };
		const ctx = ctxWith("Abort with reason…", "   ", capture);
		const result = await ask(ctx, decision(), { cwd: "/repo" });
		expect(result.choice).toBe("abort");
		expect(result.reason).toBeUndefined();
	});

	it("passes the abort signal and the configured timeout to the dialog", async () => {
		const capture: Captured = { inputs: [] };
		const controller = new AbortController();
		await ask(ctxWith("Allow once", undefined, capture), decision(), { cwd: "/repo", signal: controller.signal, timeoutMs: 5000 });
		expect(capture.selectOpts?.signal).toBe(controller.signal);
		expect(capture.selectOpts?.timeout).toBe(5000);
	});

	it("omits the timeout when the gate is configured to wait", async () => {
		const capture: Captured = { inputs: [] };
		await ask(ctxWith("Allow once", undefined, capture), decision(), { cwd: "/repo", timeoutMs: 0 });
		expect(capture.selectOpts?.timeout).toBeUndefined();
	});

	it("shows the escalated floors and the owning subagent in the title", async () => {
		const capture: Captured = { inputs: [] };
		const ctx = ctxWith("Allow once", undefined, capture);
		await ask(ctx, decision({ floors: ["wrapper"] }), { cwd: "/repo", sub: { role: "explore", task: "find the gate" } });
		expect(capture.title).toContain("floor: wrapper");
		expect(capture.title).toContain("subagent(explore)");
	});
});

describe("dialog title", () => {
	it("names the subagent that owns a nested call", () => {
		const title = dialogTitle(decision(), { role: "explore", task: "find the gate logic" });
		expect(title).toContain("from subagent(explore)");
		expect(title).toContain("find the gate logic");
	});

	it("shows every floor that raised the decision", () => {
		const flagged = decision();
		flagged.floors = ["protected_path", "wrapper"];
		expect(dialogTitle(flagged)).toContain("[floor: protected_path, wrapper]");
	});

	it("carries the allow-everything note when one is given", () => {
		expect(dialogTitle(decision(), undefined, "[gate] allow-everything is ON for this session")).toContain("allow-everything is ON");
		expect(dialogTitle(decision())).not.toContain("allow-everything");
	});

	it("code-wraps the command and every surfaced value", () => {
		const title = dialogTitle(decision({ checks: [{ surface: "external_directory", value: "/mnt/usb/_data_", action: "ask", specificity: 2 }] }));
		expect(title).toContain("`sudo rm -rf /`");
		expect(title).toContain("`/mnt/usb/_data_`");
	});
});
