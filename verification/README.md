# Live verification drivers

Unit tests cover every decision rule offline. These drivers cover what an offline test cannot: the
**dialog itself**, driven through `pi --mode rpc` (plan §11 A6/M2, A7/M3, FM-11, FM-12).

```bash
# two prompts, one gated bash call each; shows the 8-option dialog
node verification/rpc-gate-dialog.mjs "<label substring | option index>" <project dir> ["<second command>"]
node verification/rpc-gate-dialog.mjs "Allow once"         /tmp/scratch                       # => 2 dialogs
node verification/rpc-gate-dialog.mjs "for this session"   /tmp/scratch "ls -la src && echo DONE"   # identical command => 1
node verification/rpc-gate-dialog.mjs "5 minutes"          /tmp/scratch                       # anything runs => 1
node verification/rpc-gate-dialog.mjs "Abort with reason"  /tmp/scratch
node verification/rpc-gate-dialog.mjs timeout             /tmp/scratch                       # needs gate.promptTimeoutMs

# a subagent child's tool call, prompted in the parent
node verification/rpc-subagent-gate.mjs "Allow once" /tmp/scratch/project

# a child that spent its turn budget, asking the parent for more of it
node verification/rpc-ceiling-dialog.mjs "Extend by 40 turns"
node verification/rpc-ceiling-dialog.mjs "Reject"
node verification/rpc-ceiling-dialog.mjs "no answer"     # waits out the 5-min dialog timeout
```

# the subagent card: what a frontend gets in `details`, and what the renderers draw (no provider, no quota)
node verification/probe-subagent-render.mjs [width]

They refuse to answer when no option matches the requested label: an earlier version fell back to
"Allow once" silently and skewed the run. To keep the child `pi` out of your own config — and your
`grants.global` out of the test — point it at a scratch agent dir holding only credentials:

```bash
mkdir -p /tmp/gate-agent/extensions && cp ~/.pi/agent/auth.json ~/.pi/agent/models.json /tmp/gate-agent/
echo '{}' > /tmp/gate-agent/settings.json
PI_CODING_AGENT_DIR=/tmp/gate-agent node verification/rpc-gate-dialog.mjs "for this session" /tmp/scratch
```

`rpc-ceiling-dialog.mjs` builds that scratch dir by itself — credentials copied, and a config whose only purpose
is an `explore` role with `maxTurns: 2`, which is how a ceiling gets reached in seconds without editing
anybody's real config. It also allows every tool call, because the dialog under test is the ceiling's, not the
gate's.

They load this repo's extensions explicitly with `--no-extensions -e ./pi-gate/index.ts …`, so a globally
installed copy cannot double-gate the same run. They need a live provider, so they consume quota. Expected evidence:

* `rpc-gate-dialog.mjs` — `[DIALOG] pi-gate: bash …` with all nine options; the title carries the whole
  call, every surfaced fact, and a `rule:` line with the unshortened patterns a grant would write (no
  `[…truncated]` anywhere, whatever the command length); the three grant scopes name the same per-segment
  wildcard rule (`ls * && echo *`); the tool runs only after the answer; `timeout` leaves it blocked
  (`Abort`, never allow); `Abort with reason` puts `Blocked by user with note: <text>` in the tool result
  verbatim, `Allow with reason` lets the call run and puts `Allowed by user with note: <text>` on its result; a remembered
  allow makes an identical second command run without a dialog; `everything for this session` is followed by
  a *different* second command, which must also run without a dialog.
  A command that touches a path outside the workspace raises **two** dialogs — `pi-gate: bash — …` then
  `pi-gate: bash · location — … — question 2 of 2` — and answering only the first is not enough: check
  that the second one's `rule:` line names the folder (`/that/dir/*` on `external_directory`) and that a
  third, sibling call in the same folder after the grant raises no dialog at all.
* `rpc-subagent-gate.mjs` — a dialog titled `… from subagent(explore): <task>` raised by the **child's**
  call, and a `logs/review.jsonl` line whose `parentCallId` is the `subagent` call id.
* `rpc-ceiling-dialog.mjs` — one dialog titled `pi-subagent: Explore — reached its limit of 2 turns`, its options
  `Reject` first and then the four rungs; `Extend by 40 turns` continues the child past the limit it just hit
  (turn count above the budget, `budget extended by the user at the turn limit: +40 turns / +10 min` in the
  result header, `DONE`); `Reject` is the old behaviour with one extra line (`extension declined by the user at
  the turn limit`, `INCOMPLETE (maxTurns)`); `no answer` must behave exactly like `Reject` once the dialog times out — 5 minutes of a child still
  working, then the limit stands (FM-11: an unanswered dialog grants nothing). `pi -p`, with no UI at all, must raise no dialog and report `no UI to ask for an extension at the turn limit`
  next to `INCOMPLETE (maxTurns)`. Only ever **one** ceiling dialog per run, and the child keeps
  working while the question is open, which is expected: nothing in the SDK can pause it.
