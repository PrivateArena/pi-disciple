import { describe, expect, it } from "vitest";
import {
	BASH_ARITY,
	directoryPattern,
	displaySnippet,
	expandHome,
	hasUnparsedExpansion,
	isExternalPath,
	isProtectedPath,
	isScopedRule,
	isUnder,
	pathPatternMatches,
	pathSpellings,
	peelEnvPrefix,
	protectedPathGlobs,
	segmentCommands,
	suggestBashPattern,
	tokenize,
	wildcardMatch,
	isWrappedSegment,
	normaliseCommand,
} from "../match.ts";

describe("wildcardMatch", () => {
	it("treats * as any characters including /", () => {
		expect(wildcardMatch("/home/user/*", "/home/user/a/b/c.ts")).toBe(true);
		expect(wildcardMatch("*.env", "/a/b/.env")).toBe(true);
		expect(wildcardMatch("git *", "git status --short")).toBe(true);
		expect(wildcardMatch("git *", "git")).toBe(true); // a grant for `git *` covers a bare `git`
	});

	it("treats ? as exactly one character", () => {
		expect(wildcardMatch("v?", "v1")).toBe(true);
		expect(wildcardMatch("v?", "v12")).toBe(false);
	});

	it("expands ~ and $HOME in patterns", () => {
		expect(wildcardMatch("~/.pi/*", expandHome("~/.pi/agent/x"))).toBe(true);
	});

	it("matches the bare prefix of a `… *` pattern", () => {
		expect(wildcardMatch("git status *", "git status")).toBe(true);
		expect(wildcardMatch("git status *", "git status --short")).toBe(true);
		expect(wildcardMatch("git status *", "git commit")).toBe(false);
	});
});

describe("pathSpellings", () => {
	it("resolves relative, dot-dot, and trailing slashes against cwd", () => {
		const spellings = pathSpellings("./src/../src/a.ts/", "/repo");
		expect(spellings).toContain("/repo/src/a.ts");
	});

	it("includes a realpath spelling when the path exists", () => {
		const spellings = pathSpellings(".", process.cwd());
		expect(spellings.length).toBeGreaterThanOrEqual(1);
		expect(spellings.every((s) => s.startsWith("/"))).toBe(true);
	});
});

describe("isUnder / external", () => {
	it("detects containment", () => {
		expect(isUnder("/a/b/c", "/a/b")).toBe(true);
		expect(isUnder("/a", "/a")).toBe(true);
		expect(isUnder("/other", "/a")).toBe(false);
	});

	it("flags paths with no spelling inside cwd", () => {
		expect(isExternalPath(["/etc/hosts"], "/repo")).toBe(true);
		expect(isExternalPath(["/repo/x"], "/repo")).toBe(false);
	});
});

describe("folder grants", () => {
	it("names the containing directory of a file, and the directory itself", () => {
		expect(directoryPattern("/repo/src/a.ts")).toBe("/repo/src/*");
		expect(directoryPattern("/repo/src/")).toBe("/repo/src/*");
		expect(directoryPattern(process.cwd())).toBe(`${process.cwd()}/*`); // an existing directory: itself, not its parent
	});

	it("matches the directory as well as everything under it", () => {
		expect(pathPatternMatches("/a/b/*", "/a/b/c.ts")).toBe(true);
		expect(pathPatternMatches("/a/b/*", "/a/b/c/d.ts")).toBe(true);
		expect(pathPatternMatches("/a/b/*", "/a/b")).toBe(true); // `ls <dir>` is covered by that dir's grant
		expect(pathPatternMatches("/a/b/*", "/a/bb")).toBe(false);
		expect(pathPatternMatches("/a/b", "/a/b")).toBe(true);
	});

	it("separates a scoped rule from a class-wide one", () => {
		expect(isScopedRule({ surface: "path", pattern: "/a/*" })).toBe(true);
		expect(isScopedRule({ surface: "path", pattern: "*" })).toBe(false);
		expect(isScopedRule({ surface: "*", pattern: "*" })).toBe(false);
		expect(isScopedRule(undefined)).toBe(false);
	});
});

describe("protected paths", () => {
	const globs = protectedPathGlobs("/repo", "/agent");

	it("floors the gate's own config and pi's config dir", () => {
		expect(isProtectedPath(["/agent/extensions/pi-gate/config.json"], globs)).toBe(true);
		expect(isProtectedPath(["/repo/.pi/extensions/pi-gate/config.json"], globs)).toBe(true);
		expect(isProtectedPath(["/repo/src/app.ts"], globs)).toBe(false);
	});

	it("floors git hooks wherever the repo lives", () => {
		expect(isProtectedPath(["/any/repo/.git/hooks/pre-commit"], globs)).toBe(true);
	});
});

