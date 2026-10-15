#!/usr/bin/env node
// Install the DuckDB extensions Linkr loads, ahead of time, in apps/api's venv —
// for a server with no internet access (see apps/api/app/duckdb_extensions.py).
// Options pass through: `npm run duckdb:extensions -- --repository <url>`.

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/api')
const python = [
  path.join(apiDir, '.venv/bin/python'),
  path.join(apiDir, '.venv/Scripts/python.exe'),
].find(existsSync)
if (!python) {
  console.error('apps/api/.venv not found — install the backend first (see the manual installation guide).')
  process.exit(1)
}

// From apps/api so `app` is importable; the backend reads apps/api/.env (LINKR_DATA_DIR) as at run time.
const child = spawn(python, ['-m', 'app.duckdb_extensions', ...process.argv.slice(2)], { cwd: apiDir, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
