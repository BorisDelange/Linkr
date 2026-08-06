/**
 * Agent bench — run the copilot's test battery against one or more local models.
 *
 * NOT part of `npm test`: it needs a running model, takes minutes, and its result
 * is a judgement about a MODEL, not about the code. Run it when changing the
 * prompt, the tools, or when evaluating a new model.
 *
 *   node scripts/agent-bench/run.mjs qwen3.5:4b
 *   node scripts/agent-bench/run.mjs qwen3.5:4b llama3.1:8b --runs 3
 *   node scripts/agent-bench/run.mjs --all --json results.json
 *
 * It imports the REAL tool definitions, system prompt and dispatcher, so a pass
 * here means the shipped code works with that model — not a parallel
 * reimplementation that might drift.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { CASES, FIXTURE } from './cases.mjs'
import { buildState, runCase } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_BASE_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434/v1'

function parseArgs(argv) {
  const models = []
  const options = { runs: 1, json: null, only: null, baseUrl: DEFAULT_BASE_URL }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--runs') options.runs = Number(argv[++i])
    else if (arg === '--json') options.json = argv[++i]
    else if (arg === '--only') options.only = argv[++i]
    else if (arg === '--url') options.baseUrl = argv[++i]
    else if (arg === '--all') options.all = true
    else models.push(arg)
  }
  return { models, options }
}

async function listOllamaModels(baseUrl) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`)
  if (!response.ok) throw new Error(`cannot list models: HTTP ${response.status}`)
  const payload = await response.json()
  return (payload.data ?? []).map((entry) => entry.id).filter(Boolean)
}

const GREEN = '[32m'
const RED = '[31m'
const DIM = '[2m'
const BOLD = '[1m'
const OFF = '[0m'

async function benchModel(model, options) {
  const cases = options.only
    ? CASES.filter((c) => c.id.includes(options.only))
    : CASES
  console.log(`\n${BOLD}${'='.repeat(72)}\n${model}${OFF}  ${DIM}(${cases.length} cases × ${options.runs} run(s))${OFF}`)

  const results = []
  for (const testCase of cases) {
    const attempts = []
    for (let run = 0; run < options.runs; run++) {
      const state = buildState(FIXTURE)
      testCase.seed?.(state)
      try {
        const outcome = await runCase({
          model,
          baseUrl: options.baseUrl,
          prompt: testCase.prompt,
          state,
        })
        const failure = testCase.check(state)
        attempts.push({
          ok: !failure,
          detail: failure,
          calls: outcome.calls,
          ms: outcome.ms,
          promptTokens: outcome.promptTokens,
        })
      } catch (error) {
        attempts.push({ ok: false, detail: `ERROR ${error.message}`, calls: [], ms: 0 })
      }
    }

    const passed = attempts.filter((a) => a.ok).length
    const avgMs = Math.round(attempts.reduce((sum, a) => sum + a.ms, 0) / attempts.length)
    const colour = passed === attempts.length ? GREEN : passed === 0 ? RED : ''
    const mark = passed === attempts.length ? '✓' : passed === 0 ? '✗' : '~'
    console.log(
      `  ${colour}${mark} ${passed}/${attempts.length}${OFF} ${testCase.id} ${DIM}(${avgMs}ms, ${testCase.lang})${OFF}`
    )
    for (const attempt of attempts.filter((a) => !a.ok)) {
      console.log(`      ${DIM}${attempt.detail}${OFF}`)
      if (attempt.calls.length) {
        console.log(`      ${DIM}calls: ${attempt.calls.join(' → ')}${OFF}`)
      }
    }
    results.push({
      id: testCase.id,
      lang: testCase.lang,
      passed,
      total: attempts.length,
      avgMs,
      failures: attempts.filter((a) => !a.ok).map((a) => a.detail),
    })
  }

  const passed = results.reduce((sum, r) => sum + r.passed, 0)
  const total = results.reduce((sum, r) => sum + r.total, 0)
  const avgMs = Math.round(results.reduce((sum, r) => sum + r.avgMs, 0) / results.length)
  const pct = Math.round((passed / total) * 100)
  console.log(
    `\n  ${BOLD}${model}: ${passed}/${total} (${pct}%)${OFF} ${DIM}avg ${avgMs}ms/case${OFF}`
  )
  return { model, passed, total, pct, avgMs, results }
}

const { models, options } = parseArgs(process.argv.slice(2))

let targets = models
if (options.all || !targets.length) {
  targets = await listOllamaModels(options.baseUrl)
  if (!models.length && !options.all) {
    console.error(
      'usage: node scripts/agent-bench/run.mjs <model> [model...] [--runs N] [--json out] [--only substring]'
    )
    console.error(`\navailable: ${targets.join(', ')}`)
    process.exit(1)
  }
}

const summaries = []
for (const model of targets) {
  summaries.push(await benchModel(model, options))
}

if (summaries.length > 1) {
  console.log(`\n${BOLD}${'='.repeat(72)}\nSUMMARY${OFF}`)
  for (const summary of [...summaries].sort((a, b) => b.pct - a.pct)) {
    console.log(
      `  ${String(summary.pct).padStart(3)}%  ${summary.model.padEnd(32)} ${DIM}${summary.avgMs}ms/case${OFF}`
    )
  }
}

if (options.json) {
  const path = resolve(process.cwd(), options.json)
  writeFileSync(path, JSON.stringify({ ranAt: new Date().toISOString(), summaries }, null, 2))
  console.log(`\nwrote ${path}`)
}
