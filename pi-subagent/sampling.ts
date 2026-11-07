/**
 * Per-role request sampling for the child (`subagent.roles.<name>.sampling`, `.samplingByThinkingLevel`,
 * `.thinkingLevel`).
 *
 * How the params get to the wire
 * ------------------------------
 * pi already has a native channel for request parameters it does not model: `Model.samplingParams` is merged
 * into the request body *last*, so it outranks the named fields (`pi-ai/dist/api/openai-completions.js`,
 * "Last so model and request sampling parameters override named request fields"), and
 * `Model.samplingParamsByThinkingLevel` is merged over it for the level the run settles on
 * (`pi-ai/dist/api/simple-options.js::resolveSamplingParams`). `createAgentSession` then uses the `model` it
 * was handed *as given* (`pi-coding-agent/dist/core/sdk.js`: `let model = options.model`, re-resolved only
 * when absent). So a role's params reach the server through a cloned `Model` — no request interception, no
 * extension in the child, nothing patched.
 *
 * An extension hook could not do this. `before_provider_request` is fired by the session's *own* extension
 * runner (`sdk.js::transformProviderPayload` reads that session's runner), and a child runs with zero
 * extensions (`child.ts::makeNullLoader`), so a sampling extension installed in the parent never sees a
 * child's body — and the same is true of any provider-level `sampling` block such an extension reads. That
 * is the gap this module fills: the parent keeps whatever it is configured with, and each role says what a
 * child of that role sends.
 *
 * The clone is not optional
 * -------------------------
 * `ctx.model` is the *parent session's* model object and `index.ts` hands that same reference down. Writing
 * `samplingParams` onto it would retune the session that delegated the work, which is the one outcome a
 * per-role knob must never have. Nothing here mutates its input.
 *
 * Which keys win
 * --------------
 * Role params are the more specific instruction, so they are merged over the model's `samplingParams` *and*
 * over each of the model's per-thinking-level entries, per key. Patching every level rather than the one the
 * role asks for is deliberate: pi clamps the level itself, inside the adapter (`clampThinkingLevel`), so a
 * role that requests `xhigh` on a model that stops at `high` must still get its own values at `high`. A key
 * the role does not name keeps whatever the model declared for the level that ends up in effect.
 *
 * The same rule reaches the role's *own* level blocks, and there it needs one more step: pi looks a level bag
 * up by the clamped level (`simple-options.js::resolveSamplingParams`), so a block keyed to a level this model
 * does not advertise would sit in the clone forever and never be read. `foldLevels` therefore re-keys the role's
 * blocks through the clamp before merging, which is what makes "the role still gets its own numbers" true of
 * `{ "samplingByThinkingLevel": { "xhigh": … } }` on a model that has no `xhigh` — and a plain `models.json`
 * entry with no `thinkingLevelMap` is exactly that model, since pi only advertises `xhigh`/`max` when the map
 * declares them (`pi-ai/dist/models.js::getSupportedThinkingLevels`).
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Api, type Model, type SamplingParams, type SamplingParamsByThinkingLevel } from "@earendil-works/pi-ai";
import type { SamplingConfig, ThinkingLevelWord } from "../pi-gate/schema.ts";
import type { Role } from "./roles.ts";

/** The APIs whose adapters merge `samplingParams` into the body; every other API ignores it (pi-ai types.d.ts). */
export const SAMPLING_CAPABLE_APIS: readonly string[] = ["openai-completions", "openai-responses", "azure-openai-responses"];

/** Whether the child's endpoint will read the params at all — false is reported, never swallowed. */
export function isSamplingCapable(model: Model<Api> | undefined): boolean {
	return !!model && SAMPLING_CAPABLE_APIS.includes(model.api);
}

/** What the role's `thinkingLevel` asks for; unset means "whatever the session is on". */
export function roleThinkingLevel(role: Role, inherited: ThinkingLevel): ThinkingLevel {
	return role.thinkingLevel ?? inherited;
}

