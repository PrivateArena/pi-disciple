/**
 * The `/subagentc` command wiring: the name the human types, the routing of its sections, and the
 * fact that the config actually reaches the editor text (the view itself is covered in
 * config-view.test.ts). A typo in the section name must answer, never open an empty editor.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import piSubagent from "../index.ts";
import { claimGuard, releaseGuard } from "../run.ts";

const model = (provider: string, id: string, reasoning = true): Model<any> =>
	({ provider, id, name: id, reasoning, contextWindow: 200_000, maxTokens: 8_000 }) as unknown as Model<any>;

interface Stub {
	commands: Map<string, Command>;
	names: string[];
	edits: { title: string; body: string }[];
	notices: string[];
}

function stubPi(): Stub {
	const commands = new Map<string, Command>();
	const stub: Stub = { commands, names: [], edits: [], notices: [] };
	const pi = {
		registerTool: (tool: { name: string }) => void stub.names.push(tool.name),
		registerCommand: (name: string, command: Command) => void commands.set(name, command),
		on: () => () => undefined,
		getActiveTools: () => ["read", "bash", "subagent"],
		getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "subagent" }],
	} as unknown as ExtensionAPI;
	piSubagent(pi);
	return stub;
}

function fixture(config: Record<string, unknown>): { cwd: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-sub-cmd-"));
	const cwd = join(root, "repo");
	mkdirSync(join(root, "extensions", "pi-gate"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(root, "extensions", "pi-gate", "config.json"), JSON.stringify(config), "utf8");
	process.env.PI_CODING_AGENT_DIR = root;
	return { cwd, agentDir: root };
}

function stubCtx(where: { cwd: string }, over: Record<string, unknown> = {}): ExtensionContext {
	return {
		cwd: where.cwd,
		isProjectTrusted: () => false,
		model: model("local", "qwen3.8-flash-next", false),
		thinkingLevel: "high",
		sessionManager: { getSessionDir: () => join(where.cwd, ".pi", "sessions", "s1") },
		modelRegistry: {
			getAll: () => [model("local", "qwen3.8-flash-next", false), model("kilo", "kilo-auto/free")],
			getAvailable: () => [model("kilo", "kilo-auto/free")],
		},
		ui: {
			editor: async (title: string, body?: string) => void editors.push({ title, body: body ?? "" }),
			notify: (text: string) => void notices.push(text),
		},
		...over,
	} as unknown as ExtensionContext;
}

const editors: { title: string; body: string }[] = [];
const notices: string[] = [];

type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void>; getArgumentCompletions?: (prefix: string) => { value: string }[] | null };

async function run(args: string, where: { cwd: string }, over?: Record<string, unknown>) {
	const stub = stubPi();
	await stub.commands.get("subagentc")?.handler(args, stubCtx(where, over));
	return { title: editors.at(-1)?.title ?? "", body: editors.at(-1)?.body ?? "" };
}

describe("/subagentc", () => {
	it("registers the command under the -c name and no longer as /subagents", () => {
		const stub = stubPi();
		expect([...stub.commands.keys()]).toEqual(["subagentc"]);
		expect(stub.names).toContain("subagent");
	});

	it("shows the whole config by default, naming the model and the file it came from", async () => {
		const where = fixture({ subagent: { model: "kilo/kilo-auto/free", maxTurns: 6 } });
		const { title, body } = await run("", where);
		expect(title).toBe("pi-subagent all");
		expect(body).toContain("child model: kilo/kilo-auto/free (pinned by subagent.model)");
		expect(body).toContain("maxTurns");
		expect(body).toContain("roles (hard-coded in roles.ts");
		expect(body).toContain(join(where.agentDir, "extensions", "pi-gate", "config.json"));
	});

	it("routes each section to its own view", async () => {
		const where = fixture({ subagent: { model: "kilo/kilo-auto/free" } });
		expect((await run("model", where)).body).not.toContain("roles (hard-coded");
		expect((await run("roles", where)).body).toContain("general-purpose");
		expect((await run("limits", where)).body).toContain("maxResultBytes");
	});

	it("answers a bad section name instead of opening an empty editor", async () => {
		const before = editors.length;
		const noticesBefore = notices.length;
		await run("nonsense", fixture({}));
		expect(editors.length).toBe(before);
		expect(notices[notices.length - 1]).toContain('unknown section "nonsense"');
		expect(notices.length).toBe(noticesBefore + 1);
	});

	it("keeps the running-child answer on /subagentc status", async () => {
		const where = fixture({});
		const noticesBefore = notices.length;
		claimGuard({ callId: "call-1", role: "review", startedAt: Date.now() - 5_000, abort: () => undefined });
		try {
			await run("status", where);
		} finally {
			releaseGuard("call-1");
		}
		expect(notices.length).toBe(noticesBefore + 1);
		expect(notices[notices.length - 1]).toContain("running: review for 5s (call call-1)");
		await run("status", where);
		expect(notices[notices.length - 1]).toContain("running: none");
	});

	it("completes the section names after the space", () => {
		const command = stubPi().commands.get("subagentc")!;
		expect(command.getArgumentCompletions?.("")?.map((item) => item.value)).toEqual(["all", "model", "limits", "roles", "status", "models"]);
		expect(command.getArgumentCompletions?.("mo")?.map((item) => item.value)).toEqual(["model", "models"]);
		expect(command.getArgumentCompletions?.("model ")).toBeNull();
	});

	it("lists the models a pin may name", async () => {
		const where = fixture({ subagent: { model: "kilo/kilo-auto/free" } });
		const { title, body } = await run("models", where);
		expect(title).toBe("pi-subagent models");
		expect(body).toContain("kilo/kilo-auto/free");
		expect(body).toContain("pinned as subagent.model");
		expect(body).toContain("session model");
	});
});
