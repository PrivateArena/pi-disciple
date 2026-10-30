/**
 * The ceiling dialog (pi-subagent/ceiling.ts) and what the answers mean.
 *
 * The rules under test are the safety ones: only an explicit "Extend" extends, everything else enforces the
 * ceiling as if the feature did not exist, and the dialog's own timeout has to fit inside the window the hard
 * ceiling is held for — otherwise a question would outlive the run it was asked about.
 */

import { describe, expect, it } from "vitest";
import {
	CEILING_DIALOG_TIMEOUT_MS,
	CEILING_REJECT_LABEL,
	ceilingAnswerFor,
	ceilingLabels,
	ceilingTitle,
	createCeilingBroker,
	extensionLabel,
	EXTENSION_STEPS,
} from "../ceiling.ts";
import { CEILING_OFFER_HOLD_MS, type CeilingAsk, type CeilingAnswer } from "../child.ts";

function ask(overrides: Partial<CeilingAsk> = {}): CeilingAsk {
	return {
		reason: "maxTurns",
		role: "explore",
		task: "survey the gate",
		turns: 31,
		toolCalls: 12,
		lastTool: "bash",
		elapsedMs: 252_000,
		maxTurns: 30,
		timeoutMinutes: 20,
		...overrides,
	};
}

describe("the extension ladder", () => {
	it("offers the rungs the feature promises, reject first", () => {
		expect(EXTENSION_STEPS.map((step) => [step.turns, step.minutes])).toEqual([
			[20, 5],
			[40, 10],
			[60, 15],
			[100, 25],
		]);
		expect(ceilingLabels()).toEqual([CEILING_REJECT_LABEL, ...EXTENSION_STEPS.map(extensionLabel)]);
		expect(ceilingLabels()[1]).toBe("Extend by 20 turns / 5 min");
	});

	it("keeps a rung inside the budget a human could have configured", () => {
		// roles.ts floors a role at 200 turns / 120 min; one click must not exceed what the config may say.
		for (const step of EXTENSION_STEPS) expect(step.turns).toBeLessThanOrEqual(200);
		for (const step of EXTENSION_STEPS) expect(step.minutes).toBeLessThanOrEqual(120);
	});

	it("answers only its own labels with an extension", () => {
		for (const step of EXTENSION_STEPS) {
			const answer: CeilingAnswer = ceilingAnswerFor(extensionLabel(step));
			expect(answer).toEqual({ outcome: "granted", grant: { turns: step.turns, minutes: step.minutes } });
		}
		expect(ceilingAnswerFor(CEILING_REJECT_LABEL).outcome).toBe("rejected");
		// Esc, a dialog that timed out, a stray label: never an extension (FM-11).
		expect(ceilingAnswerFor(undefined).outcome).toBe("dismissed");
		expect(ceilingAnswerFor("").outcome).toBe("dismissed");
		expect(ceilingAnswerFor("Extend by 1000 turns / 500 min").outcome).toBe("rejected");
	});
});

describe("the dialog text", () => {
	it("names the role, the spent budget and the counters", () => {
		const title = ceilingTitle(ask());
		expect(title).toContain("pi-subagent: Explore — reached its limit of 30 turns");
		expect(title).toContain("turns: 31/30");
		expect(title).toContain("tool calls: 12");
		expect(title).toContain("elapsed: 4m 12s");
		expect(title).toContain("last: bash");
		expect(title).toContain('"Reject" ends it now');
	});

	it("says which budget ran out", () => {
		expect(ceilingTitle(ask({ reason: "timeout", timeoutMinutes: 20 }))).toContain("passed its 20 minute budget");
	});

	it("does not print the task, because the prompt would hide the options", () => {
		// The dialog asks a question with five answers. A delegation prompt is a paragraph, and a title that
		// scrolls the answers off the screen enforces the ceiling on a run the human meant to extend (FM-11).
		const task = "Read pi-gate/policy.ts and report:\n  1. the layers\n  2. the floors";
		const title = ceilingTitle(ask({ task }));
		expect(title).not.toContain("policy.ts");
		expect(title).not.toContain("task:");
		// Still carries the payload, so a frontend that has room can show it.
		expect(ask({ task }).task).toBe(task);
	});

	it("stays inside the three lines the question needs", () => {
		// Long roles or tools must not grow the title back into a wall of text.
		const title = ceilingTitle(ask({ role: "senior_it_architect_and_polyglot", lastTool: "bash" }));
		expect(title.split("\n")).toHaveLength(3);
	});
});

