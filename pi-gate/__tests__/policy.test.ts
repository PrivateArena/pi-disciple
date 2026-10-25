import { afterEach, describe, expect, it } from "vitest";
import {
	allowAllActive,
	clearPolicyCache,
	evaluate,
	isFullyDenied,
	loadPolicy,
	noSafetyFloor,
	type Policy,
	recomputeActive,
	resolveConfigPaths,
	withSessionGrants,
} from "../policy.ts";
import { extract } from "../inspect.ts";
import { DEFAULT_GATE_CONFIG } from "../schema.ts";
import { gateDoc, makeFixture, writeGlobalConfig, writeProjectConfig, type Fixture } from "./fixture.ts";

let fixture: Fixture | undefined;

function setup(globalPermission: unknown, projectPermission?: unknown): { policy: Policy; cwd: string; agentDir: string } {
	fixture = makeFixture();
	writeGlobalConfig(fixture, gateDoc(globalPermission));
	if (projectPermission !== undefined) writeProjectConfig(fixture, gateDoc(projectPermission));
	clearPolicyCache();
	const policy = loadPolicy(fixture.cwd, true, fixture.agentDir);
	return { policy, cwd: fixture.cwd, agentDir: fixture.agentDir };
}

function actionOf(policy: Policy, cwd: string, toolName: string, input: Record<string, unknown>): string {
	return evaluate(extract(toolName, input, cwd, { callId: "t" }), policy).action;
}

afterEach(() => {
	fixture?.cleanup();
	fixture = undefined;
	clearPolicyCache();
});

describe("layering and precedence", () => {
	it("last matching pattern wins within one fact, across files", () => {
		const { policy, cwd } = setup(
			{ "*": "ask", bash: { "*": "ask", "git *": "allow" } },
			{ bash: { "git push *": "deny" } },
		);
		expect(actionOf(policy, cwd, "bash", { command: "git push origin main" })).toBe("deny");
		expect(actionOf(policy, cwd, "bash", { command: "git status" })).toBe("allow");
		expect(actionOf(policy, cwd, "bash", { command: "rm x" })).toBe("ask");
	});

	it("lets a project allow override a global ask", () => {
		const { policy, cwd } = setup({ bash: { "*": "ask" } }, { bash: { "go test *": "allow" } });
		expect(actionOf(policy, cwd, "bash", { command: "go test ./..." })).toBe("allow");
	});

	it("combines the facts of one call with most-restrictive-wins", () => {
		const { policy, cwd } = setup({ "*": "allow", bash: { "*": "allow", "rm *": "deny" } });
		expect(actionOf(policy, cwd, "bash", { command: "echo hi && rm -rf build" })).toBe("deny");
		expect(actionOf(policy, cwd, "bash", { command: "echo hi && git status" })).toBe("allow");
	});

	it("ignores an untrusted project config entirely", () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, gateDoc({ bash: { "*": "ask" } }));
		writeProjectConfig(fixture, gateDoc({ bash: { "*": "allow" } }));
		clearPolicyCache();
		const policy = loadPolicy(fixture.cwd, false, fixture.agentDir);
		expect(resolveConfigPaths(fixture.cwd, false, fixture.agentDir).projectFile).toBeNull();
		expect(policy.rules.some((rule) => rule.scope === "project")).toBe(false);
		expect(evaluate(extract("bash", { command: "ls" }, fixture.cwd, { callId: "t" }), policy).action).toBe("ask");
	});

	it("reports the files it actually read", () => {
		const { policy } = setup({ "*": "allow" }, { bash: { "*": "allow" } });
		expect(policy.files).toHaveLength(2);
	});
});

