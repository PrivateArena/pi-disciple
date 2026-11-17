/**
 * The ceiling dialog (pi-subagent/ceiling.ts) and what the answers mean.
 *
 * The rules under test are the safety ones: only an explicit "Extend" extends, everything else enforces the
 * ceiling as if the feature did not exist, and the dialog's own timeout has to fit inside the window the hard
 * ceiling is held for — otherwise a question would outlive the run it was asked about.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	CEILING_DIALOG_TIMEOUT_MS,
	CEILING_REJECT_LABEL,
	ceilingAnswerFor,
	ceilingLabels,
	ceilingTitle,
	createCeilingBroker,
	extensionLabel,
	EXTENSION_STEPS,
	mergeExtensionSteps,
	resolveExtensionSteps,
	type ExtensionStep,
} from "../ceiling.ts";
import { CEILING_OFFER_HOLD_MS, type CeilingAsk, type CeilingAnswer } from "../child.ts";
import { MAX_EXTEND_OPTIONS, ROLE_TIMEOUT_CEILING_MINUTES, ROLE_TURNS_CEILING } from "../config-file.ts";

/** The ladder as `[turns, minutes]` pairs, which is how every expectation here reads it. */
function rungs(steps: readonly ExtensionStep[]): [number, number][] {
	return steps.map((step) => [step.turns, step.minutes]);
}

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

/** A fake `ctx.ui` that answers with one label, recording what it was asked. */
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

describe("the ladder a config writes (subagent.extendOptions)", () => {
	it("merges written rungs over the shipped ladder by turns and sorts smallest-first", () => {
		// A named `turns` retunes that rung, an unseen one adds a rung, and everything else stands.
		expect(rungs(resolveExtensionSteps([{ turns: 50, minutes: 15 }, { turns: 20, minutes: 10 }]))).toEqual([
			[20, 10],
			[40, 10],
			[50, 15],
			[60, 15],
			[100, 25],
		]);
		expect(rungs(resolveExtensionSteps())).toEqual(rungs(EXTENSION_STEPS));
	});

	it("drops the turn counts subagent.disableExtendTurns names, after the merge", () => {
		expect(rungs(resolveExtensionSteps(undefined, [60, 100]))).toEqual([
			[20, 5],
			[40, 10],
		]);
		// A rung the same config adds is droppable too, which is what lets a project file undo the global one.
		expect(rungs(resolveExtensionSteps([{ turns: 150, minutes: 45 }], [20, 150]))).toEqual([
			[40, 10],
			[60, 15],
			[100, 25],
		]);
		expect(resolveExtensionSteps(undefined, EXTENSION_STEPS.map((step) => step.turns))).toEqual([]);
	});

	it("leaves the shipped ladder untouched when nothing is written", () => {
		const merged = mergeExtensionSteps(EXTENSION_STEPS, []);
		expect(merged).toEqual(rungs(EXTENSION_STEPS).map(([turns, minutes]) => ({ turns, minutes })));
		// The copy is the ladder's own, so a caller cannot write through it into the shipped constant.
		merged[0]!.minutes = 999;
		expect(EXTENSION_STEPS[0]!.minutes).toBe(5);
	});

	it("offers the config's rungs and grants exactly what the chosen one says", async () => {
		const steps = resolveExtensionSteps([{ turns: 200, minutes: 120 }]);
		const host = io("Extend by 200 turns / 120 min");
		const broker = createCeilingBroker({ hasUI: true, ui: host, steps });
		await expect(broker(ask())).resolves.toEqual({ outcome: "granted", grant: { turns: 200, minutes: 120 } });
		expect(host.notices[0]?.[0]).toMatch(/extended by 200 turns \/ 120 min — now 230 turns, 140 min/);
	});

	it("refuses a label of some other ladder", async () => {
		// The answer must name a rung this run showed: a frontend replaying an old or foreign label cannot buy rope.
		const host = io("Extend by 20 turns / 5 min");
		const broker = createCeilingBroker({ hasUI: true, ui: host, steps: resolveExtensionSteps(undefined, [20]) });
		await expect(broker(ask())).resolves.toEqual({ outcome: "rejected" });
		expect(host.notices).toEqual([]);
	});

	it("falls back to the shipped rungs when a config left the ladder empty", async () => {
		const seen: unknown[] = [];
		const host = io(CEILING_REJECT_LABEL, seen);
		await createCeilingBroker({ hasUI: true, ui: host, steps: [] })(ask());
		expect((seen[0] as { labels: string[] }).labels).toEqual(ceilingLabels());
	});

	it("shows and answers only the largest rungs a crowded config writes", async () => {
		// Reject plus the rungs is the whole question, and a rung the human cannot see cannot be chosen (FM-11) —
		// so the cap belongs to the dialog, not only to the config reader that reports it.
		const crowded = resolveExtensionSteps([150, 160, 170, 180, 190, 200].map((turns) => ({ turns, minutes: 60 })));
		expect(crowded).toHaveLength(EXTENSION_STEPS.length + 6);
		const seen: unknown[] = [];
		const host = io(extensionLabel(crowded[crowded.length - 1]!), seen);
		const broker = createCeilingBroker({ hasUI: true, ui: host, steps: crowded });
		await expect(broker(ask())).resolves.toEqual({ outcome: "granted", grant: { turns: 200, minutes: 60 } });
		expect((seen[0] as { labels: string[] }).labels).toHaveLength(MAX_EXTEND_OPTIONS + 1);
		// The smallest rungs are the ones the cap removed, and their labels no longer buy anything.
		expect(ceilingAnswerFor(extensionLabel(crowded[0]!), crowded).outcome).toBe("rejected");
		expect(ceilingLabels(crowded)[1]).toBe(extensionLabel(crowded[2]!));
	});

	it("ships its rungs, its bounds and its cap written out in the config file", () => {
		// `config.json` spells the shipped ladder, the two ceilings and the cap inside `==extendOptions`, which is
		// where a human reads them; a ladder, bound or cap changed in code without the file is the file lying about
		// the dialog — and a lie about the ceiling is a human trusting the wrong number for more rope.
		const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../../config.json", import.meta.url)), "utf8"));
		const note = String(raw.subagent["==extendOptions"]);
		expect(note).toContain(EXTENSION_STEPS.map((step) => `${step.turns}/${step.minutes}`).join(", "));
		expect(note).toContain(`turns 1..${ROLE_TURNS_CEILING}, minutes 1..${ROLE_TIMEOUT_CEILING_MINUTES}`);
		expect(note).toContain(`capped at ${MAX_EXTEND_OPTIONS} rungs`);
		expect(String(raw.subagent["==disableExtendTurns"])).toContain("extendOptions merges");
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
