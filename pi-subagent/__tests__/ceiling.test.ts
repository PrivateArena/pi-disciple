/**
 * The ceiling dialog (pi-subagent/ceiling.ts) and what the answers mean.
 *
 * The rules under test are the safety ones: only an explicit "Extend" extends, everything else enforces the
 * ceiling as if the feature did not exist, and the dialog's own timeout has to fit inside the window the hard
 * ceiling is held for — otherwise a question would outlive the run it was asked about. The session menu is the one
 * rule that outlives a run, so these tests also pin that it takes an explicit choice to set and is never applied
 * when it is no longer a rung the dialog could have offered.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	CEILING_DIALOG_TIMEOUT_MS,
	CEILING_REJECT_LABEL,
	CEILING_RUN_MENU_LABEL,
	CEILING_SESSION_FORGET_LABEL,
	CEILING_SESSION_MENU_LABEL,
	ceilingAnswerFor,
	ceilingLabels,
	ceilingPickFor,
	ceilingTitle,
	createCeilingBroker,
	extensionLabel,
	EXTENSION_STEPS,
	resolveExtensionSteps,
	sessionExtensionLabel,
	type ExtensionStep,
} from "../ceiling.ts";
import { createSessionBudget } from "../budget/session-budget.ts";
import { CEILING_OFFER_HOLD_MS, type CeilingAnswer, type CeilingAsk } from "../child.ts";
import { EXTEND_TURNS_CEILING, MAX_EXTEND_OPTIONS, ROLE_TIMEOUT_CEILING_MINUTES } from "../config-file.ts";

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

/** The same, answering each select from a queue — a menu switch is two questions, not one. */
function queue(picked: (string | undefined)[], calls: unknown[] = []) {
	const host = io(undefined, calls);
	let index = 0;
	host.select = async (title: string, labels: string[], opts: unknown) => {
		calls.push({ title, labels, opts });
		return picked[Math.min(index++, picked.length - 1)];
	};
	return host;
}

describe("the extension ladder", () => {
	it("offers the rungs the feature promises, reject first and the session switch last", () => {
		expect(EXTENSION_STEPS.map((step) => [step.turns, step.minutes])).toEqual([
			[20, 5],
			[40, 10],
			[60, 15],
			[100, 25],
		]);
		expect(ceilingLabels()).toEqual([CEILING_REJECT_LABEL, ...EXTENSION_STEPS.map(extensionLabel), CEILING_SESSION_MENU_LABEL]);
		expect(ceilingLabels()[1]).toBe("Extend by 20 turns / 5 min");
	});

	it("keeps a shipped rung inside the budget a role may be configured to name", () => {
		// The shipped ladder stays modest; only a human-written `subagent.extendOptions` may reach past it.
		for (const step of EXTENSION_STEPS) expect(step.turns).toBeLessThanOrEqual(200);
		for (const step of EXTENSION_STEPS) expect(step.minutes).toBeLessThanOrEqual(ROLE_TIMEOUT_CEILING_MINUTES);
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
		// Switching menus is not an answer, and `ceilingAnswerFor` has no menu to switch to.
		expect(ceilingAnswerFor(CEILING_SESSION_MENU_LABEL).outcome).toBe("rejected");
	});
});

