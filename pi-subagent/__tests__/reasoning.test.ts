import { describe, expect, it } from "vitest";
import { createReasoningTrail, REASONING_TRAIL_CHARS, REASONING_TURN_CHARS } from "../reasoning.ts";

const thought = (char: string, chars = 100) => char.repeat(chars);

describe("the reasoning trail", () => {
	it("is undefined until the child has thought something it can show", () => {
		const trail = createReasoningTrail();
		expect(trail.snapshot()).toBeUndefined();
		// Whitespace-only text is not a thought, and a non-string is not text: neither opens the trail, and
		// neither may throw inside the child's event subscriber.
		trail.add(1, "   \n\t  ");
		trail.add(2, undefined as never);
		trail.add(3, { thinking: "an object is not a string" } as never);
		expect(trail.snapshot()).toBeUndefined();
	});

	it("trims a thought, numbers it with the turn the card should print, and says nothing about truncation", () => {
		const trail = createReasoningTrail();
		trail.add(1, "\n  read the policy first  \n");
		expect(trail.snapshot()).toEqual({ turns: [{ turn: 1, text: "read the policy first" }], truncated: false });
	});

	it("clips one enormous thought to its turn budget and points at the transcript", () => {
		const trail = createReasoningTrail();
		trail.add(4, thought("x", REASONING_TURN_CHARS + 5_000));
		const snapshot = trail.snapshot()!;
		expect(snapshot.truncated).toBe(true);
		expect(snapshot.turns).toHaveLength(1);
		expect(snapshot.turns[0]).toMatchObject({ turn: 4 });
		expect(snapshot.turns[0]!.text.startsWith(thought("x", REASONING_TURN_CHARS))).toBe(true);
		expect(snapshot.turns[0]!.text).toContain("5000 more chars, in the transcript");
		expect(snapshot.turns[0]!.text.length).toBeLessThan(REASONING_TURN_CHARS + 100);
	});

	it("keeps the newest turns when the trail outgrows its budget, and drops from the front", () => {
		const trail = createReasoningTrail();
		// Six whole-budget turns: only the newest four fit, and the ones that fell off are named by `truncated`.
		for (let i = 1; i <= 6; i++) trail.add(i, thought(String(i), REASONING_TURN_CHARS));
		const snapshot = trail.snapshot()!;
		expect(snapshot.truncated).toBe(true);
		expect(snapshot.turns.map((entry) => entry.turn)).toEqual([3, 4, 5, 6]);
		expect(snapshot.turns.reduce((sum, entry) => sum + entry.text.length, 0)).toBeLessThanOrEqual(REASONING_TRAIL_CHARS);
		// The dropped turns are gone from the trail, not left as holes.
		expect(snapshot.turns[0]!.text.startsWith(thought("3"))).toBe(true);
	});

	it("says nothing fell off a trail that fits, however many turns it holds", () => {
		const trail = createReasoningTrail();
		for (let i = 1; i <= 5; i++) trail.add(i, thought("y", 200));
		const snapshot = trail.snapshot()!;
		expect(snapshot.truncated).toBe(false);
		expect(snapshot.turns.map((entry) => entry.turn)).toEqual([1, 2, 3, 4, 5]);
	});

	it("hands out a fresh snapshot every call, so a card may keep the one it was given", () => {
		const trail = createReasoningTrail();
		trail.add(1, "first thought");
		const first = trail.snapshot()!;
		const second = trail.snapshot()!;
		expect(first).not.toBe(second);
		expect(first.turns).not.toBe(second.turns);
		expect(first).toEqual(second);
		// A frontend that edits what it was handed cannot rewrite the run's history.
		first.turns[0]!.text = "censored";
		first.turns.push({ turn: 99, text: "invented" });
		expect(trail.snapshot()!.turns).toEqual([{ turn: 1, text: "first thought" }]);
	});

	it("clips a thought one character over the budget, and not one that fits it", () => {
		const trail = createReasoningTrail();
		trail.add(1, thought("x", REASONING_TURN_CHARS));
		expect(trail.snapshot()!.truncated).toBe(false);
		trail.add(2, `${thought("y", REASONING_TURN_CHARS)}!`);
		const snapshot = trail.snapshot()!;
		expect(snapshot.truncated).toBe(true);
		expect(snapshot.turns[0]!.text).toHaveLength(REASONING_TURN_CHARS);
	});
});
