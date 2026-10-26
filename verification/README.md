# Live verification drivers

Unit tests cover every decision rule offline. These two drivers cover what an offline test cannot: the
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

They load this repo's extensions explicitly with `--no-extensions -e ./pi-gate/index.ts …`, so a globally
installed copy cannot double-gate the same run. They need a live provider, so they consume quota. Expected evidence:

* `rpc-gate-dialog.mjs` — `[DIALOG] pi-gate: bash …` with all eight options; the title carries the whole
  call, every surfaced fact, and a `rule:` line with the unshortened patterns a grant would write (no
  `[…truncated]` anywhere, whatever the command length); the three grant scopes name the same per-segment
  wildcard rule (`ls * && echo *`); the tool runs only after the answer; `timeout` leaves it blocked
  (`Abort`, never allow); `Abort with reason` puts the typed text in the tool result verbatim; a remembered
  allow makes an identical second command run without a dialog; `everything for this session` is followed by
  a *different* second command, which must also run without a dialog.
* `rpc-subagent-gate.mjs` — a dialog titled `… from subagent(explore): <task>` raised by the **child's**
  call, and a `logs/review.jsonl` line whose `parentCallId` is the `subagent` call id.
