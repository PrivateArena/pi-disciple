# PROJECT_OVERVIEW — pi-disciple

Two independent pi extensions, built to `ARCHITECTURE_PLAN_pi-sub-gate.md`:

| Extension | One-line | Registered surface |
| --- | --- | --- |
| `pi-gate/` | Multi-scope permission gate for every `tool_call`, including nested subagent calls | `tool_call` handler, `/gatec`, `--no-gate`, footer status |
| `pi-subagent/` | One blocking `subagent(role, task)` tool; the child runs in-process with zero extensions | `subagent` tool, `/subagentc` |

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
  prompt.ts        the 8-choice dialog → AskResult, titles, block text                     step 9
  log.ts           review.jsonl + redact()                                                step 18
  handle.ts        the tool_call pipeline, injectable deps (FM-5 seam)                    steps 8, 9
  index.ts         wiring: flags, footer, tool visibility, /gatec                          steps 8, 9
pi-subagent/
  roles.ts         explore | general-purpose | review, hard-coded allowlists + budgets        step 10
  model-override.ts subagent.model pin: "provider/id" / "provider:id" / bare id -> Model     step 10
  prompt.ts        child system prompt + task wrapper                                     step 11
  shims.ts         parent-pipeline tool shims, queue, 256-call ceiling                    step 12
  child.ts         runChild(): assembly, timeouts, steering, transcripts, usage            steps 13, 14
  config-file.ts   own copy of the config reader (import-free of pi-gate)                 step 20
  run.ts           globalThis run guard + result mapping (status header, truncation, card contract)  steps 15, 16
  render.ts        the tool card: call title, status sentence, report body (pi + Pendant)   step 16
  config-view.ts   the /subagentc text: effective config, model resolution, roles, catalog  step 20
  index.ts         the single `subagent` tool + /subagentc                                  steps 15, 16