/** pi's level ladder (`EXTENDED_THINKING_LEVELS` in `pi-ai/dist/models.js`) — the line `clampThinkingLevel` walks. */
const LEVEL_ORDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Re-key a role's per-level blocks onto the levels this model can actually select.
 *
 * Several written levels can land on one (`high` and `xhigh` on a model that stops at `high`, or a map that
 * nulls a rung). Precedence on a key conflict: the block written for the level that is really in force beats one
 * that only clamped there, and among the clamped ones the higher written level wins — a role that asks `xhigh`
 * and is taken down to `high` runs at `high`, and `high`'s own block is the statement about that run.
 */
export function foldLevels(
	model: Model<Api>,
	byLevel: Partial<Record<ThinkingLevelWord, SamplingConfig | undefined>> | undefined,
): Partial<Record<ThinkingLevelWord, SamplingConfig>> {
	const folded: Partial<Record<ThinkingLevelWord, SamplingConfig>> = {};
	if (!byLevel) return folded;
	for (const level of LEVEL_ORDER) {
		const word = level as ThinkingLevelWord;
		const block = byLevel[word];
		if (!block || !Object.keys(block).length) continue;
		const target = clampThinkingLevel(model, level) as ThinkingLevelWord;
		folded[target] = target === word ? { ...folded[target], ...block } : { ...block, ...folded[target] };
	}
	return folded;
}

export interface AppliedRoleSampling {
	/** The model to run the child on: a copy when the role says anything, the input object otherwise. */
	model: Model<Api>;
	/** The keys the role contributes at this thinking level — what the child will actually send. */
	applied: SamplingConfig;
	/** Every key the role names at any level: what the endpoint would not receive if {@link ignored} is set.
	 * Which level's value is shown for a key named twice does not matter — it is a warning, not the request. */
	asked: SamplingConfig;
	/** True when params were asked for but this API ignores them. */
	ignored: boolean;
}

/**
 * Fold one role's sampling into the child's model. Pure: the input model is returned untouched (same
 * reference) whenever the role names no params, so a run without the feature allocates nothing new.
 *
 * The level argument is the *requested* one: pi clamps the level it reads the per-level bag with, inside the
 * adapter (`clampThinkingLevel`), so the clamp is repeated here for the report only. The merge is deliberately
 * level-free, which is what makes the reported params right whatever the model clamps to.
 */
export function applyRoleSampling(model: Model<Api>, role: Role, thinkingLevel: ThinkingLevel): AppliedRoleSampling {
	const flat = role.sampling ?? {};
	const asked: SamplingConfig = Object.assign({}, flat, ...Object.values(role.samplingByThinkingLevel ?? {}));
	// Keyed by the levels pi can select, so every entry here is one a request can actually read.
	const byLevel = foldLevels(model, role.samplingByThinkingLevel);
	const applied: SamplingConfig = { ...flat, ...byLevel[clampThinkingLevel(model, thinkingLevel) as ThinkingLevelWord] };
	if (!Object.keys(asked).length) return { model, applied: {}, asked, ignored: false };

	const modelLevels = model.samplingParamsByThinkingLevel ?? {};
	const levels = new Set<string>([...Object.keys(modelLevels), ...Object.keys(byLevel)]);
	const mergedLevels: SamplingParamsByThinkingLevel = {};
	for (const level of levels) {
		mergedLevels[level as ThinkingLevelWord] = {
			...(modelLevels[level as ThinkingLevelWord] as SamplingConfig | undefined),
			...flat,
			...byLevel[level as ThinkingLevelWord],
		};
	}

	return {
		model: {
			...model,
			samplingParams: { ...model.samplingParams, ...flat } as SamplingParams,
			...(Object.keys(mergedLevels).length ? { samplingParamsByThinkingLevel: mergedLevels } : {}),
		},
		applied,
		asked,
		ignored: !isSamplingCapable(model),
	};
}

/** One line for a card or `/subagentc`: `temperature=0.3 · top_p=0.9`, or "" when the role says nothing. */
export function samplingLabel(applied: SamplingConfig): string {
	return Object.entries(applied)
		.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join(" · ");
}
