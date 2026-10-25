import { afterEach, describe, expect, it } from "vitest";
import { appendPersisted, appendSession, clearSession, createSessionGrants, persistedFile, resetPersisted } from "../grants.ts";
import { defaultLogPath, redact, reviewLog } from "../log.ts";
import { clearPolicyCache, loadPolicy } from "../policy.ts";
import { extract } from "../inspect.ts";
import type { GrantOffer } from "../policy.ts";
import { gateDoc, makeFixture, readJson, writeGlobalConfig, type Fixture } from "./fixture.ts";

let fixture: Fixture | undefined;

const offer = (pattern: string, persisted: boolean, surface = "bash"): GrantOffer => ({ surface, pattern, label: pattern, persisted });

afterEach(() => {
	fixture?.cleanup();
	fixture = undefined;
	clearPolicyCache();
});

describe("session grants", () => {
	it("live in memory and are cleared without touching a file", () => {
		const grants = createSessionGrants();
		appendSession(grants, offer("git commit *", false));
		expect(grants).toEqual([{ surface: "bash", pattern: "git commit *", action: "allow" }]);
		clearSession(grants);
		expect(grants).toEqual([]);
	});

	it("deduplicates the same pattern", () => {
		const grants = createSessionGrants();
		appendSession(grants, offer("ls", false));
		appendSession(grants, offer("ls", false));
		expect(grants).toHaveLength(1);
	});
});

describe("persisted grants", () => {
	it("appends both of two sequential grants", async () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, gateDoc({ bash: { "*": "ask" } }));
		await appendPersisted(offer("git commit -m x", true), "global", fixture.cwd);
		await appendPersisted(offer("cargo build", true), "global", fixture.cwd);

		const file = persistedFile("global", fixture.cwd);
		const doc = readJson(file) as { gate: { grants: { global: unknown[] }; permission: unknown } };
		expect(doc.gate.grants.global).toHaveLength(2);
		expect(doc.gate.permission).toEqual({ bash: { "*": "ask" } });
	});

	it("keeps the file valid and re-readable by the policy loader", async () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, gateDoc({ bash: { "*": "ask" } }));
		await appendPersisted(offer("ls", true), "global", fixture.cwd);
		clearPolicyCache();
		const policy = loadPolicy(fixture.cwd, true, fixture.agentDir);
		expect(policy.errors).toEqual([]);
		expect(extract("bash", { command: "ls" }, fixture.cwd, { callId: "c" }).toolName).toBe("bash");
		expect(policy.rules.filter((rule) => rule.origin === "grant")).toHaveLength(1);
	});

	it("merges concurrent writes from the same process instead of losing one", async () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, gateDoc({ bash: { "*": "ask" } }));
		await Promise.all([
			appendPersisted(offer("git status", true), "global", fixture.cwd),
			appendPersisted(offer("git diff", true), "global", fixture.cwd),
		]);
		const doc = readJson(persistedFile("global", fixture.cwd)) as { gate: { grants: { global: { pattern: string }[] } } };
		const patterns = doc.gate.grants.global.map((grant) => grant.pattern).sort();
		expect(patterns).toEqual(["git diff", "git status"]);
	});

	it("writes project grants to the project file only", async () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, gateDoc({ bash: { "*": "ask" } }));
		const written = await appendPersisted(offer("go test ./...", true), "project", fixture.cwd);
		expect(written.ok).toBe(true);
		expect(written.file).toContain(".pi/extensions/pi-gate/config.json");
		const globalDoc = readJson(persistedFile("global", fixture.cwd)) as { gate?: { grants?: unknown } };
		expect(globalDoc.gate?.grants).toBeUndefined();
	});

	it("clears grants on reset", async () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, gateDoc({ bash: { "*": "ask" } }));
		await appendPersisted(offer("ls", true), "global", fixture.cwd);
		const cleared = await resetPersisted("global", fixture.cwd);
		expect(cleared.ok).toBe(true);
		const doc = readJson(persistedFile("global", fixture.cwd)) as { gate: { grants: { global: unknown[] } } };
		expect(doc.gate.grants.global).toEqual([]);
	});

	it("refuses to write into an unparseable config instead of clobbering it", async () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, "{ not json ");
		const result = await appendPersisted(offer("ls", true), "global", fixture.cwd);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/invalid JSON/);
	});
});

describe("review log", () => {
	it("redacts credential-looking values", () => {
		expect(redact("curl -H 'Authorization: Bearer abc123' https://x")).toContain("<redacted>");
		expect(redact("AWS_ACCESS_KEY_ID=AKIA1234 aws s3 ls")).toBe("AWS_ACCESS_KEY_ID=AKIA1234 aws s3 ls");
		expect(redact("--password=hunter2")).toContain("<redacted>");
	});

	it("appends one line per entry", async () => {
		fixture = makeFixture();
		const path = `${fixture.root}/review.jsonl`;
		await reviewLog(path, { ts: "t", callId: "c", toolName: "bash", surface: "bash", resolution: "once" });
		await reviewLog(path, { ts: "t", callId: "d", toolName: "bash", surface: "bash", resolution: "abort" });
		const { readFileSync } = await import("node:fs");
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
	});

	it("defaults to a path inside the agent dir", () => {
		expect(defaultLogPath()).toContain("extensions/pi-gate/logs/review.jsonl");
	});
});
