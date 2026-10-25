import { afterEach, describe, expect, it } from "vitest";
import { appendPersisted, appendSession, clearSession, createSessionGrants, persistedFile, resetPersisted } from "../grants.ts";
import { defaultLogPath, redact, reviewLog } from "../log.ts";
import { clearPolicyCache, loadPolicy } from "../policy.ts";
import { extract } from "../inspect.ts";
import type { GrantOffer } from "../policy.ts";
import { gateDoc, makeFixture, readJson, writeGlobalConfig, type Fixture } from "./fixture.ts";

let fixture: Fixture | undefined;

const offer = (pattern: string, surface = "bash"): GrantOffer => ({ surface, patterns: [pattern], label: pattern });
/** A multi-segment offer, exactly as a chained command produces one. */
const multiOffer = (...patterns: string[]): GrantOffer => ({ surface: "bash", patterns, label: patterns.join(" && ") });

afterEach(() => {
	fixture?.cleanup();
	fixture = undefined;
	clearPolicyCache();
});

describe("session grants", () => {
	it("live in memory and are cleared without touching a file", () => {
		const grants = createSessionGrants();
		appendSession(grants, offer("git commit *"));
		expect(grants).toEqual([{ surface: "bash", pattern: "git commit *", action: "allow" }]);
		clearSession(grants);
		expect(grants).toEqual([]);
	});

	it("deduplicates the same pattern", () => {
		const grants = createSessionGrants();
		appendSession(grants, offer("ls"));
		appendSession(grants, offer("ls"));
		expect(grants).toHaveLength(1);
	});

	it("stores one rule per segment of a chained command", () => {
		const grants = createSessionGrants();
		const added = appendSession(grants, multiOffer("cd *", "git status *"));
		expect(added).toHaveLength(2);
		expect(grants).toEqual([
			{ surface: "bash", pattern: "cd *", action: "allow" },
			{ surface: "bash", pattern: "git status *", action: "allow" },
		]);
	});

	it("collapses repeated segments into one rule", () => {
		const grants = createSessionGrants();
		expect(appendSession(grants, multiOffer("ls *", "ls *"))).toHaveLength(1);
		expect(grants).toHaveLength(1);
	});

	it("appends only the segments a second chained command adds", () => {
		const grants = createSessionGrants();
		appendSession(grants, multiOffer("cd *", "git status *"));
		expect(appendSession(grants, multiOffer("cd *", "npm test *"))).toEqual([{ surface: "bash", pattern: "npm test *", action: "allow" }]);
		expect(grants).toHaveLength(3);
	});
});

describe("persisted grants", () => {
	it("appends both of two sequential grants", async () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, gateDoc({ bash: { "*": "ask" } }));
		await appendPersisted(offer("git commit -m x"), "global", fixture.cwd);
		await appendPersisted(offer("cargo build"), "global", fixture.cwd);

		const file = persistedFile("global", fixture.cwd);
		const doc = readJson(file) as { gate: { grants: { global: unknown[] }; permission: unknown } };
		expect(doc.gate.grants.global).toHaveLength(2);
		expect(doc.gate.permission).toEqual({ bash: { "*": "ask" } });
	});

	it("keeps the file valid and re-readable by the policy loader", async () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, gateDoc({ bash: { "*": "ask" } }));
		await appendPersisted(offer("ls"), "global", fixture.cwd);
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
			appendPersisted(offer("git status"), "global", fixture.cwd),
			appendPersisted(offer("git diff"), "global", fixture.cwd),
		]);
		const doc = readJson(persistedFile("global", fixture.cwd)) as { gate: { grants: { global: { pattern: string }[] } } };
		const patterns = doc.gate.grants.global.map((grant) => grant.pattern).sort();
		expect(patterns).toEqual(["git diff", "git status"]);
	});

	it("writes project grants to the project file only", async () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, gateDoc({ bash: { "*": "ask" } }));
		const written = await appendPersisted(offer("go test ./..."), "project", fixture.cwd);
		expect(written.ok).toBe(true);
		expect(written.file).toContain(".pi/extensions/pi-gate/config.json");
		const globalDoc = readJson(persistedFile("global", fixture.cwd)) as { gate?: { grants?: unknown } };
		expect(globalDoc.gate?.grants).toBeUndefined();
	});

	it("writes every segment of a chained command as its own grant", async () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, gateDoc({ bash: { "*": "ask" } }));
		const chained: GrantOffer = { surface: "bash", patterns: ["cd /repo", "git status"], label: "cd /repo && git status" };
		await appendPersisted(chained, "global", fixture.cwd);
		const doc = readJson(persistedFile("global", fixture.cwd)) as { gate: { grants: { global: { pattern: string }[] } } };
		expect(doc.gate.grants.global.map((grant) => grant.pattern)).toEqual(["cd /repo", "git status"]);
	});

	it("is idempotent for a repeated chained grant", async () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, gateDoc({ bash: { "*": "ask" } }));
		const chained: GrantOffer = { surface: "bash", patterns: ["cd /repo", "git status"], label: "cd /repo && git status" };
		await appendPersisted(chained, "global", fixture.cwd);
		await appendPersisted(chained, "global", fixture.cwd);
		const doc = readJson(persistedFile("global", fixture.cwd)) as { gate: { grants: { global: unknown[] } } };
		expect(doc.gate.grants.global).toHaveLength(2);
	});

	it("clears grants on reset", async () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, gateDoc({ bash: { "*": "ask" } }));
		await appendPersisted(offer("ls"), "global", fixture.cwd);
		const cleared = await resetPersisted("global", fixture.cwd);
		expect(cleared.ok).toBe(true);
		const doc = readJson(persistedFile("global", fixture.cwd)) as { gate: { grants: { global: unknown[] } } };
		expect(doc.gate.grants.global).toEqual([]);
	});

	it("refuses to write into an unparseable config instead of clobbering it", async () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, "{ not json ");
		const result = await appendPersisted(offer("ls"), "global", fixture.cwd);
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
