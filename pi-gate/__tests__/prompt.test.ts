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
		grant: { surface: "bash", patterns: ["sudo rm *"], label: "sudo rm *", persisted: false },
		persistedGrant: { surface: "bash", patterns: ["sudo rm -rf /"], label: "sudo rm -rf /", persisted: true },
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
	it("are exactly the six scopes, index-aligned with CHOICES", () => {
		const labels = optionLabels(decision(), "/repo");
		expect(labels).toEqual([
			"Allow once",
			"Allow `sudo rm *` for this session",
			"Allow `sudo rm -rf /` exactly for this project (/repo)",
			"Allow `sudo rm -rf /` exactly for all projects",
			"Abort",
			"Abort with reason…",
		]);
		expect(labels).toHaveLength(CHOICES.length);
	});

	it("code-wraps the rule so markdown cannot reinterpret it", () => {
		const labels = optionLabels(decision(), "/repo");
		for (const label of labels.slice(1, 4)) expect(label).toContain("`");
	});

	it("keeps every scope on one short line however long the command is", () => {
		const long = `cd /repo && find . -name "*.ts" -not -path "*/node_modules/*" -exec grep -l "a very long pattern indeed" {} \\; && head -20`;
		const labels = optionLabels(
			decision({
				grant: { surface: "bash", patterns: ["cd *", "find *", "head *"], label: "cd * && find * && head *", persisted: false },
				persistedGrant: { surface: "bash", patterns: long.split(" && "), label: long, persisted: true },
			}),
			"/repo",
		);
		expect(labels[1]).toBe("Allow `cd * && find * && head *` for this session");
		for (const label of labels) {
			expect(label).not.toMatch(/\n/);
			expect(label.length).toBeLessThan(130);
		}
		expect(labels[2]).toContain("…");
	});

	it("marks a persisted grant as exact, in memory as a wildcard", () => {
		const labels = optionLabels(decision(), "/repo");
		expect(labels[1]).not.toContain("exactly");
		expect(labels[2]).toContain("exactly");
		expect(labels[3]).toContain("exactly");
	});

	it("falls back to a bare wildcard when nothing is grantable", () => {
		const labels = optionLabels(decision({ grant: undefined, persistedGrant: undefined }), "/repo");
		expect(labels[1]).toBe("Allow `*` for this session");
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

	it("code-wraps the command and every surfaced value", () => {
		const title = dialogTitle(decision({ checks: [{ surface: "external_directory", value: "/mnt/usb/_data_", action: "ask" }] }));
		expect(title).toContain("`sudo rm -rf /`");
		expect(title).toContain("`/mnt/usb/_data_`");
	});
});
