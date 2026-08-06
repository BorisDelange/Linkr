# Agent bench

A manual test battery for the dashboard copilot, run against **real models**.

It is deliberately **not** part of `npm test`: it needs a model running, takes
minutes, and what it measures is a property of the MODEL, not of the code. Run it
when you change the system prompt, the tool definitions, or when evaluating a new
model.

**The same battery is available in the app**, under Workspace settings → AI
assistant → Tests. Use that to answer "how does this model behave on THIS
machine" (speed varies with hardware; results are stored per model, and can be
deleted individually or all at once). This CLI exists for comparing several
models unattended and saving the output to a file.

Cases and runner live in `src/lib/agent/bench/` — one battery, so the CLI and the
in-app tab can never disagree.

```bash
# one model
node scripts/agent-bench/run.mjs qwen3.5:4b

# compare, with repeats to see variance
node scripts/agent-bench/run.mjs qwen3.5:4b llama3.1:8b --runs 3

# a single case while iterating
node scripts/agent-bench/run.mjs qwen3.5:4b --only vague-column

# every model the endpoint offers, saved to a file
node scripts/agent-bench/run.mjs --all --json bench.json
```

Default endpoint is `http://localhost:11434/v1` (Ollama); override with `--url`
or `OLLAMA_URL`.

## What it exercises

`cases.mjs` holds the battery. Each case is a user request plus a check on the
resulting dashboard **state** — not on which tools were called, or in what order.
Several routes reach the same result and all of them are correct; asserting the
route would fail good models for cosmetic reasons.

The fixture mirrors a real clinical dataset: opaque column names (`ga_weeks`)
with human labels ("Âge gestationnel"), which is the hard case.

| Group | Cases | What it catches |
|---|---|---|
| Creating | tab in FR/EN, lowercase title | title casing, basic tool use |
| Widgets | explicit column, vague column FR/EN, scatter with two columns, tab + 2 widgets, half width | column id vs name, plugin config, layout arithmetic |
| Deleting | tab by name, widget by name | name→id resolution, confirmation gate |
| Refusal | out-of-scope request, capability question | not grabbing the nearest tool |

## Reading a failure

The runner prints the failed check plus the tools the model actually called, so a
failure usually points straight at the cause:

- `xColumn=ga_weeks` — the model used the column NAME where the config needs the
  id (`col_ga_weeks`). This is the failure that motivated the id-first dataset
  context and the name→id rewrite in the tools.
- `not capitalised: "cardiologie"` — the model echoed the user's casing.
- `calls: add_widget` on the refusal case — the model reached for the nearest
  tool rather than declining, the behaviour the whitelist exists to contain.

A failure is a design signal first: prefer fixing it in the tools or the context
(deterministic, works for every model) over adding a sentence to the prompt
(hopeful, and costs tokens on every request).

## Results

Recorded in [RESULTS.md](RESULTS.md). Re-run and update it when the prompt or the
tools change materially.

## Tool-calling support is a hard prerequisite

A model without native tool-calling in Ollama cannot drive the copilot at all —
it never emits `tool_calls`, so nothing happens. Check before benching:

```bash
curl -s http://localhost:11434/api/show -d '{"model":"gemma3:4b"}' | grep -q '"tools"' \
  && echo supported || echo unsupported
```

Known locally: `qwen3.5:4b`, `llama3.2:3b`, `llama3.1:8b` support it;
`gemma3:*` and `deepseek-r1:*` do not.