describe("the ladder a config writes (subagent.extendOptions)", () => {
	it("replaces the shipped ladder and sorts the written rungs smallest-first", () => {
		// What the human wrote is what the dialog shows: no shipped rung is merged in behind the list.
		expect(rungs(resolveExtensionSteps([{ turns: 50, minutes: 15 }, { turns: 20, minutes: 10 }]))).toEqual([
			[20, 10],
			[50, 15],
		]);
		expect(rungs(resolveExtensionSteps())).toEqual(rungs(EXTENSION_STEPS));
		// A written rung of a shipped turn count does not retune it from behind — it *is* the ladder now.
		expect(rungs(resolveExtensionSteps([{ turns: 20, minutes: 10 }]))).toEqual([[20, 10]]);
		// Two rungs of one turn count would print the same choice twice, and only the first could ever be picked.
		expect(rungs(resolveExtensionSteps([{ turns: 40, minutes: 10 }, { turns: 40, minutes: 15 }]))).toEqual([[40, 15]]);
	});

	it("drops the turn counts subagent.disableExtendTurns names, after the replacement", () => {
		expect(rungs(resolveExtensionSteps(undefined, [60, 100]))).toEqual([
			[20, 5],
			[40, 10],
		]);
		// A rung the same config adds is droppable too, which is what lets a project file undo the global one.
		expect(rungs(resolveExtensionSteps([{ turns: 150, minutes: 45 }, { turns: 20, minutes: 5 }], [20]))).toEqual([[150, 45]]);
		expect(resolveExtensionSteps(undefined, EXTENSION_STEPS.map((step) => step.turns))).toEqual([]);
	});

	it("copies the ladder it returns, so no caller writes into the shipped constant", () => {
		const ladder = resolveExtensionSteps();
		ladder[0]!.minutes = 999;
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
		// Reject, the rungs and the session switch is the whole question, and a rung the human cannot see cannot be
		// chosen (FM-11) — so the cap belongs to the dialog, not only to the config reader that reports it.
		const crowded = resolveExtensionSteps([120, 130, 140, 150, 160, 170, 180, 190, 200, EXTEND_TURNS_CEILING].map((turns) => ({ turns, minutes: 60 })));
		expect(crowded).toHaveLength(10);
		const seen: unknown[] = [];
		const host = io(extensionLabel(crowded[crowded.length - 1]!), seen);
		const broker = createCeilingBroker({ hasUI: true, ui: host, steps: crowded });
		await expect(broker(ask())).resolves.toEqual({ outcome: "granted", grant: { turns: EXTEND_TURNS_CEILING, minutes: 60 } });
		// The two smallest written rungs are the ones the cap removed, and their labels no longer buy anything.
		expect(ceilingAnswerFor(extensionLabel(crowded[0]!), crowded).outcome).toBe("rejected");
		expect((seen[0] as { labels: string[] }).labels).toHaveLength(MAX_EXTEND_OPTIONS + 2);
		expect(ceilingLabels(crowded)[1]).toBe(extensionLabel(crowded[2]!));
	});

	it("ships its rungs, its bounds and its cap written out in the config file", () => {
		// `config.json` spells the shipped ladder, the two ceilings and the cap inside `==extendOptions`, which is
		// where a human reads them; a ladder, bound or cap changed in code without the file is the file lying about
		// the dialog — and a lie about the ceiling is a human trusting the wrong number for more rope.
		const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../../config.json", import.meta.url)), "utf8"));
		const note = String(raw.subagent["==extendOptions"]);
		expect(note).toContain(EXTENSION_STEPS.map((step) => `${step.turns}/${step.minutes}`).join(", "));
		expect(note).toContain(`turns 1..${EXTEND_TURNS_CEILING} and minutes 1..${ROLE_TIMEOUT_CEILING_MINUTES}`);
		expect(note).toContain(`capped at ${MAX_EXTEND_OPTIONS} rungs`);
		expect(note).toContain("REPLACES");
		expect(String(raw.subagent["==disableExtendTurns"])).toContain("extendOptions replaces");
		expect(String(raw.subagent["==sessionBudget"])).toContain("/subagentc budget");
	});
});