describe("segmentCommands", () => {
	it("splits chains", () => {
		expect(segmentCommands("cd /a && rm -rf b || echo hi")).toHaveLength(3);
	});

	it("does not split quoted text", () => {
		expect(segmentCommands("echo 'a && b'")).toEqual(["echo 'a && b'"]);
	});

	it("splits pipes, semicolons, background & and newlines", () => {
		expect(segmentCommands("make | tee log; sync &\ndone")).toEqual(["make", "tee log", "sync", "done"]);
	});

	it("keeps a heredoc body as one segment", () => {
		const segments = segmentCommands("cat <<EOF\nrm -rf /\nEOF");
		expect(segments).toHaveLength(1);
		expect(segments[0]).toContain("rm -rf /");
	});

	it("keeps process substitution and subshells together", () => {
		expect(segmentCommands("diff <(git show a) <(cat b)")).toHaveLength(1);
		expect(segmentCommands("(cd x; ls) | wc -l")).toEqual(["(cd x; ls)", "wc -l"]);
	});

	it("rejoins backslash continuations", () => {
		expect(segmentCommands("git commit \\\n -m x")).toEqual(["git commit   -m x"]);
	});
});

describe("env prefix, expansion and wrapper floors", () => {
	it("peels leading assignments", () => {
		expect(peelEnvPrefix("FOO=1 BAR=x cmd arg")).toEqual({ command: "cmd arg", stripped: ["FOO", "BAR"] });
	});

	it("detects unparsed expansion but not a plain variable", () => {
		expect(hasUnparsedExpansion("echo $(rm x)")).toBe(true);
		expect(hasUnparsedExpansion("echo `date`")).toBe(true);
		expect(hasUnparsedExpansion("echo $HOME/x")).toBe(false);
		expect(hasUnparsedExpansion("echo 'a $(b)'")).toBe(false);
	});

	it("escalates wrappers, including absolute paths", () => {
		expect(isWrappedSegment("/usr/bin/sudo ls")).toBe(true);
		expect(isWrappedSegment("timeout 5 make")).toBe(true);
		expect(isWrappedSegment("command rm -rf x")).toBe(true);
		expect(isWrappedSegment("bash -c 'rm -rf /'")).toBe(true);
		expect(isWrappedSegment("git status")).toBe(false);
	});

	it("only escalates interpreters for -c/-e or a pipeline", () => {
		expect(isWrappedSegment("python3 script.py")).toBe(false);
		expect(isWrappedSegment("python3 -c 'x'")).toBe(true);
		expect(isWrappedSegment("sh", true)).toBe(true);
	});
});

describe("suggested grant patterns", () => {
	it("wildcards the same way for every scope, keeping a two-word tool meaningful", () => {
		expect(suggestBashPattern("git status --short")).toBe("git status *");
		expect(suggestBashPattern("npm run build --watch")).toBe("npm run *");
		expect(BASH_ARITY.git).toBe(2);
	});

	it("keeps destructive and wrapper commands exact", () => {
		expect(suggestBashPattern("rm -rf build")).toBe("rm -rf build");
		expect(suggestBashPattern("sudo reboot now")).toBe("sudo reboot now");
		expect(suggestBashPattern("bash -c 'rm -rf /'")).toBe("bash -c 'rm -rf /'");
	});

	it("normalises whitespace before turning a command into a rule", () => {
		expect(suggestBashPattern("git   status   --short")).toBe("git status *");
		expect(normaliseCommand("a\t b")).toBe("a b");
	});
});

describe("displaySnippet", () => {
	it("strips control characters and ANSI, and marks truncation", () => {
		expect(displaySnippet("echo\u0000 hi\u001b[31mred")).toBe("echo hired");
		expect(displaySnippet("x".repeat(50), 10)).toContain("[…truncated]");
	});
});

describe("tokenize", () => {
	it("respects quotes", () => {
		expect(tokenize('git commit -m "add gate, not grants"')).toEqual(["git", "commit", "-m", "add gate, not grants"]);
	});
});

describe("redirects are not separators", () => {
	it("keeps file-descriptor redirects inside their command", () => {
		expect(segmentCommands("ls src 2>&1")).toEqual(["ls src 2>&1"]);
		expect(segmentCommands("cmd &> log")).toEqual(["cmd &> log"]);
		expect(segmentCommands("cmd <&0")).toEqual(["cmd <&0"]);
		expect(segmentCommands("a & b")).toEqual(["a", "b"]);
	});
});
