/**
 * Agent bench (CLI) — run the copilot's test battery against local models.
 *
 * NOT part of `npm test`: it needs a model running, takes minutes, and measures a
 * property of the MODEL rather than of the code. The same battery is available in
 * the app under Workspace settings → AI assistant → Tests; this CLI exists for
 * comparing several models unattended and saving the result.
 *
 *   node scripts/agent-bench/run.mjs qwen3.5:4b
 *   node scripts/agent-bench/run.mjs qwen3.5:4b llama3.2:3b --runs 3
 *   node scripts/agent-bench/run.mjs --all --json bench.json --mode quick
 *
 * Cases and runner are imported from src/lib/agent/bench/ — one battery, so the
 * CLI and the in-app tab can never disagree.
 */
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434/v1'

function parseArgs(argv) {
  const models = []
  const options = { runs: 1, json: null, mode: 'full', baseUrl: DEFAULT_URL, all: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--runs') options.runs = Number(argv[++i])
    else if (arg === '--json') options.json = argv[++i]
    else if (arg === '--mode') options.mode = argv[++i]
    else if (arg === '--url') options.baseUrl = argv[++i]
    else if (arg === '--all') options.all = true
    else models.push(arg)
  }
  return { models, options }
}

const { models, options } = parseArgs(process.argv.slice(2))

const server = await createServer({
  root: WEB_ROOT,
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
  logLevel: 'error',
})
const { runBench } = await server.ssrLoadModule('/src/lib/agent/bench/runner.ts')
const { default: manifest } = await server.ssrLoadModule(
  '/../../packages/default-plugins/analyses/plot-builder/plugin.json'
)

async function listModels(baseUrl) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`)
  if (!response.ok) throw new Error(`cannot list models: HTTP ${response.status}`)
  const payload = await response.json()
  return (payload.data ?? []).map((entry) => entry.id).filter(Boolean)
}

let targets = models
if (options.all || !targets.length) {
  const available = await listModels(options.baseUrl)
  if (!options.all) {
    console.error('usage: node scripts/agent-bench/run.mjs <model> [...] [--runs N] [--mode quick|full] [--json out]')
    console.error(`\navailable: ${available.join(', ')}`)
    await server.close()
    process.exit(1)
  }
  targets = available
}

const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const OFF = '\x1b[0m'
const summaries = []

for (const model of targets) {
  console.log(`\n${BOLD}${'='.repeat(70)}\n${model}${OFF}`)
  const runs = []
  for (let run = 0; run < options.runs; run++) {
    const report = await runBench({
      endpoint: { baseUrl: options.baseUrl, model },
      manifest,
      mode: options.mode,
      signal: new AbortController().signal,
      onProgress: (result) => {
        const mark = result.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
        console.log(`  ${mark} ${result.id} ${DIM}(${(result.ms / 1000).toFixed(1)}s)${OFF}`)
        if (!result.ok) {
          console.log(`      ${DIM}${result.detail}${OFF}`)
          if (result.calls.length) console.log(`      ${DIM}calls: ${result.calls.join(' → ')}${OFF}`)
        }
      },
    })
    runs.push(report)
  }
  const passed = runs.reduce((sum, r) => sum + r.passed, 0)
  const total = runs.reduce((sum, r) => sum + r.total, 0)
  const tokensPerSecond = runs.reduce((sum, r) => sum + r.tokensPerSecond, 0) / runs.length
  const msPerCase = runs.reduce((sum, r) => sum + r.totalMs / r.total, 0) / runs.length
  console.log(
    `\n  ${BOLD}${model}: ${passed}/${total} (${Math.round((passed / total) * 100)}%)${OFF} ` +
      `${DIM}${tokensPerSecond.toFixed(1)} tok/s · ${(msPerCase / 1000).toFixed(1)}s/case${OFF}`
  )
  summaries.push({ model, passed, total, tokensPerSecond, msPerCase, runs })
}

if (summaries.length > 1) {
  console.log(`\n${BOLD}${'='.repeat(70)}\nSUMMARY${OFF}`)
  for (const s of [...summaries].sort((a, b) => b.passed / b.total - a.passed / a.total)) {
    const pct = Math.round((s.passed / s.total) * 100)
    console.log(
      `  ${String(pct).padStart(3)}%  ${s.model.padEnd(30)} ${DIM}${s.tokensPerSecond.toFixed(1)} tok/s · ${(s.msPerCase / 1000).toFixed(1)}s/case${OFF}`
    )
  }
}

if (options.json) {
  const path = resolve(process.cwd(), options.json)
  writeFileSync(path, JSON.stringify({ ranAt: new Date().toISOString(), summaries }, null, 2))
  console.log(`\nwrote ${path}`)
}

await server.close()