describe("floors", () => {
	it("escalates an allow on the gate's own config to ask", () => {
		const { policy, cwd, agentDir } = setup({ "*": "allow", path: { "*": "allow" } });
		const configFile = `${agentDir}/extensions/pi-gate/config.json`;
		expect(actionOf(policy, cwd, "write", { path: configFile, content: "{}" })).toBe("ask");
	});

	it("escalates a wrapper or an expansion to ask", () => {
		const { policy, cwd } = setup({ "*": "allow", path: { "*": "allow" } });
		expect(actionOf(policy, cwd, "bash", { command: "sudo rm -rf /tmp/x" })).toBe("ask");
		expect(actionOf(policy, cwd, "bash", { command: "echo $(rm -rf /tmp/x)" })).toBe("ask");
		expect(actionOf(policy, cwd, "bash", { command: "echo plain" })).toBe("allow");
	});

	it("never lets a per-tool allow override a path deny", () => {
		const { policy, cwd } = setup({ "*": "allow", path: { "*": "allow", "*.env": "deny" } });
		expect(actionOf(policy, cwd, "read", { path: "/repo/.env" })).toBe("deny");
	});

	it("asks for paths outside the working directory", () => {
		const { policy, cwd } = setup({ "*": "allow", path: { "*": "allow" } });
		expect(actionOf(policy, cwd, "read", { path: "/etc/passwd" })).toBe("ask");
	});

	it("escalates every allow when a config file cannot be parsed", () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, "{ this is not json");
		clearPolicyCache();
		const policy = loadPolicy(fixture.cwd, true, fixture.agentDir);
		expect(policy.degraded).toBe(true);
		expect(evaluate(extract("read", { path: "a.ts" }, fixture.cwd, { callId: "t" }), policy).action).toBe("ask");
	});
});

describe("tool visibility", () => {
	it("hides only a tool that can never be allowed", () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, gateDoc({ "*": "allow", bash: "deny" }));
		clearPolicyCache();
		const policy = loadPolicy(fixture.cwd, true, fixture.agentDir);
		expect(isFullyDenied("bash", policy)).toBe(true);
		expect(isFullyDenied("read", policy)).toBe(false);
		expect(recomputeActive(["bash", "read", "write"], policy)).toEqual(["read", "write"]);
	});

	it("keeps a tool visible when any pattern could still be allowed", () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, gateDoc({ "*": "allow", bash: { "*": "deny", "git *": "ask" } }));
		clearPolicyCache();
		const policy = loadPolicy(fixture.cwd, true, fixture.agentDir);
		expect(isFullyDenied("bash", policy)).toBe(false);
	});
});

describe("grants", () => {
	it("applies session grants above every file scope", () => {
		const { policy, cwd } = setup({ bash: { "*": "ask" } });
		const granted = withSessionGrants(policy, [{ surface: "bash", pattern: "git commit *", action: "allow" }]);
		expect(evaluate(extract("bash", { command: "git commit -m x" }, cwd, { callId: "t" }), granted).action).toBe("allow");
		expect(evaluate(extract("bash", { command: "git push" }, cwd, { callId: "t" }), granted).action).toBe("ask");
	});

	it("reads persisted grants from the file that owns them", () => {
		fixture = makeFixture();
		writeGlobalConfig(fixture, {
			gate: { enabled: true, permission: { bash: { "*": "ask" } }, grants: { global: [{ surface: "bash", pattern: "ls", action: "allow" }] } },
		});
		writeProjectConfig(fixture, {
			gate: { enabled: false, permission: { bash: { "go *": "allow" } }, grants: { project: [{ surface: "bash", pattern: "cargo build", action: "allow" }] } },
		});
		clearPolicyCache();
		const policy = loadPolicy(fixture.cwd, true, fixture.agentDir);
		expect(actionOf(policy, fixture.cwd, "bash", { command: "ls" })).toBe("allow");
		expect(actionOf(policy, fixture.cwd, "bash", { command: "cargo build" })).toBe("allow");
		expect(policy.invalidScopes).toEqual([]);
		// FM-6: a project file may not disable the gate.
		expect(policy.config.enabled).toBe(true);
		expect(policy.errors.some((error) => error.includes("enabled=false is ignored"))).toBe(true);
	});
});

describe("defaults", () => {
	it("falls back to the shipped defaults when no config file exists", () => {
		fixture = makeFixture();
		clearPolicyCache();
		const policy = loadPolicy(fixture.cwd, true, fixture.agentDir);
		expect(policy.files).toEqual([]);
		expect(policy.config.permission).toEqual(DEFAULT_GATE_CONFIG.permission);
		expect(policy.defaultAction).toBe("ask");
		expect(policy.rules.length).toBeGreaterThan(0);
		expect(policy.rules.filter((rule) => rule.scope !== "builtin")).toEqual([]);
	});

	it("defaults to ask when permission has no wildcard entry", () => {
		const { policy, cwd } = setup({ read: "allow" });
		expect(policy.defaultAction).toBe("ask");
		expect(actionOf(policy, cwd, "mcp__x__y", { value: 1 })).toBe("ask");
	});
});

