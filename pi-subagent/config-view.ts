/**
 * The `/subagentc` view: the subagent config as the human actually left it (plan step 20's UI side).
 *
 * Pure string building over a snapshot, so the config reader, the model resolver and the run guard
 * stay the only impure parts and `index.ts` stays wiring. Nothing here reads a file or a registry: the
 * caller passes what it read, which is what makes the whole view testable without a session.
 *
 * It exists because the config is otherwise invisible: `subagent.model` decides which model answers,
 * and `subagent.maxTurns`/`timeoutMinutes` decide when a child is cut off, yet both live in a JSON file
 * shared with pi-gate. The view names the value, the file it came from, and the effect it has.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { childThinkingLevel } from "./model-override.ts";
import type { ChildModelResolution } from "./model-override.ts";
import { FORBIDDEN_CHILD_TOOLS, NESTED_CALL_CEILING } from "./shims.ts";
import { ROLES, ROLE_ORDER, type Role } from "./roles.ts";
import { childSessionDir } from "./child.ts";
import type { SubagentLimits } from "./config-file.ts";
import type { RunGuard } from "./run.ts";

export type ConfigSection = "all" | "model" | "limits" | "roles" | "status";

/** What `/subagentc <arg>` accepts: a view section, or the model catalogue to browse for a pin. */
export type SubagentCommandArg = ConfigSection | "models";

export const COMMAND_ARGS: readonly SubagentCommandArg[] = ["all", "model", "limits", "roles", "status", "models"];

export interface ConfigViewInput {
	limits: SubagentLimits;
	/** Which file last set each value, straight from `loadSubagentLimits`; missing = built-in default. */
	origins?: Partial<Record<keyof SubagentLimits, string>>;
	files: string[];
	/** Where the section would live if no file had it yet: `<agentDir>/extensions/pi-gate/config.json`. */
	defaultConfigFile: string;
	errors: string[];
	cwd: string;
	trusted: boolean;
	/** The model the session is on — what the child inherits when nothing is pinned. */
	sessionModel?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	/** Present only when `subagent.model` pins a reference; carries the resolution or its error. */
	pin?: { reference: string; resolution: ChildModelResolution };
	/** Tools the parent can call right now — what a role's `"*"` expands to. */
	parentTools: readonly string[];
	sessionDir: string;
	running?: RunGuard;
	/** Injectable clock so tests are exact. */
	now?: number;
}

const DEFAULT_ORIGIN = "built-in default";

export function modelRef(model: Model<Api> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "(none selected for this session)";
}

/** The model a child would run on with this config: the pin when it resolves, else the session's. */
export function childModelOf(input: ConfigViewInput): Model<Api> | undefined {
	if (input.pin?.resolution.status === "resolved") return input.pin.resolution.model;
	return input.sessionModel;
}

export function effectiveBudget(role: Role, limits: SubagentLimits): { turns: number; minutes: number } {
	return { turns: Math.min(role.maxTurns, limits.maxTurns), minutes: Math.min(role.timeoutMinutes, limits.timeoutMinutes) };
}

/** Sections of the view, so `/subagentc model` shows the model block and nothing else. */
export function buildConfigView(input: ConfigViewInput, section: ConfigSection = "all"): string {
	const blocks: Record<Exclude<ConfigSection, "all">, string[]> = {
		model: modelSection(input),
		limits: limitsSection(input),
		roles: rolesSection(input),
		status: statusSection(input),
	};
	if (section !== "all")
		return [`pi-subagent · ${section}`, ...blocks[section], "", ...filesSection(input), "", ...problemsSection(input)].join("\n");
	return [
		`pi-subagent · effective config (cwd ${input.cwd})`,
		...modelSection(input),
		"",
		...limitsSection(input),
		"",
		...rolesSection(input),
		"",
		...runtimeSection(input),
		"",
		...statusSection(input),
		"",
		...filesSection(input),
		"",
		...problemsSection(input),
		"",
		"edit: change any value in that file and the next subagent call picks it up (the reader is mtime-cached)",
	].join("\n");
}

function modelSection(input: ConfigViewInput): string[] {
	const child = childModelOf(input);
	const pinned = input.pin?.resolution.status === "resolved";
	const lines: string[] = [];
	lines.push(`child model: ${modelRef(child)}${child ? (pinned ? " (pinned by subagent.model)" : " (inherited from the session model)") : ""}`);
	lines.push(`  session model: ${modelRef(input.sessionModel)}${input.sessionModel ? ` · reasoning: ${input.sessionModel.reasoning ? "yes" : "no"}` : ""}`);
	if (!input.pin) {
		lines.push(`  subagent.model: not set — the child always follows the session model (pi cannot pick its own child model)`);
	} else {
		const origin = input.origins?.model ?? DEFAULT_ORIGIN;
		if (input.pin.resolution.status === "resolved") {
			lines.push(`  subagent.model: "${input.pin.reference}" (from ${origin}) -> ${input.pin.resolution.ref}`);
		} else {
			lines.push(`  subagent.model: "${input.pin.reference}" (from ${origin}) -> NOT RESOLVED, the child stays on the session model`);
			lines.push(`    ${input.pin.resolution.message}`);
		}
	}
	if (child) {
		const asked = input.thinkingLevel ?? "off";
		const given = childThinkingLevel(child, asked);
		lines.push(`  child thinking level: ${given}${given !== asked ? ` (session asks "${asked}", the model has no such level)` : ""}`);
		lines.push(`  context window: ${formatCount(child.contextWindow)} tokens · max output ${formatCount(child.maxTokens)}`);
	}
	return lines;
}

