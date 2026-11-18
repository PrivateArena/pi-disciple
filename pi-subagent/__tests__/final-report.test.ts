/**
 * `final-report.ts` — what a run's last words are worth, and what the rescue will and will not do about it.
 *
 * The classification is the whole fix, so it is tested as a table: the same narration text is a report, a
 * fragment, or nothing, depending on the message that carries it. Note the case the review of this code found
 * first (a run whose newest message carries *no* text and so must not be certified by an older sentence) and the
 * stop reasons that mean "this one is not over yet" — `pending` is what a streaming message carries.
 *
 * `requestFinalReport` is tested against sessions that misbehave, because every one of those paths is a way for
 * the guarantee to become the thing that hangs the run: an `abort()` that never resolves, a `setTools` that
 * throws, a `prompt()` that rejects.
 */

import { describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ReportShape } from "../final-report.ts";
import {
	classifyReport,
	FINAL_REPORT_CEILING_PROMPT,
	FINAL_REPORT_GRACE_MS,
	FINAL_REPORT_MALFORMED_PROMPT,
	finalReportPrompt,
	planFinalReport,
	requestFinalReport,
	salvageSource,
} from "../final-report.ts";

describe("classifyReport", () => {
	it("calls a finished, text-only message a report", () => {
		expect(classifyReport({ text: "Findings: the gate lives in pi-gate/policy.ts.", stopReason: "stop" })).toBe("report");
		// A harness that wrote no stop reason at all has not said the message is unfinished.
		expect(classifyReport({ text: "Findings.", stopReason: undefined })).toBe("report");
	});

	it("calls a cut-off or unfinished message a fragment", () => {
		for (const stopReason of ["aborted", "error", "length", "pending", "deferred"]) {
			expect(classifyReport({ text: "Now I'll write the code, starting with deps:", stopReason }), stopReason).toBe("partial");
		}
		// A message that ended on a tool call is mid-task by definition, whatever its stop reason says.
		expect(classifyReport({ text: "Let me read it.", stopReason: "toolUse", hasToolCall: true })).toBe("partial");
	});

	it("calls a written-out call markup, and nothing at all nothing", () => {
		expect(classifyReport({ text: "[Tool call: bash]", stopReason: "stop" })).toBe("markup");
		expect(classifyReport({ text: "   ", stopReason: "stop" })).toBe("none");
		expect(classifyReport({ text: "", stopReason: "aborted" })).toBe("none");
	});

	it("grades the salvaged text only as well as its shape", () => {
		expect(salvageSource("report")).toBe("final");
		expect(salvageSource("partial")).toBe("salvaged");
		expect(salvageSource("markup")).toBe("salvaged");
		expect(salvageSource("none")).toBe("salvaged");
	});
});

describe("planFinalReport", () => {
	const at = (exit: Parameters<typeof planFinalReport>[0]["exit"], shape: ReportShape = "markup", allowed = true) =>
		planFinalReport({ exit, shape, allowed });

	it("asks when the run ended on markup, whatever the exit says", () => {
		// The case the card showed as `DONE`: the child stopped on its own, on a sentence about a call it never made.
		expect(at("done")).toEqual({ rescue: true, reason: "malformed" });
		expect(at("timeout")).toEqual({ rescue: true, reason: "malformed" });
		expect(at("maxTurns")).toEqual({ rescue: true, reason: "malformed" });
		expect(at("overflow", "none")).toEqual({ rescue: true, reason: "ceiling" });
		expect(at("timeout", "partial")).toEqual({ rescue: true, reason: "ceiling" });
	});

	it("stands down on a report, a stop it did not cause, a dead provider, and a switch off", () => {
		expect(at("timeout", "report")).toEqual({ rescue: false, skip: "reported" });
		expect(at("aborted", "markup")).toEqual({ rescue: false, skip: "aborted" });
		expect(at("error", "none")).toEqual({ rescue: false, skip: "error" });
		expect(planFinalReport({ exit: "timeout", shape: "partial", allowed: false })).toEqual({ rescue: false, skip: "disabled" });
	});

	it("says which prompt the reason means", () => {
		expect(finalReportPrompt("ceiling")).toBe(FINAL_REPORT_CEILING_PROMPT);
		expect(finalReportPrompt("malformed")).toBe(FINAL_REPORT_MALFORMED_PROMPT);
		expect(FINAL_REPORT_CEILING_PROMPT).toMatch(/tools are now switched off/);
		expect(FINAL_REPORT_MALFORMED_PROMPT).toMatch(/wrote a tool call as text/);
		expect(FINAL_REPORT_MALFORMED_PROMPT).toMatch(/Do not write another call/);
	});
});

interface Harness {
	session: AgentSession;
	prompts: string[];
	toolSets: string[][];
	cleared: () => number;
}

