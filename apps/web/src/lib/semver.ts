/** Minimal semver bump utility for plugin versioning. */

export type BumpType = 'patch' | 'minor' | 'major'

/** Parse a semver string into [major, minor, patch]. Returns [1, 0, 0] for invalid input. */
export function parseSemver(version: string): [number, number, number] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return [1, 0, 0]
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)]
}

/** Bump a semver version string (e.g. patch: 1.2.3 → 1.2.4). */
export function bumpVersion(version: string, type: BumpType): string {
  const [major, minor, patch] = parseSemver(version)
  switch (type) {
    case 'major': return `${major + 1}.0.0`
    case 'minor': return `${major}.${minor + 1}.0`
    case 'patch': return `${major}.${minor}.${patch + 1}`
  }
}