describe("the session budget", () => {
	it("stores one rung, copied, and forgets it", () => {
		const session = createSessionBudget();
		expect(session.get()).toBeUndefined();
		expect(session.clear()).toBe(false);
		const rung: ExtensionStep = { turns: 200, minutes: 50 };
		session.set(rung);
		rung.minutes = 999;
		expect(session.get()).toEqual({ turns: 200, minutes: 50 });
		// And the figure it hands out is not the store's own: no caller can retune later runs by writing on it.
		const handed = session.get()!;
		handed.turns = 1;
		expect(session.get()).toEqual({ turns: 200, minutes: 50 });
		expect(session.clear()).toBe(true);
		expect(session.get()).toBeUndefined();
	});

	it("lists the same rungs as session choices, Back first and Forget only while one is remembered", () => {
		expect(ceilingLabels(EXTENSION_STEPS, "session")).toEqual([CEILING_RUN_MENU_LABEL, ...EXTENSION_STEPS.map(sessionExtensionLabel)]);
		expect(ceilingLabels(EXTENSION_STEPS, "session", true)).toEqual([
			CEILING_RUN_MENU_LABEL,
			CEILING_SESSION_FORGET_LABEL,
			...EXTENSION_STEPS.map(sessionExtensionLabel),
		]);
		expect(sessionExtensionLabel(EXTENSION_STEPS[0]!)).toBe("Extend by 20 turns / 5 min — every run this session");
	});

	it("grants nothing on the way in: switching menus asks again, and back answers", async () => {
		const seen: unknown[] = [];
		const host = queue([CEILING_SESSION_MENU_LABEL, CEILING_REJECT_LABEL], seen);
		const session = createSessionBudget();
		await expect(createCeilingBroker({ hasUI: true, ui: host, session })(ask())).resolves.toEqual({ outcome: "rejected" });
		expect(seen).toHaveLength(2);
		// The second question is the session menu, and its title says what its choices do.
		expect((seen[1] as { labels: string[] }).labels[0]).toBe(CEILING_RUN_MENU_LABEL);
		expect((seen[1] as { title: string }).title).toContain("/subagentc budget forgets it");
		expect(session.get()).toBeUndefined();
		expect(host.notices).toEqual([]);
	});

	it("remembers the rung chosen from the session menu and applies it to this run too", async () => {
		const host = queue([CEILING_SESSION_MENU_LABEL, sessionExtensionLabel(EXTENSION_STEPS[3]!)]);
		const session = createSessionBudget();
		const seen: [string, CeilingAnswer][] = [];
		const broker = createCeilingBroker({ hasUI: true, ui: host, session, onOutcome: (reason, answer) => seen.push([reason, answer]) });
		await expect(broker(ask())).resolves.toEqual({ outcome: "granted", grant: { turns: 100, minutes: 25 }, remembered: true });
		expect(session.get()).toEqual({ turns: 100, minutes: 25 });
		expect(seen[0]![1].remembered).toBe(true);
		expect(host.notices[0]?.[0]).toMatch(/extended by 100 turns \/ 25 min — now 130 turns, 45 min — remembered for this session/);
	});

	it("applies the remembered rung to the next run without asking", async () => {
		const session = createSessionBudget();
		session.set({ turns: 20, minutes: 5 });
		const calls: unknown[] = [];
		const host = io(undefined, calls);
		const seen: [string, CeilingAnswer][] = [];
		const broker = createCeilingBroker({ hasUI: true, ui: host, session, onOutcome: (reason, answer) => seen.push([reason, answer]) });
		await expect(broker(ask())).resolves.toEqual({ outcome: "granted", grant: { turns: 20, minutes: 5 }, remembered: true });
		// The whole point: no dialog on the second delegation, and the human still told what is being spent.
		expect(calls).toHaveLength(0);
		expect(host.notices[0]?.[0]).toContain("by the remembered session budget");
		expect(seen).toHaveLength(1);
	});

	it("asks again when the config stopped offering the remembered rung, and forgetting clears it", async () => {
		const session = createSessionBudget();
		session.set({ turns: 500, minutes: 60 });
		const seen: unknown[] = [];
		const host = queue([CEILING_SESSION_FORGET_LABEL, CEILING_REJECT_LABEL], seen);
		await expect(createCeilingBroker({ hasUI: true, ui: host, session })(ask())).resolves.toEqual({ outcome: "rejected" });
		// It opens on the session menu, where the stale figure can be rewritten or forgotten.
		expect((seen[0] as { labels: string[] }).labels[1]).toBe(CEILING_SESSION_FORGET_LABEL);
		expect((seen[1] as { labels: string[] }).labels[0]).toBe(CEILING_REJECT_LABEL);
		expect(session.get()).toBeUndefined();
	});

	it("refuses a session label on the run menu, and a run label on the session menu", async () => {
		// A label of the menu that was not on screen cannot buy rope, in either direction — and remembering is the
		// session menu's alone, so a run-menu label never writes the store.
		const a = createSessionBudget();
		await expect(createCeilingBroker({ hasUI: true, ui: io(sessionExtensionLabel(EXTENSION_STEPS[0]!)), session: a })(ask())).resolves.toEqual({
			outcome: "rejected",
		});
		expect(a.get()).toBeUndefined();
		expect(ceilingPickFor(extensionLabel(EXTENSION_STEPS[0]!), EXTENSION_STEPS, "session").answer).toEqual({ outcome: "rejected" });
	});

	it("keeps Esc a dismissal on either menu", () => {
		expect(ceilingPickFor(undefined, EXTENSION_STEPS, "run").answer).toEqual({ outcome: "dismissed" });
		expect(ceilingPickFor(undefined, EXTENSION_STEPS, "session").answer).toEqual({ outcome: "dismissed" });
		expect(ceilingPickFor(CEILING_SESSION_MENU_LABEL, EXTENSION_STEPS, "run").menu).toBe("session");
		expect(ceilingPickFor(CEILING_RUN_MENU_LABEL, EXTENSION_STEPS, "session").menu).toBe("run");
	});

	it("gives the whole exchange one dialog's timeout, not one per menu", async () => {
		// The clock holds the hard ceiling for a single question's wait (`CEILING_OFFER_HOLD_MS`), so switching menus
		// must not buy more time: each later question gets only what the first question's timeout left.
		const seen: { opts: { timeout?: number } }[] = [];
		const host = io(undefined, seen);
		let switchBack = false;
		host.select = async (_title: string, _labels: string[], opts: unknown) => {
			seen.push({ opts: opts as { timeout?: number } });
			await new Promise((resolve) => setTimeout(resolve, 10));
			// Ping-pong between the menus: the human never settles on one, which is the only way to ask twice.
			switchBack = !switchBack;
			return switchBack ? CEILING_SESSION_MENU_LABEL : CEILING_RUN_MENU_LABEL;
		};
		const answer = await createCeilingBroker({ hasUI: true, ui: host, timeoutMs: 25 })(ask());
		expect(answer.outcome).toBe("dismissed");
		expect(seen.length).toBeLessThanOrEqual(3);
		expect(seen[1]!.opts.timeout!).toBeLessThan(seen[0]!.opts.timeout!);
		expect(host.notices).toEqual([]);
	});

	it("never writes the session budget from an answer the run can no longer use", async () => {
		// The run ended between the two menus, so the answer must reach neither a budget it cannot extend nor the
		// store that would quietly authorise every later run.
		const session = createSessionBudget();
		const controller = new AbortController();
		let asked = 0;
		const host = {
			notify: () => undefined,
			select: async () => {
				asked++;
				if (asked === 1) return CEILING_SESSION_MENU_LABEL;
				controller.abort();
				return sessionExtensionLabel(EXTENSION_STEPS[0]!);
			},
		};
		await expect(createCeilingBroker({ hasUI: true, ui: host, session, signal: controller.signal })(ask())).resolves.toEqual({ outcome: "dismissed" });
		expect(session.get()).toBeUndefined();
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

	it("stays inside the three lines the question needs, on either menu", () => {
		// Long roles or tools must not grow the title back into a wall of text, and the session menu's extra
		// sentence replaces the run menu's rather than adding to it.
		expect(ceilingTitle(ask({ role: "senior_it_architect_and_polyglot", lastTool: "bash" })).split("\n")).toHaveLength(3);
		expect(ceilingTitle(ask(), "session").split("\n")).toHaveLength(3);
	});
});

describe("createCeilingBroker", () => {
	it("refuses to ask with no UI, which is what keeps a headless run unchanged", async () => {
		const calls: unknown[] = [];
		const broker = createCeilingBroker({ hasUI: false, ui: io(undefined, calls) });
		await expect(broker(ask())).resolves.toEqual({ outcome: "no_ui" });
		expect(calls).toHaveLength(0);
	});

	it("never applies a session budget it could not have asked about", async () => {
		// No UI means no human who could have chosen it, and `no_ui` is the ceiling enforced (FM-11).
		const session = createSessionBudget();
		session.set({ turns: 20, minutes: 5 });
		await expect(createCeilingBroker({ hasUI: false, ui: io(undefined), session })(ask())).resolves.toEqual({ outcome: "no_ui" });
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
