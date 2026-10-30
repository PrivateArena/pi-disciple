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
  match.ts         pattern matching, shell segmentation, path spellings, folder grants, protected globs   step 4
  inspect.ts       Facts: surfaces + paths + call ids extracted from a tool call           step 5
  policy.ts        layered Policy (defaults→global→project→grants→session), floors, deny   steps 6, 7
  grants.ts        session (memory) + persisted (config file) grants, review log helpers   step 8
  prompt.ts        the 9-choice dialog → AskResult, titles, block text                     step 9
  log.ts           review.jsonl + redact()                                                step 18
  handle.ts        the tool_call pipeline, injectable deps (FM-5 seam)                    steps 8, 9
  index.ts         wiring: flags, footer, tool visibility, /gatec                          steps 8, 9
pi-subagent/
  roles.ts         explore | general-purpose | review + applyRoleConfig: config edits them, new ones join the table    step 10
  model-override.ts subagent.model pin: "provider/id" / "provider:id" / bare id -> Model     step 10
  prompt.ts        child system prompt + task wrapper                                     step 11
  delegation.ts    the `<delegation>` system prompt section: when to delegate, when not to    step 15
  shims.ts         parent-pipeline tool shims, queue, 256-call ceiling                    step 12
  ceiling.ts      the one-time "more rope?" dialog a spent budget asks: the ladder, the title, the answer rules    new
  child.ts         runChild(): assembly, timeouts (ceiling, report-safe deferral, the held offer), steering, transcripts, usage  steps 13, 14
  config-file.ts   own copy of the config reader: limits, model pin, `roles` table        step 20
  run.ts           globalThis run guard + result mapping (status header, report budget + spill file, card contract)  steps 15, 16
  render.ts        the tool card: call title, status sentence, report body (pi + Pendant)   step 16
  labels.ts        the strings a card is titled with: role display name, task label, task body — never clipped,
                   and what the human answered about a spent budget (shared by render.ts and run.ts)
  config-view.ts   the /subagentc text: effective config, model resolution, roles, catalog  step 20
  index.ts         the single `subagent` tool + /subagentc                                  steps 15, 16
