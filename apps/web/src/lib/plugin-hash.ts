/**
 * Content-addressable hashing for plugin traceability.
 *
 * Computes a SHA-256 hash of the *functional* content of a plugin:
 * configSchema, templates (code), dependencies, runtime, languages.
 *
 * Metadata-only fields (name, description, version, icon, badges, organization,
 * catalogVisibility, origin, parentRef, changelog) are excluded so that
 * renaming or re-describing a plugin does not change its identity.
 */

/** Deep-sort object keys for canonical JSON representation. */
function sortKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * Compute a SHA-256 content hash for a plugin from its files.
 *
 * @param files - The plugin's file map (plugin.json + templates)
 * @returns Hex-encoded SHA-256 hash string
 */
export async function computePluginContentHash(
  files: Record<string, string>,
): Promise<string> {
  // Parse manifest
  let manifest: Record<string, unknown> = {}
  try {
    manifest = JSON.parse(files['plugin.json'] ?? '{}')
  } catch {
    // Invalid JSON — hash with empty manifest
  }

  // Extract functional fields only
  const functional: Record<string, unknown> = {
    configSchema: manifest.configSchema ?? {},
    dependencies: manifest.dependencies ?? {},
    runtime: manifest.runtime ?? [],
    languages: manifest.languages ?? [],
    scope: manifest.scope ?? 'lab',
  }

  // Collect template contents (sorted by filename for determinism)
  const templates: Record<string, string> = {}
  for (const [filename, content] of Object.entries(files)) {
    if (filename.endsWith('.template')) {
      templates[filename] = content
    }
  }
  functional.templates = templates

  // Build canonical JSON and hash
  const canonical = JSON.stringify(sortKeys(functional))
  const data = new TextEncoder().encode(canonical)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)

  // Convert to hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}
