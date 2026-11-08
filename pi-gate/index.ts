/**
 * pi-gate — a multi-scope permission gate for pi (plan steps 8 and 9).
 *
 * Scopes, lowest precedence first: built-in defaults, `~/.pi/agent/extensions/pi-disciple/config.json`,
 * `<cwd>/.pi/extensions/pi-disciple/config.json` (trusted projects only), `grants.global`,
 * `grants.project`, and in-memory session grants. Dialog choices: allow once / allow with a note /
 * this session / this project / all projects / abort / abort with a note / allow everything.
 *
 * A note from "allow with reason" is delivered on that call's `tool_result`, which is the only channel
 * to the model that a `tool_call` handler still has.
 *
 * The gate applies to every `tool_call` in the session, including the nested calls a subagent makes
 * through the parent's tool pipeline — which is why `pi-subagent` needs no permission code at all.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { isFullyDenied, recomputeActive } from "./policy-resolution/fact-evaluation.ts";
import type { Policy } from "./policy-resolution/call-decision.ts";
import { loadPolicy, resolveConfigPaths, withSessionGrants } from "./policy-resolution/policy-loading.ts";
import { writeDefaultConfig } from "./config-file.ts";
import { clearSession, createSessionGrants, resetPersisted, type PersistedScope } from "./grants.ts";
import { handleToolCall, attachNote, type GateState, type PendingNotes } from "./handle.ts";
import { activeRuleIds } from "./output-guard/detection.ts";
import { builtinRuleIds } from "./output-guard/rule-registry.ts";
import { createGuardBudget, refillGuardBudget, resetGuardCounters, resetGuardSession } from "./output-guard/session-budget.ts";
import { effectiveGuardAction, guardTurnEnd, type GuardTurnState } from "./output-guard/turn-end-pipeline.ts";
import { ALLOW_ALL_WINDOW_MINUTES, ALLOW_ALL_WINDOW_MS, type AllowAll } from "./policy-resolution/override-mode.ts";
import { DEFAULT_GATE_CONFIG } from "./config-contract/gate-section.ts";
import { GUARD_BUILTIN_RULE_IDS } from "./config-contract/guard-section.ts";
import { type GrantRule } from "./config-contract/action-vocabulary.ts";
import { regexPatternTimeouts } from "./pattern/regex-dialect.ts";

export default function piGate(pi: ExtensionAPI) {
	let policy: Policy | undefined;
	const sessionGrants: GrantRule[] = createSessionGrants();
	const hiddenByGate = new Set<string>();
	const subagentCalls = new Map<string, { role: string; task: string }>();
	const pendingNotes: PendingNotes = new Map();
	const guardBudget = createGuardBudget();
	let offForSession = false;
	let allowAll: AllowAll | undefined;
	let allowAllTimer: ReturnType<typeof setTimeout> | undefined;

	pi.registerFlag("no-gate", { type: "boolean", default: false, description: "Disable the permission gate for this run" });

	const disabled = () => offForSession || pi.getFlag("no-gate") === true;

	/** Seed the shipped config on a clean install (step 2), so the human has something to edit. */
	const seedConfig = (file: string): string => {
		let text: string;
		try {
			text = readFileSync(new URL("../config.json", import.meta.url), "utf8");
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
		const nudged = guardBudget.reminders > 0 ? ` · guard: ${guardBudget.reminders} reminder(s)` : "";
		const base = `gate: on · ${policy?.files.length ?? 0} file(s)${nudged}`;
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
				ctx.ui.notify(`[gate] allow-everything window (${ALLOW_ALL_WINDOW_MINUTES} min) expired — approvals are back on`, "info");
			}, remaining);
		}
		footer(ctx);
	};

	/** The guard judges output, not permissions: it needs the fresh policy too, plus the session's tool names. */
	const guardState = (ctx: ExtensionContext): GuardTurnState => ({
		policy: refresh(ctx),
		toolNames: new Set(pi.getActiveTools().map((name) => name.toLowerCase())),
		budget: guardBudget,
	});

	/** One block about the guard for `/gatec status`: what it does, what it saw, which rules are live. */
	const guardStatusLine = (ctx: ExtensionContext): string => {
		const current = policy ?? refresh(ctx);
		const guard = current.config.guard;
		const action = effectiveGuardAction(guard, guardBudget);
		const overridden = guardBudget.action !== undefined && guardBudget.action !== guard.action ? ` (session override of "${guard.action}")` : "";
		const off = [...guard.disableRules, ...guardBudget.disabled];
		const problems = current.errors.filter((error) => error.includes("gate.guard"));
		return [
			`guard: ${action === "off" ? "off" : `${action}${overridden}`}`,
			`reminders: ${guardBudget.reminders}/${guard.maxReminders} (refilled by a real tool call, or by /gatec guard reset)`,
			guardBudget.last ? `last: ${guardBudget.last.label} (${guardBudget.last.rules.join(", ")})` : "last: nothing caught",
			`rules: ${activeRuleIds(guard, guardBudget.disabled).join(", ")}`,
			off.length ? `switched off: ${off.join(", ")}` : "",
			guard.rules.length ? `configured rules: ${guard.rules.map((rule) => `${rule.id} ${rule.pattern}`).join(" · ")}` : "",
			guard.allowPatterns.length ? `vetoes: ${guard.allowPatterns.join(" · ")}` : "",
			problems.length ? `guard config problems:\n${problems.map((error) => `  · ${error}`).join("\n")}` : "",
		]
			.filter(Boolean)
			.join("\n");
	};

	/** `/gatec guard …`: session-only knobs, so a false positive is answerable mid-run without editing config. */
	const guardCommand = async (parts: string[], ctx: ExtensionContext): Promise<void> => {
		const current = policy ?? refresh(ctx);
		const verb = (parts[0] ?? "").toLowerCase();
		const knownRule = (id: string): boolean => GUARD_BUILTIN_RULE_IDS.includes(id) || current.config.guard.rules.some((rule) => rule.id === id);
		if (verb === "off" || verb === "notify" || verb === "remind") {
			guardBudget.action = verb;
			ctx.ui.notify(`[gate] guard is "${verb}" for this session (${guardBudget.reminders} reminder(s) already spent)`, "info");
			return;
		}
		if (verb === "disable" || verb === "enable") {
			const id = parts[1]?.trim();
			if (!id) {
				ctx.ui.notify(`[gate] /gatec guard ${verb} <rule-id> — built-in rules: ${builtinRuleIds().join(", ")}`, "warning");
				return;
			}
			if (!knownRule(id)) {
				ctx.ui.notify(`[gate] no guard rule named "${id}" — /gatec guard lists the ones there are`, "warning");
				return;
			}
			if (verb === "disable") guardBudget.disabled.add(id);
			else guardBudget.disabled.delete(id);
			ctx.ui.notify(`[gate] guard rule ${id} ${verb === "disable" ? "off" : "on"} for this session`, "info");
			return;
		}
		if (verb === "reset") {
			resetGuardCounters(guardBudget);
			ctx.ui.notify("[gate] guard reminder budget cleared", "info");
			return;
		}
		if (verb === "default") {
			resetGuardSession(guardBudget);
			ctx.ui.notify("[gate] guard session overrides cleared (the config file is back in charge)", "info");
			return;
		}
		await ctx.ui.editor(
			"/gatec guard",
			[
				guardStatusLine(ctx),
				"",
				"/gatec guard off|notify|remind — what to do about a malformed call, for this session only",
				"/gatec guard disable|enable <rule-id> — switch one detector, for this session only",
				"/gatec guard reset — refill the reminder budget",
				"/gatec guard default — drop every session override",
			].join("\n"),
		);
	};

	const state = (ctx: ExtensionContext): GateState => ({
		// Reload per call: `loadPolicy` is mtime-stamped, so config edits apply without a restart (step 5).
		policy: refresh(ctx),
		sessionGrants,
		allowAll,
		subagentCalls,
		pendingNotes,
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
		pendingNotes.clear();
		resetGuardSession(guardBudget);
		allowAll = undefined;
		if (allowAllTimer) clearTimeout(allowAllTimer);
		allowAllTimer = undefined;
		const current = refresh(ctx);
		if (current.files.length === 0) {
			const seeded = seedConfig(resolveConfigPaths(ctx.cwd, true).globalFile);
			ctx.ui.notify(
				`[gate] no config file — using built-in defaults (${Object.keys(DEFAULT_GATE_CONFIG.permission).length} surfaces, bash = ask); wrote ${seeded}. ` +
					`Edit it and run /gatec reload.`,
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
		pendingNotes.clear();
		resetGuardSession(guardBudget);
		allowAll = undefined;
		if (allowAllTimer) clearTimeout(allowAllTimer);
		allowAllTimer = undefined;
		ctx.ui.setStatus("pi-gate", undefined);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (disabled()) return;
		const result = await handleToolCall(event, ctx, state(ctx));
		// The model made a call that worked: the guard's budget is for the trouble it is in, not for the run.
		if (!result?.block) refillGuardBudget(guardBudget);
		return result;
	});

	// The output guard: a call the model wrote as text instead of making would end the run as an answer.
	// The footer follows it, because "why did it keep going?" is asked while the run is still going.
	pi.on("turn_end", (event, ctx) => {
		if (disabled()) return;
		const result = guardTurnEnd(event, ctx, guardState(ctx));
		footer(ctx);
		return result;
	});

	// "Allow with reason": the note the human typed goes on the result of the call it approved.
	pi.on("tool_result", (event) => attachNote(event, pendingNotes));

	pi.on("before_agent_start", (_event, ctx) => {
		if (disabled()) return;
		applyToolVisibility(policy ?? refresh(ctx));
	});

	pi.registerCommand("gatec", {
		description: "Permission gate: status | grants | reload | allow [off|5min|session] | guard [off|notify|remind|disable <rule>|enable <rule>|reset|default] | reset grants [project|global] | off | on",
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
				ctx.ui.notify(
					next.until === null
						? "[gate] allow-everything on for this session — nothing will ask again, protected paths and pi's own config included"
						: `[gate] allow-everything on for ${ALLOW_ALL_WINDOW_MINUTES} minutes — nothing will ask again, protected paths and pi's own config included`,
					"warning",
				);
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
			if (sub === "guard") {
				await guardCommand(parts.slice(1), ctx);
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
				`enabled: ${current.config.enabled && !disabled() ? "yes" : "no"}${pi.getFlag("no-gate") === true ? " (--no-gate)" : offForSession ? " (/gatec off)" : ""}`,
				`review log: ${current.config.reviewLog ? "on" : "off"} · prompt timeout: ${current.config.promptTimeoutMs || "wait"}`,
				`config files: ${current.files.length ? current.files.join(", ") : "none (built-in defaults)"}`,
				`trusted project dir: ${ctx.isProjectTrusted() ? "yes" : "no (project config ignored)"}`,
				`session grants: ${sessionGrants.map((g) => `${g.surface} "${g.pattern}"`).join(", ") || "none"}`,
				`allow-everything: ${!allowAll ? "off" : allowAll.until === null ? "on for this session" : `on for ${Math.max(0, Math.round((allowAll.until - Date.now()) / 1000))}s`} (absolute: no call reaches the dialog; only a \`deny\` rule or a \`hardDeny\` entry still blocks)`,
				`hidden tools: ${[...hiddenByGate].join(", ") || "none"}`,
				guardStatusLine(ctx),
				`rules: ${current.rules.length} · visible tools: ${recomputeActive(tools, current).length}/${tools.length}`,
				`bash surface: ${JSON.stringify(current.config.permission.bash ?? DEFAULT_GATE_CONFIG.permission.bash)}`,
				`network surface: ${JSON.stringify(current.config.permission.network ?? DEFAULT_GATE_CONFIG.permission.network)} · hardDeny: ${current.hardDeny.length ? current.hardDeny.map((rule) => `"${rule.pattern}"`).join(", ") : "none"} (blocks even with allow-everything on)`,
				regexPatternTimeouts.size ? `regex rules that ran past their time budget and stopped matching this session: ${[...regexPatternTimeouts].map((s) => `re:${s}`).join(", ")} — rewrite them bounded` : "",
				current.errors.length ? `problems:\n${current.errors.map((e) => `  · ${e}`).join("\n")}` : "problems: none",
			].join("\n");
			await ctx.ui.editor("/gatec status", body);
		},
	});
}
