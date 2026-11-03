/**
 * The environment the Docker tiers (test-spe, test-matrix) run `docker compose`
 * with, so a build works on the machine as it is set up.
 *
 * - Docker's own builder: a docker-container builder selected with `docker buildx
 *   use` would ship every 2 GB image back to Docker as a tarball, minutes per
 *   build. So the builder built into the context is named — but only when the
 *   current one is not it already: Compose 5.6 refuses `BUILDX_BUILDER` set to
 *   Docker Desktop's `desktop-linux` ("use `docker --context=desktop-linux buildx`").
 * - Docker Desktop's credential helper: a `docker` installed apart (Homebrew)
 *   reads Desktop's config, `credsStore: desktop`, without the helper on its
 *   PATH, and every image pull fails ("docker-credential-desktop: executable
 *   file not found").
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const DESKTOP_BIN = '/Applications/Docker.app/Contents/Resources/bin'

function read(args) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function builderVar() {
  const driver = /^Driver:\s*(\S+)/m.exec(read(['buildx', 'inspect']))?.[1]
  if (driver === 'docker') return {}
  return { BUILDX_BUILDER: read(['context', 'show']) || 'default' }
}

function pathVar(base) {
  const path = base.PATH ?? ''
  const onPath = path.split(delimiter).some((dir) => dir && existsSync(join(dir, 'docker-credential-desktop')))
  if (onPath || !existsSync(join(DESKTOP_BIN, 'docker-credential-desktop'))) return {}
  return { PATH: `${DESKTOP_BIN}${delimiter}${path}` }
}

/** `base` (the caller's environment, which wins for the builder) with what a build needs. */
export function dockerEnv(base = process.env) {
  return { ...builderVar(), ...base, ...pathVar(base) }
}