```

## Config

`pi-gate/config.json` is the shipped default. Scopes, lowest precedence first: built-in defaults →
global file → project file (only when the cwd is trusted) → `grants.global` → `grants.project` →
session grants. Within a surface, the **last matching pattern wins**; across facts, most-restrictive wins.
Floors escalate a value to at least `ask` no matter what any rule says: protected paths (the gate's own
config and code, pi's config files, git hooks, the project's `.pi`), shell wrappers/expansion, external
directories, and any unparseable config (`degraded`). Only the hard ones — protected paths and
`degraded` — outlive "allow everything"; see the dialog section.

## Slash commands

Both are suffixed `c` ("command") so they cannot collide with a prompt file or skill of the same name:

| Command | Output |
| --- | --- |
| `/gatec [status\|grants\|reload\|allow [off\|5min\|session]\|reset grants [project\|global]\|off\|on]` | gate status editor, grant list, reload, allow-everything, clear grants, switch |
| `/subagentc [model\|limits\|roles\|status\|models]` | the effective subagent config, or one section of it |

`/subagentc` (was: "is a child running?") answers what the config actually does — the child model and
whether it is inherited or pinned, each limit with the file that set it (`loadSubagentLimits` now records
`origins`), the hard-coded roles with their budgets after the `subagent.maxTurns`/`timeoutMinutes` cap,
transcript paths, the nested-call ceiling, the config files read (project vs global, trust state) and any
parse errors. `models` lists what a `subagent.model` pin may name, flagging the session model, the
current pin and models with no auth. `status` is the old one-line answer, which is only ever filled
*during* a run — extension commands still run while a child blocks the session.

## Child model

By default the child runs on **the model the session is on** (`ctx.model`), and the result header names
it (`model: local/qwen3.8-flash-next (inherited)`), so the answer never depends on opening transcripts;
`/subagentc model` shows the same thing before a run, including where the pin was set.
`subagent.model` pins a different one: `"provider/id"` (pi's CLI form), `"provider:id"`, or a bare id
(an ambiguous bare id resolves against the parent's provider, else the error names the candidates).
Gateway ids contain slashes and colons themselves, so a prefix counts as a provider only when the
registry knows it. A bad pin warns and the child stays on the session model; overriding to a
non-reasoning model also drops the child's thinking level to `off`. The pin is config, never a tool
parameter - the model still cannot choose its own child model.

Dialog choices, in list order: `Allow once` · `Allow <rule> for this session` · `Allow <rule> for this
project (<cwd>)` · `Allow <rule> for all projects` · `Abort` · `Abort with reason…` · `Allow everything
for this session` · `Allow everything for 5 minutes`. All three "Allow <rule>" choices write the **same**
rule — one wildcard per command segment (`git status *`, `cd *`), stored per segment so a chained command
actually matches later; destructive (`rm`, `sudo`, `chmod`, …) and wrapper segments stay exact. A dismissed
or timed-out dialog aborts (never allows). No UI (`pi -p`) blocks with the exact rule needed to allow it.

**Nothing in the dialog is truncated.** The title shows the whole call, every surfaced fact, and the exact
rule (`rule: …` line) that a grant choice would write — in full; the TUI word-wraps and scrolls. Only the
option labels shorten the rule (they have to stay single-line), and the unshortened rule sits right above
them. pi's own limits are separate and not extension-configurable: the collapsed transcript preview shows
20 visual lines (`ctrl+o` toggles it), and the bash tool caps what the *model* sees at 2000 lines / 50KB
while saving the full output to a temp file (`core/tools/truncate.js`).

"Allow everything" (dialog, or `/gatec allow [off|5min|session]`) silences every approval in its scope:
other commands, other tools — not just the call it was clicked on. It never overrides a `deny` rule, and
it stops at the two **hard floors** — a write path to the gate's own config, pi's config files or git
hooks, and a config file too broken to parse — because either one could switch the gate off from under
the session. Those dialogs carry the reason in their title. Everything softer (a file outside the
workspace, a hidden `$(…)` argument, an interpreter in a pipe, pi's own transcripts) is silenced, because
a dialog that no choice can close is not a safeguard. Turning it on notifies, and the footer counts the
window down; the 5-minute window closes on its own (status line + notify on expiry).

A floor labels what is really there: it is computed from the call, not from whether some rule happened to
be silent. And a rule whose pattern *is* the command — what "Allow this exact command" writes for a
wrapper or destructive segment — is a decision about that command and is honoured; otherwise a grant for
`npx vitest run` would be re-asked forever. Floors over coarse wildcards (`npx *`) still bite.

## The tool card

Two separate mechanisms feed one card, and only one of them is ours.

**pi's own renderer** (`pi-subagent/render.ts` — `renderCall`/`renderResult`) is what the terminal TUI and
`/export` HTML use: a title line, one sentence about the run — `Agent completed in 21.0s (5 turns, 6 tool
uses, 4.2k token).` — then `role · model · Agent ID`, the transcript path, and the child's report (10 lines
collapsed, 50 expanded, with a "more lines" hint built from the expand keybinding, never a hardcoded
`ctrl+o`). `details.report` holds the child's answer on its own, so the card never re-parses the
model-facing text. pi calls a renderer with `{ content, details }` only — never `usage` — which is why the
token total is also carried in `details.tokens`.

**What a non-TUI frontend (Pendant) reads is `details`, not the renderers** — it never invokes them, so a
correct `Text` component buys nothing there. It draws a subagent card off the field names and status
vocabulary `@gotgenes/pi-subagents` established (`AgentDetails`/`GetResultDetails`): a `status` it has no
branch for leaves the card in its activity list with `No activity reported yet` where the result belongs,
which is exactly the bug. `run.ts` therefore emits both vocabularies: our own `exit`/`elapsedMs`/`toolCalls`
plus `status` (`uiStatus`: `completed`/`running`/`stopped`/`aborted`/`error`), `displayName`,
`subagentType`, `description`, `toolUses`, `durationMs`, `tokens`, `agentId`, `modelName`, `preview`.
`verification/probe-subagent-render.mjs` prints both `details` shapes and drives the renderers through the
real pi Theme and real pi-tui components, because the unit tests' fake theme cannot fail the way a
frontend fails. Every `onUpdate` still carries a complete `SubagentDetails` (`status: "running"`, turns,
tool uses, activity, model) and a 2s heartbeat re-emits it, so a child that thinks for minutes without a
tool event keeps reporting activity.

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
   evaluator never assigned it) — an unlabelled floor would be invisible to "allow everything". Floors are
   now computed from the call itself: `HARD_FLOORS` survive allow-everything (`protected_path`,
   `degraded_config`), `SOFT_FLOORS` do not (`protected_read`, `wrapper`, `external_directory`), and
   `allowAllBypasses()` replaced `noSafetyFloor()`.
9. `protectedPathGlobs` guards the agent dir's *code and config* (`extensions/*`, `bin`, `npm`, `git`,
   `settings.json`, `auth.json`, `models.json`, `SYSTEM.md`, …) rather than `~/.pi/agent/*` — flooring the
   whole dir made every transcript or log read an un-silenceable dialog. A protected path reached by a
   read-only tool floors as `protected_read`, by anything that can write as `protected_path`.
10. `@earendil-works/pi-tui` is a peer dependency: `render.ts` needs pi's `Text` component to return a
    `Component` from `renderCall`/`renderResult`.
11. The slash commands are `/gatec` and `/subagentc` (the plan had `/gate` and `/subagents`) — the `c`
    keeps them clear of same-named prompt files and skills. `/subagentc` also grew from "is a child
    running?" into the config browser: the tool blocks, so by the time a human can look, there is never
    a running child to show.

## Commands

```bash
npm test            # vitest run — 243 tests, no live provider needed
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