```

## Config

`pi-gate/config.json` is the shipped default. Scopes, lowest precedence first: built-in defaults →
global file → project file (only when the cwd is trusted) → `grants.global` → `grants.project` →
session grants. Within a surface, the **last matching pattern wins**; across facts, most-restrictive wins.

`subagent` section is every knob the child has. `model` takes a `provider/id` pin, or one of the inherit
words (`inherit`, `session`, `parent`, `default`) which mean "no pin" - that is how the shipped file shows
the key without pinning anything. `maxTurns` / `timeoutMinutes` here are **ceilings**: a run gets
`min(role, subagent)` turns and minutes, so the section can tighten a role and the shipped 30/20 caps the
40-turn `general-purpose` role to 30 until you raise it. It also means the section alone cannot *raise* a
role - `timeoutMinutes: 20` with the built-in 10-minute `explore` budget cuts `explore` at 10 minutes, which
is why `subagent.roles.<name>.timeoutMinutes` exists. `/subagentc limits` and `/subagentc roles` print the
ceiling, the role budget and the effective number together so the arithmetic is never guesswork.

**How a deadline is decided** (`child.ts`, `HARD_SETTLE_MS`, `REPORT_GRACE_MS`): at the role's minutes the
child is *steered* to conclude (that is the whole point of the budget - a conclusion, not a kill); 60 s
later the hard ceiling fires, and there the clock defers to the work: a run that is **streaming its report**
(an assistant message with text and no tool call) or **mid tool call** (which means the steer has not even
reached the model yet - the queue drains only between turns) is not cut - it gets until the report lands, or
until the report wall (`ceiling + 3 min`) passes. So the longest possible run is `budget + 4 min`, and the
artifact the delegation was paid for is never destroyed mid-sentence. `aborted` (human Esc) is immediate and
unconditional; only time-based ceilings defer.

**A spent budget is a question before it is a verdict** (`subagent.askToExtend`, `ceiling.ts`). When the turn
limit or the time budget is reached, the run asks the human instead of steering to a conclusion: `Reject` (the
old behaviour, verbatim) or one rung of `+20t/+5m · +40t/+10m · +60t/+15m · +100t/+25m`. The rungs are absolute
additions, so one dialog means the same thing for a 10-turn `review` and a 200-turn custom role, and no rung
exceeds what a config could have said anyway. The rule set is the gate's, because the risk is the same one:
**only an explicit Extend choice extends** — Esc, a dismissed or timed-out dialog (5 min), or no UI at all
enforces the ceiling unchanged (FM-11); one offer per run, whatever it was answered with, because a run that
needs a second one was delegated the wrong size; and the title is the question and nothing else — the role,
which budget ran out, and the counters (`turns: 2/2 · tool calls: 1 · elapsed: 6.5s · last: bash`) the decision
is actually made on, in three lines. It does **not** print the task: the prompt is on the tool card above and
in the transcript, only one child can hold the run guard at a time so the dialog can never be ambiguous, and a
paragraph-long title scrolls `Reject` and the rungs off the screen — which would silently enforce the ceiling on
a run the human meant to extend. `CeilingAsk.task` still carries it whole for a frontend with room to show it.

Nothing pauses while the question is open, because the SDK has no pause and a slow human should not be billed
for a stalled run — and a run the human means to extend is a run whose work is worth continuing. The hard
ceiling therefore *holds* while an offer is pending, up to `CEILING_OFFER_HOLD_MS` (6 min: the backstop behind
the dialog's own 5-minute timeout, so a broker that never answers cannot make a run unbounded). A granted
extension restarts **both** budgets from the moment of the answer — +N turns, and the minutes counted from
now, tool grace included — and the child is told so, in a steer that is deliberately not one of its two
"conclude now" asks. What happened is reported wherever a human or a model reads: `budget extended by the user
at the turn limit: +40 turns / +10 min` in the result header and on the card (also on the *running* card, so a
long borrowed run looks like one), `extension declined by the user at the turn limit` when it was refused, and
`details.ceiling` for a frontend. An extension never rewrites the exit: a run that needed the human's yes to
finish still says so.

`subagent.roles` is the role table: an entry naming a built-in edits it field by field (`tools`, `maxTurns`,
`timeoutMinutes`, `description`, `prompt`), and an entry naming anything else **adds a role** — which then
appears in the `<delegation>` prompt section, in `/subagentc roles` with the file it came from, and is
callable as `subagent(role: "that-name")`. A new role must declare `tools` (an implicit `"*"` would make
adding a role an escalation by accident), and its list is filtered against `FORBIDDEN_CHILD_TOOLS` whatever
it asks for. Names are `[a-z][a-z0-9_-]{0,31}` and matched case/separator-insensitively, so `Senior Reviewer`
finds `senior_reviewer`; two ids that fold together are refused at the parse. Nothing shipped edits or adds a
role, because a written `tools` list is live privilege rather than documentation — `/subagentc roles` prints
the built-ins with the shape to copy.

The model still never supplies a tool list: it names a role, and every name in the table is human-authored,
after the parent's gate floored config edits to `ask`.

**Except when two facts name the same thing.** An `edit` of `/x/a.ts` and the `path` fact `/x/a.ts` are
one location described twice, so they are judged once, by the most **specific** rule about them: a
concrete pattern (`path: "/secrets/*"`) beats a named surface's `"*"` (`edit: "ask"`), which beats
`permission["*"]` — the last of these is only the default action for tools nobody configured, never a
verdict about a location. That is what makes an in-workspace file operation pass *by default*, even in a
config whose whole `permission` map is `{"*": "ask"}`: the `path` surface is the gate's statement about
where the workspace ends, and a tool-name wildcard cannot out-rule it. Facts that name *different*
things (every shell segment, every redirect target) still combine most-restrictive.

Floors escalate a value to at least `ask` no matter what any rule says: protected paths (the gate's own
config and code, pi's config files, git hooks, the project's `.pi`), shell wrappers/expansion, external
directories, and any unparseable config (`degraded`). A floor is answered only by a rule that really
names the call — an exact rule for protected paths and wrappers, and for an outside path any *scoped*
rule (a concrete `/dir/*` pattern, which is what a folder grant writes), so `"*": "allow"`-shaped
shortcuts never walk past them. Floors are **labels** and nothing more: they
explain an unusual call in the dialog title and in the review log, and they decide nothing once "allow
everything" is on; see the dialog section.

## Slash commands

Both are suffixed `c` ("command") so they cannot collide with a prompt file or skill of the same name:

| Command | Output |
| --- | --- |
| `/gatec [status\|grants\|reload\|allow [off\|5min\|session]\|reset grants [project\|global]\|off\|on]` | gate status editor, grant list, reload, allow-everything, clear grants, switch |
| `/subagentc [model\|limits\|roles\|status\|models]` | the effective subagent config, or one section of it |

`/subagentc` (was: "is a child running?") answers what the config actually does — the child model and
whether it is inherited or pinned, each limit with the file that set it (`loadSubagentLimits` now records
`origins`), the hard-coded roles with their budgets after the `subagent.maxTurns`/`timeoutMinutes` cap, the
extension ladder and the window the clock holds for that dialog, transcript paths, the nested-call ceiling, the
config files read (project vs global, trust state) and any parse errors. `models` lists what a `subagent.model` pin may name, flagging the session model, the
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

**A call is two questions, and gets one dialog each.** *What it does* (its own surface: every shell
segment, the tool name) and *where it goes* (`path`, `external_directory`) are decided separately and
asked in that order — `pi-gate: bash · location — … — question 2 of 2`. The split exists because the two
questions are answered by different rule shapes: `cat *` says nothing about a directory. One merged dialog
could only ever offer the command rule, so a whitelisted `cat /media/…/config.json | head -200` had its
command facts all allowed, its only `ask` coming from the boundary fact, and **no choice in the dialog
could close it** — it asked again on every retry, whatever was clicked. Now the location dialog offers the
**containing folder** on the surface that asked (`external_directory: /media/…/CraftGang/*`, which also
covers the folder itself and every sibling file), and one click ends it. A question is asked at most once
per call, so a grant that leaves a floor standing cannot loop the human through the same dialog twice:
answer every question the call raised and the call runs. A file tool's fact *is* a path, so file tools keep
raising one question; a call that touches a **protected path** is offered as the *exact* command or file
(never a wildcard, never a cross-cutting `path` rule), which is the only shape that floor accepts.

Dialog choices, in list order: `Allow once` · `Allow with reason…` · `Allow <rule> for this session` ·
`Allow <rule> for this project (<cwd>)` · `Allow <rule> for all projects` · `Abort` · `Abort with reason…` ·
`Allow everything for this session` · `Allow everything for 5 minutes`. All three "Allow <rule>" choices
write the **same** rule — one wildcard per command segment (`git status *`, `cd *`), stored per segment so a
chained command actually matches later; destructive (`rm`, `sudo`, `chmod`, …) and wrapper segments stay
exact. For a **file tool the rule is the containing folder** (`/x/y/*`, which also matches `/x/y` itself),
not the one file: the directory is the unit a human means when they allow a file, and it is what every
other harness grants on a sandbox escape. A path outside the workspace writes that pattern on
`external_directory` as well as on the tool's own surface, because `external_directory` is the surface
that asked — a grant naming only the tool would leave the outside-path question open and ask again
forever. A dismissed or timed-out dialog aborts (never allows) — and Esc on a note input counts as dismissed,
so changing one's mind mid-note never grants. No UI (`pi -p`) blocks with the exact rule needed to allow it.

The two note-taking choices are mirrors, and both texts the model sees are short markdown: `Blocked by user
with note: …` when the call is vetoed, `Allowed by user with note: …` prepended to the tool result when it is
let through (`handle.ts` `attachNote`, keyed by `toolCallId` — a `tool_call` result has no text channel). The
note travels with that one call, including a call made inside a subagent, which is what makes
"allow with reason" usable to steer a running agent instead of only vetoing it. No JSON config snippets and no
"do not retry" prose in any block text: they read as dares and invite config edits nobody asked for.

**Nothing in the dialog is truncated.** The title shows the whole call, every surfaced fact, and the exact
rule (`rule: …` line) that a grant choice would write — in full; the TUI word-wraps and scrolls. Only the
option labels shorten the rule (they have to stay single-line), and the unshortened rule sits right above
them. pi's own limits are separate and not extension-configurable: the collapsed transcript preview shows
20 visual lines (`ctrl+o` toggles it), and the bash tool caps what the *model* sees at 2000 lines / 50KB
while saving the full output to a temp file (`core/tools/truncate.js`) — the same "cut for the model, spill
for the human" convention the subagent's report budget follows (see *The report is the artifact*).

"Allow everything" (dialog, or `/gatec allow [off|5min|session]`) is **absolute**: while it is active no
`tool_call` reaches the dialog — other commands, other tools, a file outside the workspace, a hidden
`$(…)` argument, the gate's own config, pi's `settings.json`/`auth.json`, a git hook, even a config file
too broken to parse. That is the point: the choice is made by a human who is about to walk away (an
overnight run), and a switch that keeps asking is not a switch. Two things stay above it, and neither
can raise a dialog: a `deny` rule blocks (an explicit instruction outranks a mode), and the mode is
never inferable — not from a config file, not from the model, never across a restart.

The trade-off, stated plainly: with the mode on the agent can rewrite the gate's own config, and that
edit outlives the session. Floors stay as labels, so a `reviewLog` entry still names why a call looked
unusual (`floors: ["protected_path"]`). Turning it on notifies, and the footer counts the window down;
the 5-minute window closes on its own (status line + notify on expiry).

A floor labels what is really there: it is computed from the call, not from whether some rule happened to
be silent. And a rule whose pattern *is* the command — what "Allow this exact command" writes for a
wrapper or destructive segment — is a decision about that command and is honoured; otherwise a grant for
`npx vitest run` would be re-asked forever. Floors over coarse wildcards (`npx *`) still bite.

## Role defaulting, and why the tool gets used at all

`role` is **optional**; an unnamed call runs `subagent.defaultRole` (built in: `general-purpose`). Both earlier
shapes cost usage: a *required* role made every omitted role a validation failure inside pi, which a model
remembers as "this tool breaks", and *inferring* a role from the task text would let a regex decide
capabilities that only the caller knows — the model is the one party holding the intent, and it just declined
to name one. `general-purpose` is not an escalation: its tool list is the parent's own, and the parent's gate
still judges each nested call, so a forgotten role adds no permission. `"defaultRole": "explore"` makes
unnamed delegations read-only instead. Role words are canonicalized in `prepareArguments` (pi's pre-validation
shim), so `Explore`, `General Purpose` and `gp` run rather than fail; a word that names no role (`browse`) is
left untouched so the schema error teaches the model the enum. The old `code: "review"` alias is gone: "code"
reads as "write code", and mapping it to the read-only role would have handed back a child that cannot do
the task. Whatever role ran is shown as the human's decision, not the model's: `General Purpose (default)`
on the card and `role: general-purpose (default)` in the result block — and
`renderCall` tells "the arguments are still streaming" (`context.argsComplete`) apart from "no role arrived",
which is what used to render a bare title.

`subagent.delegationPrompt` (default `true`) adds a `<delegation>` system prompt section to each run
(`delegation.ts`; `applyDelegationSection` in `index.ts`). It exists because the tool's own `description` is
otherwise the only place the *reason* to delegate can live: pi renders `promptGuidelines` as flat bullets at
the tail of `<rules>`, next to the bash and read tool mechanics — enough to say what a tool is, never enough
to make a model reach for it. The section states when to delegate (more than about three reads or greps,
bulky output where only a verdict matters, a bounded change described completely, a second opinion on work
just done), when not to (one known read or edit, work the user asked to watch, the answer given to the
user), and what a child needs (every path in `task`, because it sees none of this conversation). It is
dropped when the tool or the switch is off, and when a handler forced the exact prompt text for the turn.
**A `customPrompt` does not drop it** — measured with the `pi-system-prompt` package installed, which is what
most pi setups run: pi renders a custom prompt as the `preamble` section and still appends the addendum,
project context, skills and cwd, so a prompt package replaces pi's preamble rather than asking for silence
from everything else. Dropping the section on `customPrompt` had it arriving nowhere at all. The text is
stable per config, so pi's section diff sends it once and re-sends only on change.

**Known structural limit, unchanged here:** one blocking child. OpenCode/Kilo-style fan-out (several explores
at once, or background children with a result poll) is the other reason those harnesses delegate more; our
`globalThis` guard and `executionMode: "sequential"` are load-bearing today — the shims run nested calls
through the parent's pipeline, where the gate answers one dialog at a time.

## The tool card

Two separate mechanisms feed one card, and only one of them is ours.

**pi's own renderer** (`pi-subagent/render.ts` — `renderCall`/`renderResult`) is what the terminal TUI and
`/export` HTML use: a title line, one sentence about the run — `Agent completed in 21.0s (5 turns, 6 tool
uses, 4.2k token).` — then `role · model · Agent ID`, the transcript path, and the child's report (10 lines
collapsed with a "more lines" hint built from the expand keybinding, never a hardcoded `ctrl+o`; **whole**
when expanded — expanding is the human asking for the rest, so there is no second clip). `details.report`
holds the child's *complete* answer on its own, so the card never re-parses the model-facing text and never
shows less than the child wrote. pi calls a renderer with `{ content, details }` only — never `usage` — which
is why the token total is also carried in `details.tokens`.

**The call block leads with the role and prints the whole prompt** (`labels.ts` builds the strings, so the
TUI and the frontend `details` cannot drift): `Explore` in bold, then the complete task under it, exactly as
sent. The role is the *first* line because a title is drawn in whatever width the transcript indent leaves,
and a tail is what wraps and what truncates; a title that began with a fixed phrase and appended the role
(`Launch subagent · explore`) buried the only variable part of the line. Nothing clips the task: a
delegation prompt is the human's instruction to a child they cannot watch, and an ellipsis where the rest of
the prompt should be makes the call unauditable (`taskLabel` flattens it to one line for single-line header
slots, `taskBody` prints it verbatim; `ctrl+o` scrolling is pi's affordance and is enough). The prompt is
there from the first render, before the child starts, and it is the same text at every state of the call —
the states are the *role*'s, not the prompt's, and there are three because pi renders while the arguments
stream: role named, role not yet arrived (`Launch subagent`, nothing invented), and role not sent at all
(`General Purpose (default)`). The running result block does not repeat the task — the call block above it
carries it whole.

**What a non-TUI frontend (Pendant) reads is `details`, not the renderers** — it never invokes them, so a
correct `Text` component buys nothing there. Worse: Pendant *claims our tool by name* — its subagent panel
recognizes a tool called `subagent`, gives it its own subagent card, and "its `renderCall` and `renderResult`
renderers are not used" (verified against the Pendant user guide shipped in the VSIX, `12-subagents.md`).
That card takes the agent's *name* from the launch **arguments** — `agent` or `name` for the recognized
`subagent` tool — and the label from `task`/`description`/`prompt`; our schema is `{ role, task }`, so
Pendant found no name and titled the card with its generic fallback. That is why no role appeared in the
card no matter what `formatCallBlock` returned. Two documented levers fix it from our side: `agent` in
`details` (the key the panel vocabulary uses for a step's agent), and `details.pendant = { title, subtitle }`,
which replaces the tool's name and the muted text after it in the header — read when the call finishes, and
ignored by pi's terminal. `subtitle` carries the **entire prompt on one line**: Pendant's own rule for a
header label is that it never shortens it in the data, only on screen, and "the whole label appears as its
tooltip" — which is where a human reads what the child was told to do. `run.ts` emits both, plus the field
names and status vocabulary
`@gotgenes/pi-subagents` established (`AgentDetails`/`GetResultDetails`: `displayName`, `subagentType`, one-line
`description`, `toolUses`, `durationMs`, `tokens`, `agentId`, `modelName`, `preview`, `uiStatus`), our own
`exit`/`elapsedMs`/`toolCalls`, and `status` (`completed`/`running`/`stopped`/`aborted`/`error`) — a `status`
it has no branch for leaves the card in its activity list with `No activity reported yet` where the result
belongs, which was the original bug. Making the *live* Pendant card name the role would need an argument
named `agent` or `subagent_type`, which the tool does not have and `prepareArguments` cannot fake: pi renders
the assistant message's own arguments, not the prepared ones.
`verification/probe-subagent-render.mjs` prints both `details` shapes and drives the renderers through the
real pi Theme and real pi-tui components; `verification/tui-card.mjs` drives pi's real `ToolExecutionComponent`
through streaming, running, finished and expanded, because the unit tests' fake theme cannot fail the way a
frontend or a wrapping terminal does. Every `onUpdate` still carries a complete `SubagentDetails`
(`status: "running"`, turns, tool uses, activity, model) and a 2s heartbeat re-emits it, so a child that thinks
for minutes without a tool event keeps reporting activity.

**Known limit, unchanged:** the *live* Pendant header still cannot name the role or show the prompt, because
that card builds its header from the launch **arguments** and `details.pendant` is only read at completion.
Fixing it needs an argument named `agent`/`subagent_type`, which the tool does not have and
`prepareArguments` cannot fake (pi renders the assistant message's own arguments, not the prepared ones).

## The report is the artifact: the model gets it whole

A delegation buys one thing — the child's answer. Cutting that answer and pointing at the transcript was
the old behaviour (`maxResultBytes: 20000`, footer "the full result is in the transcript"), and it was
counter-productive in exactly the case it was meant to bound: the parent then read a multi-hundred-KB
session JSONL to recover a tail it had already paid for, costing far more than the bytes it was spared. So
in `composeResult`:

- **Up to `subagent.maxResultBytes` (default now 64 KB) the report is returned whole**, line count
  irrelevant — pi's `truncateHead` also enforces 2000 lines by default, and a report is prose, not tool
  output, so the byte cap is passed as the only cap.
- **Beyond it, the head goes to the model and the *complete* report is written beside the transcript** as
  `<id>.report.md` (pi's own convention for cut tool output: name a file that holds only that output). The
  footer states the sizes, names the file and says *not* to re-read the transcript. If the spill file
  cannot be written (no transcript path, read-only home), the footer falls back to the transcript.
- One enormous line (a pasted blob) cannot swallow the budget: `truncateHead` never returns a partial line,
  so a 13-byte heading would be "the head" of a 20 KB budget. Past half the budget the cut moves to a byte
  boundary, on a UTF-8 character start (`sliceBytes`) — pi's bash tool makes the same trade.
- `details.report` is always the **whole** report: the byte cap bounds what the *model* is sent, never what
  the human is shown.

The cap is therefore a safety valve, not a budget — a report past 64 KB is a child that dumped a survey
instead of reporting one, and that is the case the file is for. The spill file sits in the agent dir, so
reading it is an `external_directory` call and the gate asks once (as it does for pi's own truncated bash
output file); `/subagentc limits` prints the number, its source file and this contract.

## Deviations from the plan (all verified against pi 1.4.0 types)

1. `typebox@1.3.27` instead of `@sinclair/typebox` — pi aliases both; `StringEnum` comes from `@earendil-works/pi-ai`.
2. `ToolCallEventBase` has **no `cwd`** in 1.4.0 (plan A3) — the handlers use `ctx.cwd`.
3. Shipped defaults add `"subagent": "allow"`: the child's own calls are gated, so gating the delegation
   too would double-prompt for a call that is only a container.
4. Child retry is **enabled but bounded** (`maxRetries: 2`, `maxAgentDelayMs: 5000`) instead of off: the
   free upstream 503s routinely, and the hard ceiling (now deferrable for a report, see Config) bounds the run.
5. `reviewLog` records allow decisions too, not only ask resolutions (FM-17 audit value).
6. Two extra modules: `pi-gate/handle.ts` (testable pipeline seam) and `pi-subagent/run.ts` (guard + result
   mapping), so `index.ts` stays wiring only.
7. The built-in default permission map is a real rule layer (`scope: "builtin"`) **only** when no config
   file supplies `permission` — otherwise a machine with no config would prompt for every call, reads
   included. A config that sets `permission` fully owns that layer, so its own `"*"` default still applies.
8. `FactCheck.floor` is set for the `external_directory` fallback too (the type always had the variant, the
   evaluator never assigned it) — an unlabelled floor would be invisible in a dialog title. Floors are
   computed from the call itself (`protected_path`, `protected_read`, `wrapper`, `external_directory`,
   `degraded_config`). They used to be split into `HARD_FLOORS`/`SOFT_FLOORS` and consulted by
   `allowAllBypasses()`, which made protected paths and a broken config un-silenceable; that split is
   gone (see the dialog section) — a floor now labels, it never overrules the mode.
9. `protectedPathGlobs` guards the agent dir's *code and config* (`extensions/*`, `bin`, `npm`, `git`,
   `settings.json`, `auth.json`, `models.json`, `SYSTEM.md`, …) rather than `~/.pi/agent/*` — flooring the
   whole dir made every transcript or log read look like a threat. A protected path reached by a read-only
   tool floors as `protected_read`, by anything that can write as `protected_path`; both are labels now.
10. `@earendil-works/pi-tui` is a peer dependency: `render.ts` needs pi's `Text` component to return a
    `Component` from `renderCall`/`renderResult`.
11. The slash commands are `/gatec` and `/subagentc` (the plan had `/gate` and `/subagents`) — the `c`
    keeps them clear of same-named prompt files and skills. `/subagentc` also grew from "is a child
    running?" into the config browser: the tool blocks, so by the time a human can look, there is never
    a running child to show.
12. Rule matching carries a **specificity** (`policy.ts` `SPECIFICITY`), and facts are grouped by the
    value they name before the call's action is combined. Without it `permission["*"] = "ask"` — a default
    for unconfigured tools — silently outruled the `path` rules for every file tool that the config does
    not name, so in-workspace `edit`/`write` prompted on machines whose config omitted those keys.
13. Folder-wide grants (`match.ts` `directoryPattern` + `GrantOffer.alsoSurfaces`): one click on a file
    allows its directory, and an outside directory gets the rule on `external_directory` too. Before
    this, no grant of any shape could silence an outside path — the tool-surface grant let the
    `external_directory` fact keep asking, so "Allow this file for all projects" changed nothing.
14. The two-question evaluation (`policy.ts` `Stage`/`buildStages`/`offerLocationGrant`, the stage loop in
    `handle.ts`, `GrantOffer.surfacePatterns`): a check joins the location stage when its value *is* a path
    spelling, which is why file tools stay single-dialog while shell calls touching the outside get two.
    `answersFloor` also accepts a call whose own rules are all exact ("the human named this call"), which
    is what finally makes a protected-path call grantable from the dialog. The `degraded_config` floor is
    raised only on the command stage — a broken config is one question, not one per fact.
15. `subagent.role` is optional, with `subagent.defaultRole` (built in: `general-purpose`) filling an unnamed
    call, and `resolveCallRole` never reads the task text. The plan's step 15 had the parameter required.
16. `prepareArguments` canonicalizes role spellings. pi exposes it as the compatibility hook run before
    validation, so it is where an alias belongs — not in a widened enum the model could abuse.
17. A `delegation` system prompt section (`subagent.delegationPrompt`), injected from `before_agent_start` by
    mutating `event.systemPromptOptions.sections`. The plan kept pi-subagent silent on the parent's prompt;
    without it the whole delegation policy is two `<rules>` bullets.
18. `promptGuidelines` is three bullets, not the plan's two under 160 characters in total (each bullet is
    under 160). The role list, the self-contained-task rule and the context argument do not fit in two.
19. A spent budget asks the human for a one-time extension (`subagent.askToExtend`, `pi-subagent/ceiling.ts`,
    `child.ts::onCeiling`), which the plan did not have: a ceiling was only ever a verdict there. The mechanism
    lives in `child.ts` (mutable budget, a held ceiling, one offer) and the question in `ceiling.ts`, so the
    child stays testable with no UI and the dialog stays testable with no session.

## Commands

```bash
npm test            # vitest run — 380 tests, no live provider needed
npm run typecheck   # tsc --noEmit
node verification/tui-card.mjs            # the card as pi's own ToolExecutionComponent draws it
node verification/rpc-gate-dialog.mjs "Allow once" /tmp/scratch   # dialog coverage (needs a provider)
node verification/rpc-ceiling-dialog.mjs "Extend by 40 turns"     # the ceiling dialog, granted
node verification/rpc-ceiling-dialog.mjs "Reject"                # …and refused: the old behaviour
node verification/rpc-ceiling-dialog.mjs dismiss                 # …and unanswered: Esc enforces (FM-11)
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
