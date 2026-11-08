/**
 * What child the config actually asks for: the two decisions the `subagent` tool handler used to spell out
 * inline (plan step 10's config-driven model, step 16's per-role request retuning).
 *
 * A leaf over the two modules that own the arithmetic — `model-override.ts` (which model answers, and at which
 * thinking level) and `sampling.ts` (what the request body carries) — with no config reading and no UI of its
 * own: the caller passes what it read and hands down an `onWarning` seam, so `index.ts` stays wiring and these
 * decisions stay testable without a session.
 *
 * Two functions, deliberately not one. They sit at different points in the handler: the model pin runs before
 * the run is claimed, the request decision after `claimGuard()` and the shims are built. `claimGuard` throws
 * while another run holds the guard, so merging them would move one of the two warnings across a call that can
 * fail, changing whether a rejected call ever says it. Each is called exactly where its block used to live.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Role } from "./roles.ts";
import { childThinkingLabel, childThinkingLevel, modelLabel, resolveChildModel } from "./model-override.ts";
import { applyRoleSampling, roleThinkingLevel, samplingLabel } from "./sampling.ts";

/** The caller's warning channel — both warnings this module can emit are warnings (`ctx.ui.notify(text, "warning")`). */
export type RequestWarning = (text: string) => void;

export interface ChildModelPin {
	/** The model to run the child on: the pin when it resolved, the session's own model otherwise. */
	readonly model: Model<Api>;
	/** True when `subagent.model` decided, which is what the label prints as `(config override)`. */
	readonly overridden: boolean;
}

/**
 * The `subagent.model` pin: the session's model, unless the human pinned one and it resolves. An unresolvable
 * pin is a warning and a fallback, never a refusal — the child still runs, on the model its parent is on.
 */
export function resolveModelPin(
	pin: string | undefined,
	registry: ModelRegistry,
	sessionModel: Model<Api>,
	onWarning: RequestWarning,
): ChildModelPin {
	let model = sessionModel;
	let overridden = false;
	if (pin) {
		const resolved = resolveChildModel(pin, registry, sessionModel);
		if (resolved.status === "error") onWarning(`[subagent] ${resolved.message} — running on the session model`);
		else {
			model = resolved.model;
			overridden = true;
		}
	}
	return { model, overridden };
}

export interface ChildRequest {
	/** The model to hand the child — the clone {@link resolveChildRequest} produced, never the caller's object. */
	readonly model: Model<Api>;
	/** The thinking level the child actually runs at, after pi's clamp. */
	readonly thinkingLevel: ThinkingLevel;
	/** Display label for the card and `/subagentc`, e.g. `local/qwen3.8-flash-next (inherited)`. */
	readonly label: string | undefined;
	/** The thinking level the child ran at when it is worth saying, else `undefined` (see `childThinkingLabel`). */
	readonly thinking: string | undefined;
	/** The sampling params the child sends, or `undefined` when the role says nothing (see `samplingLabel`). */
	readonly sampling: string | undefined;
}

/**
 * The request the child sends: the role's thinking level and sampling params folded onto the run's model.
 *
 * `sessionModel` is the model the run settled on — the pin when one resolved, the session's own otherwise — and
 * `role` is the role the run actually uses, budgets and all, because `thinkingLevel` is read off that object.
 */
export function resolveChildRequest(args: {
	role: Role;
	sessionModel: Model<Api>;
	overridden: boolean;
	sessionThinkingLevel: ThinkingLevel;
	onWarning: RequestWarning;
}): ChildRequest {
	const { role, sessionModel: model, overridden, sessionThinkingLevel, onWarning } = args;
	// A role may retune the request for the child only. Both the sampling and the thinking level are applied
	// to a *clone* of the model: `ctx.model` is the parent session's own object, and writing to it would
	// retune the session that delegated the work (see sampling.ts).
	const askedLevel = roleThinkingLevel(role, sessionThinkingLevel);
	const childLevel = childThinkingLevel(model, askedLevel);
	const sampling = applyRoleSampling(model, role, childLevel);
	const samplingText = samplingLabel(sampling.applied) || undefined;
	// A thinking level is the other thing a role changes invisibly, and the model can move it on its own: a
	// child told to think "high" on a model that has no "high" runs at whatever the clamp lands on, and
	// nothing else in the answer would say so (see `childThinkingLabel`).
	const thinkingText = childThinkingLabel(model, askedLevel, childLevel, !!role.thinkingLevel);
	if (sampling.ignored) {
		// `asked`, not `applied`: a role whose params are all keyed to another thinking level still asked for
		// them, and a warning that named nothing would be the feature failing quietly.
		const text = samplingLabel(sampling.asked) || `thinkingLevel "${role.thinkingLevel}"`;
		onWarning(`[subagent] ${model?.api} ignores sampling params — ${text} was not sent`);
	}
	const label = modelLabel(sampling.model, overridden);
	return { model: sampling.model, thinkingLevel: childLevel, label, thinking: thinkingText, sampling: samplingText };
}
