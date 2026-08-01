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
