# Agent bench — results

Re-run and update when the system prompt or the tool definitions change
materially. See [README.md](README.md) for how to run it.

## 2026-08-06 — 13 cases, 1 run each, Ollama on an M-series Mac

| Model | Score | Avg/case | Verdict |
|---|---|---|---|
| `qwen3.5:4b` | **13/13 (100%)** | 54 s | Recommended default |
| `llama3.2:3b` | 4/13 (31%) | 4.7 s | Fast, but cannot build widgets |
| `gemma3:4b` | 0/13 | — | No tool-calling: HTTP 400 |
| `llama3.1:8b` | not benched | — | Earlier spike: 12/15, failed refusal 3/3 |

### `qwen3.5:4b` — everything passes

Including the cases written to be hard: resolving "âge gestationnel" (a label) to
`col_ga_weeks` (an id) in both French and English, a scatter needing two columns,
one request producing a tab plus two widgets, translating "moitié gauche" to
`x=0, w=6`, and declining an out-of-scope deletion without grabbing a nearby
tool.

Cost: ~54 s per case on this machine. Slow, but every case is a full multi-turn
agent loop (often 3-4 model round-trips), not a single completion.

### `llama3.2:3b` — the interesting failure

4/13, and **the split matters more than the score**. It passes everything that is
one shot with no data lookup (deleting by name, refusing out-of-scope, answering
a question) and fails everything that requires reading the dataset then acting:

- `xColumn=undefined` — it called `add_widget` without ever calling
  `describe_dataset`, so it had no column ids to use.
- `calls: add_tab → pneumologie → add_tab` — it emitted a tool call named after
  the *argument* rather than the tool, then retried.
- `calls: add_widget → add_tab → add_widget → describe_dataset → add_widget → add_widget`
  — it thrashed, calling tools in a plausible-looking but incoherent order.

So the limit is not vocabulary or language: it is holding a two-step plan
("look up the columns, then use them"). That is what separates a 3B from a 4B
here, and it is unlikely to be fixed by prompt wording.

Worth noting it is **11× faster**. If a future need is latency-bound and
single-step (say, a filter toggle), a 3B is viable for that narrow job.

### `gemma3:4b` — cannot be used

Ollama rejects the request outright: `does not support tools` (HTTP 400). Nothing
to tune. Same for `deepseek-r1:*` locally.

## What this changed in the code

The bench is not a scoreboard; each failure it surfaced became a fix, and the
principle we settled on is: **fix it deterministically in the tools or the
context, not by adding a sentence to the prompt.** A tool-side fix works for
every model and costs no tokens; a prompt sentence is hopeful and is re-sent on
every request.

- Column **name vs id** — the failure that started this (a histogram rendered
  with an empty picker). Fixed in two places: the dataset context now leads with
  the column id, and the tools rewrite a name-valued config field to its id.
- **Title casing** — models echo the user's lowercase wording; the tools
  capitalise instead.
- **Tab/widget by name** — models pass "Tab 7" where an id belongs; the tools
  resolve names as well as ids.
- **Tool calls printed as prose** — recovered by `salvageTextToolCall`, which is
  how a small model's malformed output still works.

## Adding a case

Add it to `cases.mjs` with a check on the resulting **state**, never on the tool
sequence. Prefer cases drawn from real failures — a bench full of things that
already pass measures nothing.
