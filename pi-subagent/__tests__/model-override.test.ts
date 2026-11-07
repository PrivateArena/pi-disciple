import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { childThinkingLabel, childThinkingLevel, modelLabel, parseModelRef, resolveChildModel } from "../model-override.ts";

const model = (provider: string, id: string, reasoning = true): Model<any> =>
	({ provider, id, reasoning, contextWindow: 200_000, maxTokens: 8_000 }) as unknown as Model<any>;

const POOL: Model<any>[] = [
	model("local", "qwen3.8-flash-next", false),
	model("kilo", "minimax/minimax-m2.7:free"),
	model("kilo", "kilo-auto/free"),
	model("opencode-free", "minimax-m3.1-flash-free"),
	model("openrouter", "minimax-m3.1-flash-free"),
	model("openrouter", "minimax/minimax-m2.7:free"),
];

const registry = {
	getAll: () => POOL,
	find: (provider: string, modelId: string) => POOL.find((candidate) => candidate.provider === provider && candidate.id === modelId),
} as unknown as ModelRegistry;

const hasProvider = (prefix: string) => POOL.some((candidate) => candidate.provider === prefix);

describe("parseModelRef", () => {
	it("splits provider/id at the first slash", () => {
		expect(parseModelRef("local/qwen3.8-flash-next", hasProvider)).toEqual({ provider: "local", modelId: "qwen3.8-flash-next" });
	});

	it("keeps gateway ids intact after the provider, colons included", () => {
		expect(parseModelRef("kilo/minimax/minimax-m2.7:free", hasProvider)).toEqual({
			provider: "kilo",
			modelId: "minimax/minimax-m2.7:free",
		});
	});

	it("does not invent a provider out of an id that merely contains a slash", () => {
		expect(parseModelRef("minimax/minimax-m2.7:free", hasProvider)).toEqual({ provider: undefined, modelId: "minimax/minimax-m2.7:free" });
		expect(parseModelRef("nope/x", hasProvider)).toEqual({ provider: undefined, modelId: "nope/x" });
	});

	it("accepts the colon form the config docs use", () => {
		expect(parseModelRef("local:qwen3.8-flash-next", hasProvider)).toEqual({ provider: "local", modelId: "qwen3.8-flash-next" });
	});

	it("treats a bare id as provider-less", () => {
		expect(parseModelRef("  qwen3.8-flash-next ", hasProvider)).toEqual({ provider: undefined, modelId: "qwen3.8-flash-next" });
	});

	it("rejects empty and separator-only values", () => {
		expect(parseModelRef("   ", hasProvider)).toBeUndefined();
		expect(parseModelRef("/x", hasProvider)).toBeUndefined();
	});
});

describe("resolveChildModel", () => {
	it("resolves provider/id", () => {
		const resolved = resolveChildModel("local/qwen3.8-flash-next", registry);
		expect(resolved.status).toBe("resolved");
		if (resolved.status === "resolved") expect(resolved.ref).toBe("local/qwen3.8-flash-next");
	});

	it("resolves the colon form to the same model", () => {
		const a = resolveChildModel("local:qwen3.8-flash-next", registry);
		const b = resolveChildModel("local/qwen3.8-flash-next", registry);
		expect(a).toEqual(b);
	});

	it("resolves a gateway id whose own text contains slashes and a colon", () => {
		const resolved = resolveChildModel("kilo/minimax/minimax-m2.7:free", registry);
		expect(resolved.status).toBe("resolved");
		if (resolved.status === "resolved") expect(resolved.model.id).toBe("minimax/minimax-m2.7:free");
	});

	it("resolves a bare id when it is unique", () => {
		expect(resolveChildModel("kilo-auto/free", registry).status).toBe("resolved");
	});

	it("resolves a bare gateway id that contains a slash", () => {
		expect(resolveChildModel("kilo-auto/free", registry)).toMatchObject({ status: "resolved", ref: "kilo/kilo-auto/free" });
	});

	it("names every provider when a bare slash id is ambiguous", () => {
		const resolved = resolveChildModel("minimax/minimax-m2.7:free", registry);
		expect(resolved.status).toBe("error");
		if (resolved.status === "error") expect(resolved.message).toMatch(/kilo.*openrouter|openrouter.*kilo/);
	});

	it("names every provider when a bare id is ambiguous", () => {
		const resolved = resolveChildModel("minimax-m3.1-flash-free", registry);
		expect(resolved.status).toBe("error");
		if (resolved.status === "error") expect(resolved.message).toMatch(/openrouter/);
	});

	it("breaks an ambiguous bare id with the parent's provider", () => {
		const parent = model("opencode-free", "something-else");
		const resolved = resolveChildModel("minimax-m3.1-flash-free", registry, parent);
		expect(resolved.status).toBe("resolved");
		if (resolved.status === "resolved") expect(resolved.ref).toBe("opencode-free/minimax-m3.1-flash-free");
	});

	it("reports an unresolvable reference", () => {
		const resolved = resolveChildModel("nope/x", registry);
		expect(resolved.status).toBe("error");
		if (resolved.status === "error") expect(resolved.message).toContain("nope/x");
	});

	it("shows real ids when the model id is wrong", () => {
		const resolved = resolveChildModel("local/gpt-nope", registry);
		expect(resolved.status).toBe("error");
		if (resolved.status === "error") expect(resolved.message).toContain("qwen3.8-flash-next");
	});

	it("reports an unknown bare id", () => {
		expect(resolveChildModel("llama-9000", registry)).toMatchObject({ status: "error" });
	});
});