describe("createCeilingBroker", () => {
	function io(picked: string | undefined, calls: unknown[] = []) {
		return {
			select: async (title: string, labels: string[], opts: unknown) => {
				calls.push({ title, labels, opts });
				return picked;
			},
			notices: [] as [string, string | undefined][],
			notify(message: string, level?: "info" | "warning" | "error") {
				this.notices.push([message, level]);
			},
		};
	}

	it("refuses to ask with no UI, which is what keeps a headless run unchanged", async () => {
		const calls: unknown[] = [];
		const broker = createCeilingBroker({ hasUI: false, ui: io(undefined, calls) });
		await expect(broker(ask())).resolves.toEqual({ outcome: "no_ui" });
		expect(calls).toHaveLength(0);
	});

	it("passes a grant through and tells the human what the child may now spend", async () => {
		const host = io("Extend by 40 turns / 10 min");
		const seen: [string, CeilingAnswer][] = [];
		const broker = createCeilingBroker({ hasUI: true, ui: host, onOutcome: (reason, answer) => seen.push([reason, answer]) });
		await expect(broker(ask())).resolves.toEqual({ outcome: "granted", grant: { turns: 40, minutes: 10 } });
		expect(seen).toEqual([["maxTurns", { outcome: "granted", grant: { turns: 40, minutes: 10 } }]]);
		expect(host.notices[0]?.[0]).toMatch(/extended by 40 turns \/ 10 min — now 70 turns, 30 min/);
	});

	it("enforces on reject, dismissal and no UI alike, and notifies on none of them", async () => {
		for (const picked of [CEILING_REJECT_LABEL, undefined]) {
			const host = io(picked);
			const broker = createCeilingBroker({ hasUI: true, ui: host });
			const answer = await broker(ask());
			expect(answer.outcome).toBe(picked === undefined ? "dismissed" : "rejected");
			expect(host.notices).toEqual([]);
		}
	});

	it("takes an explicit timeout, where 0 means wait for a human", async () => {
		const seen: unknown[] = [];
		const host = io(CEILING_REJECT_LABEL, seen);
		await createCeilingBroker({ hasUI: true, ui: host })(ask());
		await createCeilingBroker({ hasUI: true, ui: host, timeoutMs: 0 })(ask());
		await createCeilingBroker({ hasUI: true, ui: host, timeoutMs: 1500 })(ask());
		expect(seen.map((call) => (call as { opts: { timeout?: number } }).opts.timeout)).toEqual([
			CEILING_DIALOG_TIMEOUT_MS,
			undefined,
			1500,
		]);
	});

	it("passes the labels and the abort signal through to pi's selector", async () => {
		const seen: unknown[] = [];
		const host = io(CEILING_REJECT_LABEL, seen);
		const controller = new AbortController();
		await createCeilingBroker({ hasUI: true, ui: host, signal: controller.signal })(ask());
		const sent = seen[0] as { title: string; labels: string[]; opts: { signal?: AbortSignal } };
		expect(sent.labels).toEqual(ceilingLabels());
		expect(sent.title).toContain("reached its limit of 30 turns");
		expect(sent.opts.signal).toBe(controller.signal);
	});

	it("answers inside the window the hard ceiling is held for", () => {
		// Otherwise the human is still being asked after the run was already abandoned.
		expect(CEILING_DIALOG_TIMEOUT_MS).toBeLessThan(CEILING_OFFER_HOLD_MS);
	});
});
