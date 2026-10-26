/**
 * Grant storage (plan step 6).
 *
 * Session grants are memory-only and die with the runtime. Persisted grants are appended into the
 * `gate.grants.global` / `gate.grants.project` array of the matching config file with a
 * re-read-then-merge and a temp-file rename, so two `pi` processes cannot lose writes (FM-9).
 */

import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { getGlobalConfigFile, getProjectConfigFile, readConfigFile } from "./config-file.ts";
import type { GrantRule, Action } from "./schema.ts";
import type { GrantOffer } from "./policy.ts";

export type PersistedScope = "global" | "project";

/** In-memory session allowances. Cleared on `session_start` and `session_shutdown`. */
export function createSessionGrants(): GrantRule[] {
	return [];
}

/**
 * The rules a dialog choice creates: one per command segment, the same shape in every scope. An offer
 * that also speaks on another surface (an outside path needs `external_directory`, not only the tool's
 * own surface) gets one rule per surface, otherwise the click would not close its own dialog.
 */
export function toGrantRules(offer: GrantOffer, action: Action = "allow"): GrantRule[] {
	const surfaces = [offer.surface, ...(offer.alsoSurfaces ?? [])];
	const out: GrantRule[] = [];
	for (const surface of surfaces) {
		for (const pattern of offer.patterns) {
			if (out.some((rule) => rule.surface === surface && rule.pattern === pattern)) continue;
			out.push({ surface, pattern, action });
		}
	}
	return out;
}

/** Append every pattern of one offer, skipping duplicates. Returns the rules actually added. */
export function appendSession(grants: GrantRule[], offer: GrantOffer): GrantRule[] {
	const added: GrantRule[] = [];
	for (const rule of toGrantRules(offer)) {
		if (grants.some((existing) => existing.surface === rule.surface && existing.pattern === rule.pattern)) continue;
		grants.push(rule);
		added.push(rule);
	}
	return added;
}

export function clearSession(grants: GrantRule[]): void {
	grants.length = 0;
}

export function hasSessionGrant(grants: readonly GrantRule[], surface: string, value: string): GrantRule | undefined {
	return grants.find((grant) => grant.surface === surface && (grant.pattern === "*" || grant.pattern === value));
}

export interface WriteResult {
	ok: boolean;
	file: string;
	error?: string;
}

export function persistedFile(scope: PersistedScope, cwd: string): string {
	return scope === "global" ? getGlobalConfigFile() : getProjectConfigFile(cwd);
}

/**
 * Append one grant to a config file. Re-reads immediately before every write, then verifies the
 * result and retries, so a grant added by a second `pi` process is never lost (FM-9).
 */
export async function appendPersisted(offer: GrantOffer, scope: PersistedScope, cwd: string): Promise<WriteResult> {
	const file = persistedFile(scope, cwd);
	const rules = toGrantRules(offer);
	return mutateGrants(file, scope, (grants) => {
		const missing = rules.filter(
			(rule) => !grants.some((existing) => existing.surface === rule.surface && existing.pattern === rule.pattern && existing.action === rule.action),
		);
		if (missing.length === 0) return { grants, changed: false };
		return { grants: [...grants, ...missing], changed: true };
	});
}

export async function resetPersisted(kind: PersistedScope, cwd: string): Promise<WriteResult> {
	const file = persistedFile(kind, cwd);
	return mutateGrants(file, kind, (grants) => ({ grants: [], changed: grants.length > 0 }));
}

const WRITE_ATTEMPTS = 5;
let writeTicket = 0;

async function mutateGrants(
	file: string,
	scope: PersistedScope,
	update: (grants: GrantRule[]) => { grants: GrantRule[]; changed: boolean },
): Promise<WriteResult> {
	const key: "global" | "project" = scope;
	let last: WriteResult = { ok: false, file, error: "not written" };

	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = readConfigFile(file);
		if (read.json === undefined && read.error && !read.error.includes("does not exist")) {
			return { ok: false, file, error: read.error };
		}
		const document = asRecord(read.json);
		const gate = asRecord(document.gate);
		const current = asRecord(gate.grants);
		const existing = normaliseGrants(current[key]);
		const next = update(existing);
		if (!next.changed) return { ok: true, file };

		const merged = { ...document, gate: { ...gate, grants: { ...current, [key]: next.grants } } };
		try {
			mkdirSync(dirname(file), { recursive: true });
			const tmp = `${file}.${process.pid}.${attempt}.${writeTicket++}.tmp`;
			await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
			await rename(tmp, file);
		} catch (error) {
			return { ok: false, file, error: (error as Error).message };
		}

		// Verify: if a concurrent writer replaced us, retry on top of its content (FM-9).
		const after = normaliseGrants(asRecord(asRecord(asRecord(readConfigFile(file).json).gate).grants)[key] ?? []);
		if (containsAll(after, existing) && containsAll(after, next.grants)) return { ok: true, file };
		last = { ok: false, file, error: "concurrent grant write detected, retrying" };
	}
	return last;
}

function containsAll(actual: readonly GrantRule[], expected: readonly GrantRule[]): boolean {
	return expected.every((rule) => actual.some((item) => item.surface === rule.surface && item.pattern === rule.pattern && item.action === rule.action));
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normaliseGrants(value: unknown): GrantRule[] {
	if (!Array.isArray(value)) return [];
	const out: GrantRule[] = [];
	for (const item of value) {
		const record = asRecord(item);
		if (typeof record.surface !== "string" || typeof record.pattern !== "string") continue;
		if (record.action !== "allow" && record.action !== "ask" && record.action !== "deny") continue;
		out.push({ surface: record.surface, pattern: record.pattern, action: record.action });
	}
	return out;
}
