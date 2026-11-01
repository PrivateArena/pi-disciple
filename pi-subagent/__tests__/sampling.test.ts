/**
 * `subagent.roles.<name>.sampling` / `.thinkingLevel`.
 *
 * The claims worth testing are the two this feature could get wrong quietly: that a role's params reach the
 * request (asserted against pi's own merge function, `resolveSamplingParams`, not a re-implementation of it),
 * and that they reach it *for the child only* — the parent's model object must come back untouched.
 */

import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { resolveSamplingParams } from "@earendil-works/pi-ai/api/simple-options";
import type { RoleConfig } from "../../pi-gate/schema.ts";
import { applyRoleConfig } from "../roles.ts";
import { applyRoleSampling, isSamplingCapable, roleThinkingLevel, samplingLabel } from "../sampling.ts";

const ALL_LEVELS = { off: "false", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/** A reasoning model that supports every level; `levels:` narrows it the way a real Qwen map does. */
const model = (fields: Record<string, unknown> = {}): Model<any> =>
	({
		provider: "local",
		id: "qwen3.6-35b",
		api: "openai-completions",
		reasoning: true,
		thinkingLevelMap: ALL_LEVELS,
		contextWindow: 262_144,
		maxTokens: 65_536,
		...fields,
	}) as unknown as Model<any>;

/** One role as the config would define it, settled through the real table merge. */
function exploreRole(entry: RoleConfig) {
	const applied = applyRoleConfig({ explore: entry });
	return { role: applied.roles.explore!, warnings: applied.warnings };
}

describe("applyRoleSampling", () => {
	it("hands back the same model object when the role says nothing", () => {
		const parent = model({ samplingParams: { temperature: 1 } });
		const { role } = exploreRole({ maxTurns: 5 });
		const result = applyRoleSampling(parent, role, "high");
		expect(result.model).toBe(parent);
		expect(result.applied).toEqual({});
		expect(result.ignored).toBe(false);
	});

	it("merges the role's params over the model's own defaults", () => {
		const parent = model({ samplingParams: { temperature: 1, top_p: 0.95 } });
		const { role } = exploreRole({ sampling: { temperature: 0.2, top_k: 20 } });
		const child = applyRoleSampling(parent, role, "high").model;
		expect(child.samplingParams).toEqual({ temperature: 0.2, top_p: 0.95, top_k: 20 });
		// pi is what turns this into a request body — so ask pi what a request at each level would carry.
		expect(resolveSamplingParams(child, "high")).toEqual({ temperature: 0.2, top_p: 0.95, top_k: 20 });
	});

	it("beats the model's per-thinking-level entries, at every level the run could land on", () => {
		const parent = model({
			samplingParams: { temperature: 1 },
			samplingParamsByThinkingLevel: { off: { temperature: 0.7 }, xhigh: { temperature: 0.6, top_k: 40 } },
		});
		const { role } = exploreRole({ sampling: { temperature: 0.2 } });
		const child = applyRoleSampling(parent, role, "xhigh").model;
		// "the role is the more specific instruction" is the whole design; a level entry winning would mean
		// the knob silently did nothing for exactly the models that use it.
		for (const level of ["off", "low", "xhigh", "max"] as const) {
			expect(resolveSamplingParams(child, level)?.temperature, level).toBe(0.2);
		}
		// A key the role never names keeps the model's own value for that level.
		expect(resolveSamplingParams(child, "xhigh")?.top_k).toBe(40);
	});

	it("applies a level block only at its level, over the flat one", () => {		const { role } = exploreRole({
			sampling: { temperature: 0.2 },
			samplingByThinkingLevel: { xhigh: { temperature: 0.6, min_p: 0 } },
		});
		const child = applyRoleSampling(model(), role, "xhigh").model;
		expect(resolveSamplingParams(child, "off")).toEqual({ temperature: 0.2 });
		expect(resolveSamplingParams(child, "xhigh")).toEqual({ temperature: 0.6, min_p: 0 });
	});

	it("never writes on the parent's model object", () => {
		// `ctx.model` is the session's own object, so a mutation here would retune the parent's requests.
		const parent = model({ samplingParams: { temperature: 1 }, samplingParamsByThinkingLevel: { high: { top_k: 40 } } });
		const before = JSON.stringify({ samplingParams: parent.samplingParams, levels: parent.samplingParamsByThinkingLevel });
		const { role } = exploreRole({ sampling: { temperature: 0.1 }, samplingByThinkingLevel: { high: { top_p: 0.8 } } });
		const child = applyRoleSampling(parent, role, "high").model;
		expect(JSON.stringify({ samplingParams: parent.samplingParams, levels: parent.samplingParamsByThinkingLevel })).toBe(before);
		expect(child).not.toBe(parent);
		expect(resolveSamplingParams(child, "high")).toEqual({ temperature: 0.1, top_k: 40, top_p: 0.8 });
		// The clone still names the same physical model, which is what pi matches routing on.
		expect([child.provider, child.id, child.api]).toEqual(["local", "qwen3.6-35b", "openai-completions"]);
	});

	it("reports what the level actually in force will send, not what was asked for", () => {
		// pi clamps inside its adapter, so a role that asks `xhigh` on a model that stops at `high` runs at high —
		// and the card must show the params that block selects, not the ones that never fire.
		const shallow = model({ thinkingLevelMap: { off: "false", minimal: "minimal", low: "low", medium: "medium", high: "high" } });
		const { role } = exploreRole({ thinkingLevel: "xhigh", sampling: { temperature: 0.2 }, samplingByThinkingLevel: { high: { top_k: 7 }, xhigh: { top_k: 99 } } });
		const result = applyRoleSampling(shallow, role, "xhigh");
		expect(result.applied).toEqual({ temperature: 0.2, top_k: 7 });
		// `asked` is only ever shown when nothing at all can be sent, so it names every key the role wrote.
		expect(Object.keys(result.asked).sort()).toEqual(["temperature", "top_k"]);
	});

	it("still applies them when the model clamps the requested level down", () => {
		// A role may ask for `xhigh`; pi clamps inside the adapter (`clampThinkingLevel`), so the params have to
		// be in place for the level that actually gets used — the reason the merge is not keyed on the request.
		const shallow = model({ thinkingLevelMap: { ...ALL_LEVELS, xhigh: undefined, max: undefined } });
		const { role } = exploreRole({ thinkingLevel: "xhigh", sampling: { temperature: 0.2 } });
		const child = applyRoleSampling(shallow, role, "xhigh").model;
		expect(resolveSamplingParams(child, "xhigh")?.temperature).toBe(0.2);
		expect(resolveSamplingParams(child, "high")?.temperature).toBe(0.2);
	});

	it("passes server-specific names and structured values straight through", () => {
		const { role } = exploreRole({ sampling: { repetition_penalty: 1.05, do_sample: true, chat_template_kwargs: { use_audio: false } } });
		const child = applyRoleSampling(model(), role, "off").model;
		expect(resolveSamplingParams(child, "off")).toEqual({
			repetition_penalty: 1.05,
			do_sample: true,
			chat_template_kwargs: { use_audio: false },
		});
	});

	it("says when the endpoint will not read the params", () => {
		const { role } = exploreRole({ sampling: { temperature: 0.2 } });
		const anthropic = model({ provider: "anthropic", id: "claude-opus-4-5", api: "anthropic-messages" });
		expect(isSamplingCapable(anthropic)).toBe(false);
		expect(applyRoleSampling(anthropic, role, "off").ignored).toBe(true);
		expect(isSamplingCapable(model({ api: "openai-responses" }))).toBe(true);
		// Nothing asked for is not a warning: a role with no params on any API stays silent.
		expect(applyRoleSampling(anthropic, exploreRole({}).role, "off").ignored).toBe(false);
	});
});

describe("roleThinkingLevel", () => {
	it("inherits the session's level unless the role names one", () => {
		const { role } = exploreRole({});
		expect(roleThinkingLevel(role, "xhigh")).toBe("xhigh");
		expect(roleThinkingLevel(exploreRole({ thinkingLevel: "off" }).role, "xhigh")).toBe("off");
	});
});

describe("samplingLabel", () => {
	it("prints one line, and nothing when the role says nothing", () => {
		expect(samplingLabel({})).toBe("");
		expect(samplingLabel({ temperature: 0.3, top_k: 20 })).toBe("temperature=0.3 · top_k=20");
		expect(samplingLabel({ chat_template_kwargs: { x: 1 } })).toBe("chat_template_kwargs={\"x\":1}");
	});
});
