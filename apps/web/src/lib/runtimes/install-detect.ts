// Commands that install packages imperatively (from a REPL terminal or a run
// script) — detected to warn that this bypasses the declarative environment: the
// package lands in the library but not the lockfile, so it won't show in the
// Environments manager, won't travel in git, and is wiped on the next build.
// Best-effort; a miss only means no warning, never a broken run.
const INSTALL_RE: Record<'python' | 'r', RegExp> = {
  python: /\b(pip\s+install|uv\s+(add|pip\s+install)|conda\s+install|!pip\s+install)\b/,
  r: /\b(install\.packages|renv::install|devtools::install|remotes::install|BiocManager::install)\b/,
}

export function isImperativeInstall(language: 'python' | 'r', code: string): boolean {
  return INSTALL_RE[language].test(code)
}

// A CRAN/PyPI package name (optionally with a version spec). Deliberately strict —
// the same allowlist the backend validates against — so a captured name is always
// safe to re-run through the declarative manager.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:[=<>!~]=?[A-Za-z0-9][A-Za-z0-9.*-]*)?$/

/**
 * Best-effort extraction of the package name(s) an imperative install command
 * targets, so we can offer to install them the *declarative* way. Returns [] when
 * nothing parseable is found (e.g. installing from a URL/local path) — the caller
 * then offers only "open the manager", not a one-click install.
 *
 * R:      install.packages("ggplot2") · install.packages(c("dplyr", "tidyr")) · renv::install("readr")
 * Python: pip install pandas numpy · pip install "pandas==2.1" · uv add polars
 */
export function extractInstallPackages(language: 'python' | 'r', code: string): string[] {
  return language === 'r' ? extractR(code) : extractPython(code)
}

function extractR(code: string): string[] {
  const names: string[] = []
  // Grab the argument list of each install call, then pull quoted strings from it.
  const callRe = /(?:install\.packages|renv::install|devtools::install|remotes::install|BiocManager::install)\s*\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = callRe.exec(code)) !== null) {
    for (const q of m[1].matchAll(/["']([^"']+)["']/g)) {
      // devtools/remotes take "user/repo" GitHub refs — not a plain CRAN name; skip.
      if (!q[1].includes('/')) names.push(q[1])
    }
  }
  return dedupeValid(names)
}

function extractPython(code: string): string[] {
  const names: string[] = []
  const callRe = /(?:pip\s+install|uv\s+add|uv\s+pip\s+install|conda\s+install|!pip\s+install)\s+([^\n;&|]+)/g
  // Flags that consume the following token as their value (a file path, not a
  // package) — skip both so `-r requirements.txt` doesn't look like a package.
  const VALUE_FLAGS = new Set(['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '--index-url', '-i', '--extra-index-url'])
  let m: RegExpExecArray | null
  while ((m = callRe.exec(code)) !== null) {
    const tokens = m[1].split(/\s+/)
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i].replace(/^["']|["']$/g, '')
      if (!tok) continue
      if (VALUE_FLAGS.has(tok)) {
        i++ // skip this flag's value token
        continue
      }
      if (tok.startsWith('-')) continue // a bare flag (-U, --quiet)
      names.push(tok)
    }
  }
  return dedupeValid(names)
}

function dedupeValid(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    const name = n.trim()
    if (NAME_RE.test(name) && !seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}
