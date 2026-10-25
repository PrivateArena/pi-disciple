import { describe, expect, it } from "vitest";
import { extract, redirectTargets, shellSegments } from "../inspect.ts";

const CALL = { callId: "call-1" };

describe("extract", () => {
	it("splits a bash command into segments and finds redirect targets", () => {
		const facts = extract("bash", { command: "cat /etc/hosts > .env" }, "/repo", CALL);
		expect(shellSegments(facts)).toEqual(["cat /etc/hosts > .env"]);
		expect(facts.paths).toContain("/etc/hosts");
		expect(facts.paths).toContain("/repo/.env");
	});

	it("splits chained commands into one fact per segment", () => {
		const facts = extract("bash", { command: "git status && rm -rf build" }, "/repo", CALL);
		expect(shellSegments(facts)).toEqual(["git status", "rm -rf build"]);
	});

	it("resolves read paths to absolute spellings", () => {
		const facts = extract("read", { path: "src/a.ts" }, "/repo", CALL);
		expect(facts.surfaces).toEqual([["read", ["/repo/src/a.ts"]]]);
		expect(facts.paths).toContain("/repo/src/a.ts");
	});

	it("treats a third-party tool's path-like parameters as paths", () => {
		const facts = extract("mcp__fs__write_file", { file_path: "/tmp/x", size: 3 }, "/repo", CALL);
		expect(facts.surfaces[0]?.[0]).toBe("mcp__fs__write_file");
		expect(facts.paths).toContain("/tmp/x");
	});

	it("records the parent call id of a nested call", () => {
		const facts = extract("ls", { path: "." }, "/repo", { callId: "ID/1", parentCallId: "ID" });
		expect(facts.parentCallId).toBe("ID");
	});

	it("extracts only the write targets of a redirect", () => {
		expect(redirectTargets("echo hi > out/log.txt")).toEqual(["out/log.txt"]);
		expect(redirectTargets("cmd 2> /tmp/err.log < /dev/null")).toEqual(["/tmp/err.log"]);
	});

	it("does not invent paths for a bare command", () => {
		const facts = extract("bash", { command: "pwd" }, "/repo", CALL);
		expect(facts.paths).toEqual([]);
	});
});