/** A session that answers the rescue, with every step switchable to the failure mode a test names. */
function harness(options: {
	messages?: unknown[];
	afterPrompt?: unknown[];
	isStreaming?: boolean;
	abortNeverResolves?: boolean;
	setToolsThrows?: boolean;
	promptRejects?: string;
} = {}): Harness {
	const prompts: string[] = [];
	const toolSets: string[][] = [];
	let clears = 0;
	const session = {
		isStreaming: options.isStreaming ?? false,
		messages: options.messages ?? [],
		async prompt(text: string) {
			prompts.push(text);
			if (options.promptRejects) throw new Error(options.promptRejects);
			session.messages = [...(session.messages as unknown[]), ...(options.afterPrompt ?? [])];
		},
		setActiveToolsByName(names: string[]) {
			if (options.setToolsThrows) throw new Error("tools are not mine to give");
			toolSets.push(names);
		},
		clearQueue() {
			clears++;
		},
		async abort() {
			if (options.abortNeverResolves) await new Promise(() => undefined);
			session.isStreaming = false;
		},
		async waitForIdle() {
			if (options.abortNeverResolves) await new Promise(() => undefined);
		},
	};
	return { session: session as unknown as AgentSession, prompts, toolSets, cleared: () => clears };
}

const reportMessage = { role: "assistant", content: [{ type: "text", text: "REPORT: two files, tests not run." }], stopReason: "stop" };
const fragmentMessage = { role: "assistant", content: [{ type: "text", text: "Now I'll write the code:" }], stopReason: "aborted" };

describe("requestFinalReport", () => {
	const signal = new AbortController().signal;

	it("asks once, with no tools and no queued reminders, and returns only what the turn wrote", async () => {
		const h = harness({ messages: [fragmentMessage], afterPrompt: [reportMessage] });
		const outcome = await requestFinalReport(h.session, { prompt: FINAL_REPORT_CEILING_PROMPT, signal });
		expect(h.prompts).toEqual([FINAL_REPORT_CEILING_PROMPT]);
		expect(h.toolSets).toEqual([[]]);
		expect(h.cleared()).toBe(1);
		expect(outcome.status).toBe("reported");
		expect(outcome.text).toBe("REPORT: two files, tests not run.");
	});

	it("does not mistake the fragment it was called on for the answer", async () => {
		// The prompt never appends anything: the only text in the transcript is the one the run was cut off on.
		const h = harness({ messages: [fragmentMessage] });
		const outcome = await requestFinalReport(h.session, { prompt: FINAL_REPORT_CEILING_PROMPT, signal });
		expect(outcome.status).toBe("empty");
		expect(outcome.text).toBe("");
	});

	it("settles inside its grace when the session will not go idle (FM-2)", async () => {
		// `abort()` that never resolves is the whole point of this test: the grace must bound the wait *before*
		// the turn as well as the turn itself, or the rescue re-opens the hole the ceiling exists to close.
		const h = harness({ isStreaming: true, abortNeverResolves: true });
		const started = Date.now();
		const outcome = await requestFinalReport(h.session, { prompt: FINAL_REPORT_CEILING_PROMPT, graceMs: 60, signal });
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(outcome.status).toBe("timed-out");
		expect(h.prompts).toEqual([]);
	});

	it("reports an empty turn rather than a crash when the provider rejects", async () => {
		const h = harness({ messages: [fragmentMessage], promptRejects: "429 rate limited" });
		const outcome = await requestFinalReport(h.session, { prompt: FINAL_REPORT_CEILING_PROMPT, signal });
		expect(outcome.status).toBe("failed");
		expect(outcome.error).toContain("429");
		expect(outcome.text).toBe("");
	});

	it("still asks when the session will not give its tools up", async () => {
		const h = harness({ messages: [fragmentMessage], afterPrompt: [reportMessage], setToolsThrows: true });
		const outcome = await requestFinalReport(h.session, { prompt: FINAL_REPORT_MALFORMED_PROMPT, signal });
		expect(h.toolSets).toEqual([]);
		expect(outcome.status).toBe("reported");
	});

	it("does not start a turn the human has already called off", async () => {
		const controller = new AbortController();
		controller.abort();
		const h = harness({ messages: [fragmentMessage], afterPrompt: [reportMessage] });
		const outcome = await requestFinalReport(h.session, { prompt: FINAL_REPORT_CEILING_PROMPT, signal: controller.signal });
		expect(outcome.status).toBe("aborted");
		expect(h.prompts).toEqual([]);
	});

	it("bounds the default grace window at the report's own budget", () => {
		expect(FINAL_REPORT_GRACE_MS).toBe(3 * 60_000);
	});
});
