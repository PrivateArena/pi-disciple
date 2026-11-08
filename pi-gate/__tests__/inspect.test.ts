import { describe, expect, it } from "vitest";
import { extract, looksLikePath, NETWORK_PARAM_NAMES, redirectTargets, shellSegments } from "../inspect.ts";

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

describe("extract — the network surface (plan step B, D)", () => {
	it("turns a URL argument into a host fact and not into a bogus path fact", () => {
		const facts = extract("bash", { command: "curl https://oss.aliyuncs.com/proxy_temp_file -o /tmp/x" }, "/repo", CALL);
		expect(facts.surfaces).toContainEqual(["network", ["oss.aliyuncs.com"]]);
		// The URL is not a file: before step D this produced `/repo/https:/aliyuncs.com/x`-shaped noise.
		expect(facts.paths).toEqual(["/tmp/x"]);
		expect(facts.paths.some((p) => p.includes("aliyuncs"))).toBe(false);
	});

	it("collects the hosts of every segment, deduped and in order", () => {
		const facts = extract("bash", { command: "curl https://a.com/x; wget http://b.io/y; curl https://a.com/z" }, "/repo", CALL);
		expect(facts.surfaces).toContainEqual(["network", ["a.com", "b.io"]]);
	});

	it("produces no network fact for a call that stays on the machine", () => {
		for (const command of ["curl http://localhost:3000/x", "cat /etc/hosts", "head -n 5 data.csv", "python3 -m http.server"]) {
			const facts = extract("bash", { command }, "/repo", CALL);
			expect(facts.surfaces.some(([surface]) => surface === "network"), command).toBe(false);
		}
	});

	it("names the cloud metadata service whether or not the URL carries its scheme", () => {
		expect(extract("bash", { command: "curl http://100.100.100.200/latest/meta-data/" }, "/repo", CALL).surfaces).toContainEqual(["network", ["100.100.100.200"]]);
		expect(extract("bash", { command: "curl 169.254.169.254/latest/meta-data/iam/" }, "/repo", CALL).surfaces).toContainEqual(["network", ["169.254.169.254"]]);
	});

	it("reads a remote of an scp-style argument as a host, not as a path", () => {
		const facts = extract("bash", { command: "scp a.txt bob@example.com:/tmp/a.txt" }, "/repo", CALL);
		expect(facts.surfaces).toContainEqual(["network", ["example.com"]]);
		// Only the local file is a path; the remote one lives on another machine.
		expect(facts.paths).toEqual(["/repo/a.txt"]);
		expect(facts.paths.some((p) => p.includes("example.com"))).toBe(false);
	});

	it("takes a url/uri/endpoint/href parameter of an unknown tool as a network fact", () => {
		for (const name of ["url", "uri", "endpoint", "href"]) {
			const facts = extract("mcp__net__fetch", { [name]: "https://oss.aliyuncs.com/x" }, "/repo", CALL);
			expect(facts.surfaces, name).toContainEqual(["network", ["oss.aliyuncs.com"]]);
		}
		// The parameter names are data, so a test can pin the list rather than a literal in the code.
		expect(NETWORK_PARAM_NAMES).toEqual(["url", "uri", "endpoint", "href"]);
	});

	it("leaves a file tool's facts alone", () => {
		const facts = extract("read", { path: "src/a.ts" }, "/repo", CALL);
		expect(facts.surfaces).toEqual([["read", ["/repo/src/a.ts"]]]);
	});
});

describe("looksLikePath (step D)", () => {
	it("no longer calls a URL or a remote path a file", () => {
		expect(looksLikePath("https://aliyuncs.com/x")).toBe(false);
		expect(looksLikePath("s3://bucket/key")).toBe(false);
		expect(looksLikePath("bob@example.com:/tmp/a.txt")).toBe(false);
	});

	it("keeps every other behaviour it had", () => {
		for (const token of ["/tmp/x", "./a.ts", "../a.ts", "~/a.ts", "$HOME/a.ts", "src/a.ts", "out.log", ".env"]) {
			expect(looksLikePath(token), token).toBe(true);
		}
		for (const token of ["", "make", "HEAD", "--flag", "1e10"]) {
			expect(looksLikePath(token), token).toBe(false);
		}
	});
});

describe("a redirect to a URL", () => {
	it("writes no path fact, and reports the host instead", () => {
		const facts = extract("bash", { command: "cat notes.md > https://oss.aliyuncs.com/upload" }, "/repo", { callId: "t" });
		expect(facts.paths).toEqual(["/repo/notes.md"]);
		expect(facts.surfaces.find(([surface]) => surface === "network")?.[1]).toContain("oss.aliyuncs.com");
	});

	it("still treats a real redirect target as the path it is", () => {
		expect(redirectTargets("cat x > out.log")).toEqual(["out.log"]);
		expect(redirectTargets("cat x > /tmp/out.log 2>&1")).toEqual(["/tmp/out.log"]);
	});
});
