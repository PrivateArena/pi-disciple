# PROJECT_OVERVIEW — pi-disciple

Two independent pi extensions, built to `ARCHITECTURE_PLAN_pi-sub-gate.md`:

| Extension | One-line | Registered surface |
| --- | --- | --- |
| `pi-gate/` | Multi-scope permission gate for every `tool_call`, including nested subagent calls | `tool_call` handler, `/gate`, `--no-gate`, footer status |
| `pi-subagent/` | One blocking `subagent(role, task)` tool; the child runs in-process with zero extensions | `subagent` tool, `/subagents` |

They share exactly one artifact: `~/.pi/agent/extensions/pi-gate/config.json` (`gate` + `subagent` sections).
They share no imports — `pi-subagent/config-file.ts` is a deliberate copy of `pi-gate/config-file.ts`.

## Why nested calls are gated for free

The child `AgentSession` gets **shim tools** (`pi-subagent/shims.ts`) whose `execute()` forwards to the
*parent's* `ExtensionToolContext.executeTool()`. So every child tool call runs inside the parent's tool
pipeline: `tool_call` fires with `parentToolCallId = <subagentCallId>/<n>`, the parent's config decides,
and the human answers one dialog in the parent — no cross-process permission forwarding, no second config.
`FORBIDDEN_CHILD_TOOLS` (`subagent`, `codemode`, `tool_search`) is dropped so a child can neither recurse
nor collapse 256 sequential calls into one unreviewable batch.

## Module map

```
pi-gate/
  schema.ts        config parsing + defaults (GateConfig, SubagentLimits, GrantRule)      step 3
  config-file.ts   read/seed `<scope>/extensions/pi-gate/config.json`, JSONC tolerance    step 19
  match.ts         pattern matching, shell segmentation, path spellings, protected globs   step 4
  inspect.ts       Facts: surfaces + paths + call ids extracted from a tool call           step 5
  policy.ts        layered Policy (defaults→global→project→grants→session), floors, deny   steps 6, 7
  grants.ts        session (memory) + persisted (config file) grants, review log helpers   step 8
  prompt.ts        the 6-choice dialog → AskResult, titles, block text                     step 9
  log.ts           review.jsonl + redact()                                                step 18
  handle.ts        the tool_call pipeline, injectable deps (FM-5 seam)                    steps 8, 9
  index.ts         wiring: flags, footer, tool visibility, /gate                          steps 8, 9
pi-subagent/
  roles.ts         explore | scout | worker | reviewer + config overrides                step 10
  prompt.ts        child system prompt + task wrapper                                     step 11
  shims.ts         parent-pipeline tool shims, queue, 256-call ceiling                    step 12
  child.ts         runChild(): assembly, timeouts, steering, transcripts, usage            steps 13, 14
  config-file.ts   own copy of the config reader (import-free of pi-gate)                 step 20
  run.ts           globalThis run guard + result mapping (status header, truncation)      steps 15, 16
  index.ts         the single `subagent` tool + /subagents                                steps 15, 16
```

## Config

`pi-gate/config.json` is the shipped default. Scopes, lowest precedence first: built-in defaults →
global file → project file (only when the cwd is trusted) → `grants.global` → `grants.project` →
session grants. Within a surface, the **last matching pattern wins**; across facts, most-restrictive wins.
Floors that no allow can downgrade: protected paths (the gate's own config, pi's config dir, git hooks,
`.git`, `.pi`), shell wrappers/expansion, external directories, and any unparseable config (`degraded`).

Dialog choices, in list order: `Allow once` · `Allow <rule> for this session` · `Allow <rule> for this
project (<cwd>)` · `Allow <rule> for all projects` · `Abort` · `Abort with reason…` · `Allow everything
for this session` · `Allow everything for 5 minutes`. All three "Allow <rule>" choices write the **same**
rule — one wildcard per command segment (`git status *`, `cd *`), stored per segment so a chained command
actually matches later; destructive (`rm`, `sudo`, `chmod`, …) and wrapper segments stay exact. A dismissed
or timed-out dialog aborts (never allows). No UI (`pi -p`) blocks with the exact rule needed to allow it.

"Allow everything" (dialog, or `/gate allow [off|5min|session]`) silences routine approvals for its whole
scope. It never overrides a `deny` rule and never crosses a safety floor: protected paths, files outside
the workspace, hidden arguments inside wrappers, and a broken config still open a dialog — with a note in
the title saying why. The 5-minute window closes on its own (status line + notify on expiry).

## Deviations from the plan (all verified against pi 1.4.0 types)

1. `typebox@1.3.27` instead of `@sinclair/typebox` — pi aliases both; `StringEnum` comes from `@earendil-works/pi-ai`.
2. `ToolCallEventBase` has **no `cwd`** in 1.4.0 (plan A3) — the handlers use `ctx.cwd`.
3. Shipped defaults add `"subagent": "allow"`: the child's own calls are gated, so gating the delegation
   too would double-prompt for a call that is only a container.
4. Child retry is **enabled but bounded** (`maxRetries: 2`, `maxAgentDelayMs: 5000`) instead of off: the
   free upstream 503s routinely, and `HARD_SETTLE_MS` already bounds the run.
5. `reviewLog` records allow decisions too, not only ask resolutions (FM-17 audit value).
6. Two extra modules: `pi-gate/handle.ts` (testable pipeline seam) and `pi-subagent/run.ts` (guard + result
   mapping), so `index.ts` stays wiring only.
7. The built-in default permission map is a real rule layer (`scope: "builtin"`) **only** when no config
   file supplies `permission` — otherwise a machine with no config would prompt for every call, reads
   included. A config that sets `permission` fully owns that layer, so its own `"*"` default still applies.
8. `FactCheck.floor` is set for the `external_directory` fallback too (the type always had the variant, the
   evaluator never assigned it) — an unlabelled floor would be invisible to "allow everything".

## Commands

```bash
npm test            # vitest run — 159 tests, no live provider needed
npm run typecheck   # tsc --noEmit
node verification/rpc-gate-dialog.mjs "Allow once" /tmp/scratch   # dialog coverage (needs a provider)
```

Live smoke (uses the configured provider, run from a scratch dir):

```bash
pi --extension ./pi-gate/index.ts --extension ./pi-subagent/index.ts -p "…"
node /tmp/rpc-driver.mjs "Allow once"     # answers the gate dialog over --mode rpc
```

## Install into the dotfiles repo (plan step 22)

`config-pi/extensions/{pi-gate,pi-subagent}` + `"dirs": ["extensions"]` on the `pi` entry of the repo
`config.json`; `npm:@gotgenes/pi-permission-system` removed from `config-pi/settings.json`.
`zen-ai restore pi` copies both dirs to `~/.pi/agent/extensions/`; pi auto-discovers `index.ts` in each.

**Caveat:** `copyDir` overwrites, so a restore replaces `~/.pi/agent/extensions/pi-gate/config.json` and
with it any `grants.global` accumulated by clicking "Allow for all projects". Back that file up, or
re-add grants after a restore.
