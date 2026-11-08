/**
 * Command classification: wrappers, interpreters, arity, destructive heads, suggested grant patterns
 * (plan step 3, split out of `match.ts`).
 */

import { peelEnvPrefix, tokenize } from "./shell-segmentation.ts";

/**
 * Commands that run something *else*, so an `allow` on them is meaningless: they always escalate to
 * `ask` (FM-8). Interpreters are listed separately because `python3 script.py` is only a wrapper
 * when it executes a code string (`-c` / `-e`) or appears in a pipe chain (`curl x | sh`).
 */
export const WRAPPER_COMMANDS: readonly string[] = [
	"sudo",
	"doas",
	"pkexec",
	"su",
	"env",
	"eval",
	"exec",
	"command",
	"nohup",
	"xargs",
	"watch",
	"timeout",
	"time",
	"npx",
	"dlx",
	"uvx",
];

export const INTERPRETER_COMMANDS: readonly string[] = [
	"sh",
	"bash",
	"zsh",
	"fish",
	"dash",
	"ksh",
	"python",
	"python3",
	"node",
	"deno",
	"bun",
	"perl",
	"ruby",
	"php",
];

export function commandName(seg: string): string {
	const head = tokenize(peelEnvPrefix(seg).command)[0] ?? "";
	return head.split("/").pop() ?? head;
}

/** True when the segment wraps another command or executes a code string. */
export function isWrappedSegment(seg: string, inPipeline = false): boolean {
	const name = commandName(seg);
	if (!name) return false;
	if (WRAPPER_COMMANDS.includes(name)) return true;
	if (!INTERPRETER_COMMANDS.includes(name)) return false;
	const tokens = tokenize(seg);
	if (tokens.some((t) => /^-[a-z]*c$/.test(t) || t === "-e" || t === "--exec" || t === "--eval")) return true;
	return inPipeline;
}

/** Sub-command depth of the grantable prefix (git→2, so `git status *` rather than `git *`). */
export const BASH_ARITY: Record<string, number> = {
	git: 2,
	npm: 2,
	pnpm: 2,
	yarn: 2,
	bun: 2,
	go: 2,
	cargo: 2,
	docker: 2,
	pip: 2,
	pip3: 2,
	uv: 2,
	gh: 2,
	kubectl: 2,
	apt: 2,
	"apt-get": 2,
	brew: 2,
};

export function normaliseCommand(seg: string): string {
	return seg.replace(/\s+/g, " ").trim();
}

/**
 * Suggested grant pattern for a bash segment.
 *
 * `persisted` scopes (project / all projects) get the **exact** command (FM-10): `pnpm *` would be
 * arbitrary code execution committed to git from one click. Wildcards are only used in memory —
 * and never for a wrapper or interpreter segment, whose wildcard would outlive the call it came
 * from (`sh evil.sh` must not be covered by a session grant made for `curl x | sh`).
 */
export function suggestBashPattern(seg: string): string {
	const normalised = normaliseCommand(seg);
	if (isWrappedSegment(normalised, true) || isDestructiveHead(normalised)) return normalised;
	const tokens = tokenize(peelEnvPrefix(normalised).command);
	if (tokens.length === 0) return normalised;
	const name = tokens[0]!.split("/").pop()!;
	const arity = BASH_ARITY[name] ?? 1;
	return `${tokens.slice(0, Math.min(arity, tokens.length)).join(" ")} *`;
}

/**
 * Commands whose wildcard form is far broader than the call the human actually looked at: `rm *` is not
 * "the same kind of thing" as `rm -rf build`, it is permission to delete anything. These keep the
 * exact command in every scope, which is what the dialog text promises.
 */
export const DESTRUCTIVE_HEADS: ReadonlySet<string> = new Set([
	"rm",
	"rmdir",
	"unlink",
	"shred",
	"truncate",
	"dd",
	"mkfs",
	"fdisk",
	"parted",
	"mount",
	"umount",
	"mv",
	"chown",
	"chgrp",
	"chmod",
	"kill",
	"pkill",
	"killall",
	"sudo",
	"doas",
	"su",
	"systemctl",
	"service",
	"shutdown",
	"reboot",
	"halt",
	"poweroff",
	"nsenter",
	"useradd",
	"userdel",
	"usermod",
	"crontab",
]);

export function isDestructiveHead(seg: string): boolean {
	const tokens = tokenize(peelEnvPrefix(normaliseCommand(seg)).command);
	const name = (tokens[0] ?? "").split("/").pop() ?? "";
	return DESTRUCTIVE_HEADS.has(name);
}
