/**
 * pi-gate — a multi-scope permission gate for pi (plan steps 8 and 9).
 *
 * Scopes, lowest precedence first: built-in defaults, `~/.pi/agent/extensions/pi-gate/config.json`,
 * `<cwd>/.pi/extensions/pi-gate/config.json` (trusted projects only), `grants.global`,
 * `grants.project`, and in-memory session grants. Dialog choices: allow once / this session / this
 * project / all projects / abort / abort with reason.
 *
 * The gate applies to every `tool_call` in the session, including the nested calls a subagent makes
 * through the parent's tool pipeline — which is why `pi-subagent` needs no permission code at all.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { isFullyDenied, loadPolicy, type Policy, recomputeActive, resolveConfigPaths, withSessionGrants } from "./policy.ts";
import { writeDefaultConfig } from "./config-file.ts";
import { clearSession, createSessionGrants, resetPersisted, type PersistedScope } from "./grants.ts";
import { handleToolCall, type GateState } from "./handle.ts";
import { ALLOW_ALL_WINDOW_MS, type AllowAll } from "./policy.ts";
import { DEFAULT_GATE_CONFIG, type GrantRule } from "./schema.ts";

export default function piGate(pi: ExtensionAPI) {
	let policy: Policy | undefined;
	const sessionGrants: GrantRule[] = createSessionGrants();
	const hiddenByGate = new Set<string>();
	const subagentCalls = new Map<string, { role: string; task: string }>();
	let offForSession = false;
	let allowAll: AllowAll | undefined;
	let allowAllTimer: ReturnType<typeof setTimeout> | undefined;

	pi.registerFlag("no-gate", { type: "boolean", default: false, description: "Disable the permission gate for this run" });

	const disabled = () => offForSession || pi.getFlag("no-gate") === true;

	/** Seed the shipped config on a clean install (step 2), so the human has something to edit. */
	const seedConfig = (file: string): string => {
		let text: string;
		try {
			text = readFileSync(new URL("./config.json", import.meta.url), "utf8");
		} catch {
			text = JSON.stringify({ gate: { ...DEFAULT_GATE_CONFIG } }, null, 2);
		}
		const written = writeDefaultConfig(file, text);
		return written.created ? file : (written.error ?? file);
	};

	const refresh = (ctx: ExtensionContext): Policy => {
		const loaded = loadPolicy(ctx.cwd, ctx.isProjectTrusted(), getAgentDir());
		policy = withSessionGrants(loaded, sessionGrants);
		return policy;
	};

	const report = (ctx: ExtensionContext, current: Policy) => {
		for (const error of current.errors.slice(0, 4)) ctx.ui.notify(`[gate] ${error}`, "warning");
	};

	/** Step 9: a grant can un-hide a tool, a deny can hide one, before the next agent run. */
	const applyToolVisibility = (current: Policy) => {
		const active = new Set(pi.getActiveTools());
		let changed = false;
		for (const tool of pi.getAllTools()) {
			if (isFullyDenied(tool.name, current)) {
				if (active.delete(tool.name)) {
					hiddenByGate.add(tool.name);
					changed = true;
				}
			} else if (hiddenByGate.has(tool.name)) {
				active.add(tool.name);
				hiddenByGate.delete(tool.name);
				changed = true;
			}
		}
		if (changed || active.size !== pi.getActiveTools().length) pi.setActiveTools([...active]);
	};

	const footer = (ctx: ExtensionContext) => {
		const on = !disabled() && policy?.config.enabled !== false;
		if (!on) return ctx.ui.setStatus("pi-gate", "gate: off");
		const base = `gate: on · ${policy?.files.length ?? 0} file(s)`;
		if (!allowAll) return ctx.ui.setStatus("pi-gate", base);
		const mode = allowAll.until === null ? "allow-everything: session" : `allow-everything: ${Math.max(0, Math.round((allowAll.until - Date.now()) / 1000))}s`;
		ctx.ui.setStatus("pi-gate", `${base} · ${mode}`);
	};

	/** The timed window has to close on its own — a status line is not a timer. */
	const applyAllowAll = (ctx: ExtensionContext, next: AllowAll | undefined) => {
		allowAll = next;
		if (allowAllTimer) clearTimeout(allowAllTimer);
		allowAllTimer = undefined;
		const until = next?.until;
		if (typeof until === "number") {
			const remaining = Math.max(0, until - Date.now());
			allowAllTimer = setTimeout(() => {
				allowAll = undefined;
				allowAllTimer = undefined;
				footer(ctx);
				ctx.ui.notify(`[gate] allow-everything window (${Math.round(ALLOW_ALL_WINDOW_MS / 60_000)} min) expired — approvals are back on`, "info");
			}, remaining);
		}
		footer(ctx);
	};

	const state = (ctx: ExtensionContext): GateState => ({
		// Reload per call: `loadPolicy` is mtime-stamped, so config edits apply without a restart (step 5).
		policy: refresh(ctx),
		sessionGrants,
		allowAll,
		subagentCalls,
		policyChanged: (next: Policy) => {
			policy = next;
			applyToolVisibility(next);
		},
		allowAllChanged: (next: AllowAll) => applyAllowAll(ctx, next),
	});

	pi.on("session_start", (_event, ctx) => {
		clearSession(sessionGrants);
		hiddenByGate.clear();
		subagentCalls.clear();
		allowAll = undefined;
		if (allowAllTimer) clearTimeout(allowAllTimer);
		allowAllTimer = undefined;
		const current = refresh(ctx);
		if (current.files.length === 0) {
			const seeded = seedConfig(resolveConfigPaths(ctx.cwd, true).globalFile);
			ctx.ui.notify(
				`[gate] no config file — using built-in defaults (${Object.keys(DEFAULT_GATE_CONFIG.permission).length} surfaces, bash = ask); wrote ${seeded}. ` +
					`Edit it and run /gate reload.`,
				"info",
			);
			footer(ctx);
		}
		report(ctx, current);
		footer(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearSession(sessionGrants);
		hiddenByGate.clear();
		subagentCalls.clear();
		allowAll = undefined;
		if (allowAllTimer) clearTimeout(allowAllTimer);
		allowAllTimer = undefined;
		ctx.ui.setStatus("pi-gate", undefined);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (disabled()) return;
		return handleToolCall(event, ctx, state(ctx));
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (disabled()) return;
		applyToolVisibility(policy ?? refresh(ctx));
	});

	pi.registerCommand("gate", {
		description: "Permission gate: status | grants | reload | allow [off|5min|session] | reset grants [project|global] | off | on",
		async handler(args: string, ctx: ExtensionContext) {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "status").toLowerCase();

			if (sub === "off" || sub === "on") {
				offForSession = sub === "off";
				footer(ctx);
				ctx.ui.notify(offForSession ? "[gate] off for this session" : "[gate] on", offForSession ? "warning" : "info");
				return;
			}
			if (sub === "reload") {
				hiddenByGate.clear();
				const current = refresh(ctx);
				applyToolVisibility(current);
				footer(ctx);
				report(ctx, current);
				ctx.ui.notify(`[gate] reloaded ${current.files.length || "no"} config file(s), ${current.rules.length} rule(s)`, "info");
				return;
			}
			if (sub === "allow") {
				const mode = (parts[1] ?? "off").toLowerCase();
				if (mode === "off") {
					applyAllowAll(ctx, undefined);
					ctx.ui.notify("[gate] allow-everything is off", "info");
					return;
				}
				const next: AllowAll = mode === "session" ? { until: null } : { until: Date.now() + ALLOW_ALL_WINDOW_MS };
				applyAllowAll(ctx, next);
				ctx.ui.notify(next.until === null ? "[gate] allow-everything on for this session (protected paths still ask)" : "[gate] allow-everything on for 5 minutes (protected paths still ask)", "warning");
				return;
			}
			if (sub === "reset") {
				const kind: PersistedScope = parts[1] === "project" ? "project" : "global";
				const result = await resetPersisted(kind, ctx.cwd);
				refresh(ctx);
				ctx.ui.notify(
					result.ok ? `[gate] cleared ${kind} grants in ${result.file}` : `[gate] reset failed: ${result.error}`,
					result.ok ? "info" : "error",
				);
				return;
			}
			if (sub === "grants") {
				const current = policy ?? refresh(ctx);
				const persisted = current.rules.filter((rule) => rule.origin === "grant");
				const body = [
					`session grants (${sessionGrants.length}, memory only):`,
					...(sessionGrants.length ? sessionGrants.map((g) => `  · ${g.surface} "${g.pattern}" ${g.action}`) : ["  (none)"]),
					`persisted grants (${persisted.length}):`,
					...(persisted.length ? persisted.map((r) => `  · [${r.scope}] ${r.surface} "${r.pattern}" ${r.action}`) : ["  (none)"]),
				].join("\n");
				await ctx.ui.editor("pi-gate grants", body);
				return;
			}

			const current = policy ?? refresh(ctx);
			const tools = pi.getAllTools().map((tool) => tool.name);
			const body = [
				`enabled: ${current.config.enabled && !disabled() ? "yes" : "no"}${pi.getFlag("no-gate") === true ? " (--no-gate)" : offForSession ? " (/gate off)" : ""}`,
				`review log: ${current.config.reviewLog ? "on" : "off"} · prompt timeout: ${current.config.promptTimeoutMs || "wait"}`,
				`config files: ${current.files.length ? current.files.join(", ") : "none (built-in defaults)"}`,
				`trusted project dir: ${ctx.isProjectTrusted() ? "yes" : "no (project config ignored)"}`,
				`session grants: ${sessionGrants.map((g) => `${g.surface} "${g.pattern}"`).join(", ") || "none"}`,
				`allow-everything: ${!allowAll ? "off" : allowAll.until === null ? "on for this session" : `on for ${Math.max(0, Math.round((allowAll.until - Date.now()) / 1000))}s`} (protected paths, external files, hidden arguments still ask)`,
				`hidden tools: ${[...hiddenByGate].join(", ") || "none"}`,
				`rules: ${current.rules.length} · visible tools: ${recomputeActive(tools, current).length}/${tools.length}`,
				`bash surface: ${JSON.stringify(current.config.permission.bash ?? DEFAULT_GATE_CONFIG.permission.bash)}`,
				current.errors.length ? `problems:\n${current.errors.map((e) => `  · ${e}`).join("\n")}` : "problems: none",
			].join("\n");
			await ctx.ui.editor("/gate status", body);
		},
	});
}