describe("grant offers", () => {
	it("are one wildcard rule per segment, the same in every scope", () => {
		const { policy, cwd } = setup({ bash: { "*": "ask" } });
		const decision = evaluate(extract("bash", { command: "git status --short && npm run lint" }, cwd, { callId: "t" }), policy);
		expect(decision.grant?.patterns).toEqual(["git status *", "npm run *"]);
		expect(decision.grant?.label).toBe("git status * && npm run *");
		expect("persistedGrant" in decision).toBe(false);
	});

	it("keep a destructive command exact, so the rule cannot outgrow the call it came from", () => {
		const { policy, cwd } = setup({ bash: { "*": "ask" } });
		const decision = evaluate(extract("bash", { command: "rm -rf build/out" }, cwd, { callId: "t" }), policy);
		expect(decision.grant?.patterns).toEqual(["rm -rf build/out"]);
	});

	it("name the concrete value for a non-shell tool, since a path has no wildcard form", () => {
		const { policy, cwd } = setup({ edit: "ask" });
		const decision = evaluate(extract("edit", { path: `${cwd}/src/a.ts` }, cwd, { callId: "t" }), policy);
		expect(decision.grant?.patterns).toEqual([`${cwd}/src/a.ts`]);
	});
});

describe("allow-everything mode", () => {
	it("runs to the end of the session when no deadline is set, and expires otherwise", () => {
		expect(allowAllActive(undefined, 10)).toBe(false);
		expect(allowAllActive({ until: null }, 10)).toBe(true);
		expect(allowAllActive({ until: 11 }, 10)).toBe(true);
		expect(allowAllActive({ until: 10 }, 10)).toBe(false);
	});

	it("silences a routine approval", () => {
		const { policy, cwd } = setup({ bash: { "*": "ask" } });
		const decision = evaluate(extract("bash", { command: "git status" }, cwd, { callId: "t" }), policy);
		expect(decision.action).toBe("ask");
		expect(decision.floors).toEqual([]);
		expect(noSafetyFloor(decision)).toBe(true);
	});

	it("never silences a file outside the workspace, a protected path, or a hidden argument", () => {
		const { policy, cwd } = setup({ bash: { "*": "allow" } });
		const external = evaluate(extract("bash", { command: "cat /etc/hosts" }, cwd, { callId: "t" }), policy);
		expect(external.floors).toEqual(["external_directory"]);
		expect(noSafetyFloor(external)).toBe(false);

		const wrapper = evaluate(extract("bash", { command: "bash -c 'rm -rf /'" }, cwd, { callId: "t" }), policy);
		expect(wrapper.floors).toContain("wrapper");
		expect(noSafetyFloor(wrapper)).toBe(false);
	});
});

describe("shipped defaults inside the workspace", () => {
	it("allows edits and reads in the project, asks for shell, and refuses secret files", () => {
		fixture = makeFixture();
		clearPolicyCache();
		const policy = loadPolicy(fixture.cwd, true, fixture.agentDir);
		const cwd = fixture.cwd;
		expect(actionOf(policy, cwd, "edit", { path: `${cwd}/src/a.ts` })).toBe("allow");
		expect(actionOf(policy, cwd, "write", { path: `${cwd}/src/new.ts` })).toBe("allow");
		expect(actionOf(policy, cwd, "read", { path: `${cwd}/src/a.ts` })).toBe("allow");
		expect(actionOf(policy, cwd, "bash", { command: "ls" })).toBe("ask");
		expect(actionOf(policy, cwd, "read", { path: `${cwd}/.env` })).toBe("deny");
		expect(actionOf(policy, cwd, "read", { path: `${cwd}/.env.example` })).toBe("allow");
		expect(actionOf(policy, cwd, "edit", { path: `${cwd}/.git/hooks/pre-commit` })).toBe("ask");
		expect(actionOf(policy, cwd, "edit", { path: `${cwd}/../else/file.ts` })).toBe("ask");
	});
});