function limitsSection(input: ConfigViewInput): string[] {
	const limits = input.limits;
	const rows: [key: keyof SubagentLimits, value: string][] = [
		["enabled", limits.enabled ? "yes" : "no (the subagent tool is hidden and calls fail)"],
		["maxTurns", String(limits.maxTurns)],
		["timeoutMinutes", `${limits.timeoutMinutes}`],
		["maxResultBytes", `${limits.maxResultBytes} (${formatBytes(limits.maxResultBytes)})`],
		["keepTranscripts", `${limits.keepTranscripts} per role dir`],
		["model", limits.model ? `"${limits.model}"` : "(unset — inherit the session model)"],
	];
	const width = Math.max(...rows.map(([key]) => key.length));
	return [
		"limits (subagent section of the config file, project overrides global):",
		...rows.map(([key, value]) => `  ${key.padEnd(width)}  ${value}  ·  from ${input.origins?.[key] ?? DEFAULT_ORIGIN}`),
	];
}

function rolesSection(input: ConfigViewInput): string[] {
	const lines: string[] = ["roles (hard-coded in roles.ts — not configurable):"];
	for (const name of ROLE_ORDER) {
		const role = ROLES[name];
		const budget = effectiveBudget(role, input.limits);
		const capped = role.maxTurns > budget.turns || role.timeoutMinutes > budget.minutes;
		lines.push(`  ${name} · ${role.description}`);
		lines.push(`    tools: ${role.allowTools.includes("*") ? `* → ${describeParentTools(input.parentTools)}` : role.allowTools.join(", ")}`);
		lines.push(
			`    budget: ${role.maxTurns} turns · ${role.timeoutMinutes} min` +
				(capped ? ` → effective ${budget.turns} turns · ${budget.minutes} min (capped by subagent.maxTurns/timeoutMinutes)` : ""),
		);
		lines.push(`    prompt: ${role.prompt}`);
	}
	return lines;
}

function runtimeSection(input: ConfigViewInput): string[] {
	return [
		`transcripts: ${childSessionDir(input.sessionDir)} · keeps the newest ${input.limits.keepTranscripts} per role dir`,
		`nested calls: ${NESTED_CALL_CEILING} per child (further calls are rejected) · forbidden in children: ${FORBIDDEN_CHILD_TOOLS.join(", ")}`,
		`one child at a time: a second subagent call fails while one runs (globalThis guard, run.ts)`,
	];
}

function statusSection(input: ConfigViewInput): string[] {
	return [formatRunning(input.running, input.now)];
}

/** One line about what is running now — `/subagentc status` shows nothing but this. */
export function formatRunning(running: RunGuard | undefined, now: number = Date.now()): string {
	if (!running) return "running: none (the tool is blocking, so this line is only ever filled during a run)";
	const seconds = Math.max(0, Math.round((now - running.startedAt) / 1000));
	return `running: ${running.role} for ${seconds}s (call ${running.callId}) · abort with Esc/Ctrl-C, which stops the child too`;
}

function filesSection(input: ConfigViewInput): string[] {
	const lines = ["config files read (last write wins):"];
	if (!input.files.length) lines.push(`  none — built-in defaults; write the section to ${input.defaultConfigFile}`);
	for (const file of input.files) lines.push(`  ${file}${file.startsWith(`${input.cwd}/`) ? " · project scope" : " · global scope"}`);
	if (input.files.length < 2) lines.push(`  project scope ${input.trusted ? "not read (no project file)" : "ignored: this cwd is not trusted"}`);
	return lines;
}

function problemsSection(input: ConfigViewInput): string[] {
	if (!input.errors.length) return ["problems: none"];
	return [`problems (${input.errors.length}):`, ...input.errors.map((error) => `  · ${error}`)];
}

function describeParentTools(tools: readonly string[]): string {
	const callable = tools.filter((name) => !FORBIDDEN_CHILD_TOOLS.includes(name));
	return `${callable.join(", ") || "(none)"} — the parent's ${callable.length} callable tool(s)`;
}

/** `/subagentc models`: what a `subagent.model` pin may name, in the syntax the resolver accepts. */
export function buildModelCatalog(
	models: readonly Model<Api>[],
	opts: { sessionModel?: Model<Api>; pinnedRef?: string; available?: ReadonlySet<string> } = {},
): string {
	const sessionRef = modelRef(opts.sessionModel);
	const sorted = [...models].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
	const lines = [
		`models (${sorted.length} known) — pin one with "subagent": { "model": "provider/id" } in the config file`,
		...sorted.map((model) => {
			const ref = `${model.provider}/${model.id}`;
			const tags: string[] = [];
			if (ref === sessionRef) tags.push("session model");
			if (opts.pinnedRef && ref === opts.pinnedRef) tags.push("pinned as subagent.model");
			if (opts.available && !opts.available.has(ref)) tags.push("no auth configured");
			if (!model.reasoning) tags.push("non-reasoning (child thinking forced off)");
			return `  ${ref} · ${model.name} · ${formatCount(model.contextWindow)}${tags.length ? ` · ${tags.join(", ")}` : ""}`;
		}),
	];
	return lines.join("\n");
}

function formatCount(value: number): string {
	return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

function formatBytes(value: number): string {
	return value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
}
