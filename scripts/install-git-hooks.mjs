// Point git at our versioned hooks directory so the pre-push quality gate is
// active for everyone without copying files around. Idempotent.
//
// Runs from `prepare` on every `npm install`/`npm ci`, including CI. It must
// NEVER fail the install: a dev convenience hook is not worth breaking a build
// or deploy over, so every step degrades to a warning when git or the repo
// isn't present (CI tarballs, `--ignore-scripts` environments, etc.).
import { execSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hooksDir = path.join(root, 'scripts', 'git-hooks')

try {
  if (!existsSync(hooksDir) || !existsSync(path.join(root, '.git'))) {
    // No repo (e.g. CI install from tarball) — nothing to wire up.
    process.exit(0)
  }

  // Make every hook executable (git ignores non-executable hooks).
  for (const f of readdirSync(hooksDir)) {
    chmodSync(path.join(hooksDir, f), 0o755)
  }

  execSync('git config core.hooksPath scripts/git-hooks', { cwd: root, stdio: 'inherit' })
  console.log('✓ git hooks installed (core.hooksPath → scripts/git-hooks)')
} catch (e) {
  console.warn(`⚠ skipped git hook install: ${e.message}`)
}
