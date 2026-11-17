/**
 * The stop dialog's text and its answer vocabulary.
 *
 * Pinned because this dialog is the only thing standing between a client's `stop()` and a lost report, and
 * because the budget dialog taught the shape: a question whose options scrolled off the screen answers nothing,
 * and a dialog that leads with the destructive choice ends runs on a stray Enter.
 */
import { describe, expect, it } from "vitest";
import {
	STOP_KEEP_LABEL,
	STOP_STOP_LABEL,
	createStopAsker,
	stopAnswerIsYes,
	stopDialogTitle,
	stopLabels,
} from "../stop-dialog.ts";
import type { StopQuestion } from "../stop-api.ts";

const question: StopQuestion = {
	role: "explore",
	task: "Critique a documentation consolidation in ~/zen-webserver",
	elapsedSeconds: 612,
	reason: "Stopped by user with note: the docs are already consolidated",
};

describe("stopDialogTitle", () => {
	it("leads with the question, then the consequence, then the cost", () => {
		const lines = stopDialogTitle(question).split("\n");
		expect(lines[0]).toBe("pi-subagent: stop the Explore subagent?");
		// Not "a tool call will be interrupted": what a human is weighing is the lost report.
		expect(lines[1]).toContain("will not finish its report");
		expect(lines[2]).toContain("612s of work");
		// The reason the human gave is echoed, so the dialog says what will reach the model.
		expect(lines[3]).toContain("the docs are already consolidated");
	});

	it("does not paste the task into the dialog", () => {
		// The ceiling dialog's rule: the task is the paragraph on the card above, and printing it here pushes
		// the options off the screen — which is the failure mode this dialog must not have.
		expect(stopDialogTitle(question)).not.toContain("zen-webserver");
	});

	it("says the cost without inventing a reason the caller did not give", () => {
		const bare = stopDialogTitle({ ...question, reason: "" });
		expect(bare).toContain("stop the Explore subagent?");
		expect(bare).not.toContain("the main agent will read");
	});
});

describe("the answer", () => {
	it("puts the safe choice first, so a stray Enter keeps the run", () => {
		expect(stopLabels()[0]).toBe(STOP_KEEP_LABEL);
		expect(stopLabels()).toContain(STOP_STOP_LABEL);
	});

	it("reads only its own label as a yes", () => {
		expect(stopAnswerIsYes(STOP_STOP_LABEL)).toBe(true);
		// Undefined is Esc/timeout/dismiss, and an unrecognised label is not a yes either.
		expect(stopAnswerIsYes(undefined)).toBe(false);
		expect(stopAnswerIsYes(STOP_KEEP_LABEL)).toBe(false);
		expect(stopAnswerIsYes("Stop")).toBe(false);
	});
});

describe("createStopAsker", () => {
	it("refuses where there is nobody to ask", async () => {
		const select = async () => STOP_STOP_LABEL;
		const answer = await createStopAsker({ hasUI: false, ui: { select } })(question);
		expect(answer).toBe(false);
	});

	it("asks once with the title and the labels, and reports the pick", async () => {
		const calls: Array<{ title: string; options: string[] }> = [];
		const asker = createStopAsker({
			hasUI: true,
			ui: {
				select: async (title: string, options: string[]) => {
					calls.push({ title, options });
					return STOP_STOP_LABEL;
				},
			},
		});
		expect(await asker(question)).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].title).toContain("stop the Explore subagent?");
		expect(calls[0].options).toEqual([STOP_KEEP_LABEL, STOP_STOP_LABEL]);
	});

	it("treats a dismissed dialog as no", async () => {
		const asker = createStopAsker({ hasUI: true, ui: { select: async () => undefined } });
		expect(await asker(question)).toBe(false);
	});
});
