/**
 * reasoning.ts — the bounded view of a child's thinking that is safe to put on the wire on every progress tick.
 *
 * A card wants to say what the child is thinking while it works, and the two places that thought already lives
 * are both wrong for that: the child's transcript is a JSONL file the frontend would have to find and parse, and
 * the run log (`transcript/turn-log.ts`) is a debug artifact that is off by default. What the progress event
 * carries instead has to be small and fixed-size — a thinking block is unbounded prose, streamed on a timer, and
 * an unbounded payload on a per-tick event is how a card stops updating at all.
 *
 * So: the newest turns, each clipped, under one character budget, with `truncated` saying that this is a window
 * rather than the record. The transcript stays the complete thing; this is the part a glance at a card is worth.
 *
 * Pure by construction — no fs, no session, nothing that can throw — because it is built inside the child's event
 * subscriber, between the run and its `dispose()`.
 */

import { logSlice } from "./transcript/turn-log.ts";

/** One turn of the child's reasoning, numbered so a card can say when it happened. */
export interface ReasoningTurn {
	turn: number;
	text: string;
}

/** What the child has thought so far, cut to what a progress event may carry. */
export interface ReasoningTrail {
	turns: ReasoningTurn[];
	/** True when the trail dropped or clipped something; the transcript holds everything. */
	truncated: boolean;
}

export interface ReasoningTrailBuilder {
	/** Whitespace-only text is not a thought: ignored. */
	add(turn: number, text: string): void;
	/** undefined while the child has thought nothing, so `details` omits the field. */
	snapshot(): ReasoningTrail | undefined;
}

/** How much of one turn's thinking a card is worth. */
export const REASONING_TURN_CHARS = 4_000;

/** How much thinking the whole trail may carry, whatever the turn count — the wire budget, not a display one. */
export const REASONING_TRAIL_CHARS = 16_000;

/**
 * The trail for one run: newest turns kept, oldest dropped, `truncated` saying that something fell off.
 *
 * Defensive against a provider that sends no `thinking` string, because a malformed message may cost a card its
 * thinking line and never the run that carried it.
 */
export function createReasoningTrail(): ReasoningTrailBuilder {
	const turns: ReasoningTurn[] = [];
	/** Sum of `turns[].text.length`, kept so a budget check is not a fold per event. */
	let chars = 0;
	let truncated = false;
	return {
		add(turn: number, text: string): void {
			const thought = typeof text === "string" ? text.trim() : "";
			if (!thought) return;
			// The transcript names itself in the suffix, so a clipped thought says where the rest of it is.
			const clipped = logSlice(thought, REASONING_TURN_CHARS);
			// Measured against the budget, not against `clipped`: the suffix it appends is longer than what it cut.
			if (thought.length > REASONING_TURN_CHARS) truncated = true;
			turns.push({ turn: Number.isFinite(turn) ? Math.trunc(turn) : 0, text: clipped });
			chars += clipped.length;
			// The newest turn is never dropped: the budget is a window over the trail, not a reason to show nothing.
			while (chars > REASONING_TRAIL_CHARS && turns.length > 1) {
				chars -= turns.shift()!.text.length;
				truncated = true;
			}
		},
		snapshot(): ReasoningTrail | undefined {
			if (turns.length === 0) return undefined;
			// A fresh object over fresh rows: the caller keeps this on a card and the child keeps appending to it.
			return { turns: turns.map((entry) => ({ ...entry })), truncated };
		},
	};
}
