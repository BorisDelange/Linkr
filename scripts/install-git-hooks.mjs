// Point git at our versioned hooks directory so the pre-push quality gate is
// active for everyone without copying files around. Idempotent.
import { execSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hooksDir = path.join(root, 'scripts', 'git-hooks')

if (!existsSync(hooksDir)) {
  console.error(`No hooks directory at ${hooksDir}`)
  process.exit(1)
}

// Make every hook executable (git ignores non-executable hooks).
for (const f of readdirSync(hooksDir)) {
  chmodSync(path.join(hooksDir, f), 0o755)
}

execSync('git config core.hooksPath scripts/git-hooks', { cwd: root, stdio: 'inherit' })
console.log('✓ git hooks installed (core.hooksPath → scripts/git-hooks)')
