# Live verification drivers

Unit tests cover every decision rule offline. These two drivers cover what an offline test cannot: the
**dialog itself**, driven through `pi --mode rpc` (plan §11 A6/M2, A7/M3, FM-11, FM-12).

```bash
# one gated bash call: shows the 6-option dialog, then answers it
node verification/rpc-gate-dialog.mjs "Allow once"      /path/to/scratch/project
node verification/rpc-gate-dialog.mjs "Abort with reason" /path/to/scratch/project
node verification/rpc-gate-dialog.mjs timeout           /path/to/scratch/project   # needs gate.promptTimeoutMs

# a subagent child's tool call, prompted in the parent
node verification/rpc-subagent-gate.mjs "Allow once" /path/to/scratch/project
```

They load this repo's extensions explicitly with `--no-extensions -e ./pi-gate/index.ts …`, so a globally
installed copy cannot double-gate the same run. They need a live provider, so they consume quota. Expected evidence:

* `rpc-gate-dialog.mjs` — `[DIALOG] pi-gate: bash …` with all six options; the tool runs only after the
  answer; `timeout` leaves it blocked (`Abort`, never allow); `Abort with reason` puts the typed text in the
  tool result verbatim.
* `rpc-subagent-gate.mjs` — a dialog titled `… from subagent(explore): <task>` raised by the **child's**
  call, and a `logs/review.jsonl` line whose `parentCallId` is the `subagent` call id.
