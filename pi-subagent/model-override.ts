/**
 * Config-driven child model (plan step 10's "config overrides" slot, model side).
 *
 * The child's model is inherited from the parent unless the human pins one with
 * `subagent.model` in `extensions/pi-gate/config.json`. The reference is human-authored, never
 * model-authored, so it cannot be steered into a cheaper or more powerful model by prompt injection —
 * which is why `subagent(role, task)` still takes no model parameter (see index.ts header).
 *
 * Syntax mirrors pi's own model references: `provider/id` (pi's CLI form), `provider:id`, or a bare
 * `id`. Gateway ids contain slashes and colons themselves (`minimax/minimax-m2.7:free`), so a prefix
 * is only read as a provider when the registry actually knows it.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface ModelRef {
	/** Undefined for a bare id, which is looked up in the parent's provider. */
	provider: string | undefined;
	modelId: string;
}

export type ChildModelResolution =
	| { status: "resolved"; model: Model<Api>; /** Normalised `provider/id` for display. */ ref: string; overridden: boolean }
	| { status: "error"; message: string };

/**
 * Split `provider/id` / `provider:id` at the first separator — but only when the prefix really names
 * a provider. Gateway ids contain slashes and colons themselves, so `minimax/minimax-m2.7:free` typed
 * bare must stay one id (pi's `splitProviderPrefix` applies the same guard). `isProvider` comes from
 * the registry, which is the only place that knows the installed provider ids.
 */
export function parseModelRef(input: string, isProvider: (prefix: string) => boolean): ModelRef | undefined {
	const text = input.trim();
	if (!text || text.startsWith("/") || text.startsWith(":")) return undefined;
	for (const split of candidateSplits(text)) if (isProvider(split.provider)) return split;
	return { provider: undefined, modelId: text };
}

function candidateSplits(text: string): { provider: string; modelId: string }[] {
	const splits: { provider: string; modelId: string }[] = [];
	const slash = text.indexOf("/");
	if (slash > 0 && slash < text.length - 1) splits.push({ provider: text.slice(0, slash), modelId: text.slice(slash + 1) });
	const colon = text.indexOf(":");
	if (colon > 0 && colon < text.length - 1) splits.push({ provider: text.slice(0, colon), modelId: text.slice(colon + 1) });
	return splits;
}

/**
 * Resolve the configured reference against the session's registry. Every failure names the exact
 * value that was tried, so a typo is fixable from the message alone.
 */
export function resolveChildModel(reference: string, registry: ModelRegistry, parent?: Model<Api>): ChildModelResolution {
	const models = registry.getAll();
	const hasProvider = (prefix: string) => models.some((model) => model.provider === prefix);
	const ref = parseModelRef(reference, hasProvider);
	if (!ref) return { status: "error", message: `"${reference}" is not a usable model reference` };

	if (ref.provider !== undefined) {
		const found = models.find((model) => model.provider === ref.provider && model.id === ref.modelId);
		if (found) return describe(found, true);
		const known = models.filter((model) => model.provider === ref.provider);
		const samples = known.slice(0, 5).map((model) => model.id).join(", ");
		return { status: "error", message: `model "${ref.modelId}" not found for provider "${ref.provider}" (subagent.model: "${reference}"; e.g. ${samples})` };
	}

	const matches = models.filter((model) => model.id === ref.modelId);
	if (!matches.length) return { status: "error", message: `no model with id "${ref.modelId}" (subagent.model: "${reference}")` };
	const fromParent = parent ? matches.find((model) => model.provider === parent.provider) : undefined;
	const chosen = fromParent ?? matches[0]!;
	if (!fromParent && matches.length > 1) {
		return { status: "error", message: `id "${ref.modelId}" exists in ${matches.length} providers (${matches.map((m) => m.provider).join(", ")}); write "provider/${ref.modelId}"` };
	}
	return describe(chosen, true);
}

/** Which thinking level the child may request: a non-reasoning model cannot take any level but "off". */
export function childThinkingLevel(model: Model<Api> | undefined, requested: ThinkingLevel): ThinkingLevel {
	if (!model?.reasoning && requested !== "off") return "off";
	return requested;
}

/** Display label for the result header, e.g. `local/qwen3.8-flash-next (inherited from session)`. */
export function modelLabel(model: Model<Api> | undefined, overridden: boolean): string | undefined {
	if (!model) return undefined;
	return `${model.provider}/${model.id} ${overridden ? "(config override)" : "(inherited)"}`;
}

function describe(model: Model<Api>, overridden: boolean): { status: "resolved"; model: Model<Api>; ref: string; overridden: boolean } {
	return { status: "resolved", model, ref: `${model.provider}/${model.id}`, overridden };
}