describe("childThinkingLevel", () => {
	it("forces off for a model that cannot reason", () => {
		expect(childThinkingLevel(model("local", "x", false), "medium")).toBe("off");
	});

	it("keeps the level for a reasoning model", () => {
		expect(childThinkingLevel(model("kilo", "x", true), "high")).toBe("high");
	});

	it("leaves off alone either way", () => {
		expect(childThinkingLevel(model("local", "x", false), "off")).toBe("off");
	});

	it("clamps to the levels the model's map actually leaves", () => {
		// A map that nulls two rungs and keeps xhigh: what `models.json` says for a Qwen endpoint whose server has
		// no `max`. This is the function that decides what the child is *reported* to have run at, so it has to be
		// pi's clamp and not just the non-reasoning guard (`sdk.js` clamps again before the wire, unchanged).
		const narrowed = model("local", "qwen", true);
		(narrowed as unknown as Record<string, unknown>).thinkingLevelMap = {
			minimal: null,
			low: "low",
			medium: "medium",
			high: null,
			xhigh: "xhigh",
			max: null,
		};
		expect(childThinkingLevel(narrowed, "high")).toBe("xhigh");
		expect(childThinkingLevel(narrowed, "minimal")).toBe("low");
		expect(childThinkingLevel(narrowed, "max")).toBe("xhigh");
		expect(childThinkingLevel(narrowed, "medium")).toBe("medium");
		// A model with no map at all has no xhigh: pi advertises that rung only when the map names it.
		expect(childThinkingLevel(model("local", "x", true), "xhigh")).toBe("high");
	});
});

describe("childThinkingLabel", () => {
	it("says nothing when the child ran on the session's own level", () => {
		expect(childThinkingLabel(model("local", "x", true), "medium", "medium", false)).toBeUndefined();
	});

	it("names the level when the role replaced the session's", () => {
		expect(childThinkingLabel(model("local", "x", true), "off", "off", true)).toBe("off");
	});

	it("names both when the model moved it", () => {
		expect(childThinkingLabel(model("local", "x", true), "high", "xhigh", false)).toBe('high → xhigh (this model has no "high")');
		expect(childThinkingLabel(model("local", "x", false), "medium", "off", false)).toBe("medium → off (this model does not think)");
		expect(childThinkingLabel(undefined, "medium", "off", false)).toBe("medium → off (this model does not think)");
	});
});

describe("modelLabel", () => {
	it("marks an override differently from an inherited model", () => {
		expect(modelLabel(model("local", "qwen3.8-flash-next"), true)).toBe("local/qwen3.8-flash-next (config override)");
		expect(modelLabel(model("local", "qwen3.8-flash-next"), false)).toBe("local/qwen3.8-flash-next (inherited)");
	});
});
