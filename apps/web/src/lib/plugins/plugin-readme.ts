import type { Plugin } from '@/types/plugin'

// A built-in's README images, bundled from `attachments/` beside its manifest.
// Vite rewrites each to its hashed asset URL, so the markdown's relative
// `attachments/<file>` paths can be swapped for something the browser can load.
const attachmentUrls = import.meta.glob<string>(
  '@default-plugins/*/*/attachments/*.{png,jpg,jpeg,gif,svg,webp}',
  { query: '?url', import: 'default', eager: true },
)

/**
 * Manifest id → folder, for the folders whose name is not simply the id's last
 * segment. Only the exceptions need listing.
 */
const FOLDER_OVERRIDES: Record<string, string> = {
  'linkr-analysis-table1': 'table1',
  'linkr-widget-patient-overview': 'overview',
  'linkr-widget-notes': 'notes',
  'linkr-widget-timeline': 'timeline',
  'linkr-widget-patient-summary': 'patient-summary',
}

/** The `packages/default-plugins/*` folder a built-in manifest id ships from. */
export function pluginFolder(manifestId: string): string {
  return FOLDER_OVERRIDES[manifestId] ?? manifestId.replace(/^linkr-(analysis|widget)-/, '')
}

/** `<folder>/<file>` → bundled URL, for every attachment shipped with a plugin. */
const ATTACHMENTS: Record<string, string> = {}
for (const [path, url] of Object.entries(attachmentUrls)) {
  const m = /\/([^/]+)\/attachments\/([^/]+)$/.exec(path)
  if (m) ATTACHMENTS[`${m[1]}/${m[2]}`] = url
}

/**
 * Rewrite a bundled README's `attachments/<file>` links to their asset URLs.
 * A plugin whose README references a file it does not ship is left alone, so the
 * markdown still shows its alt text rather than a broken relative link.
 */
export function resolvePluginAttachments(markdown: string, folder: string): string {
  return markdown.replace(
    /(\]\(\s*)attachments\/([^)\s]+)/g,
    (whole, prefix: string, file: string) => {
      const url = ATTACHMENTS[`${folder}/${file}`]
      return url ? `${prefix}${url}` : whole
    },
  )
}

/**
 * Whether a plugin has documentation to show, in any language.
 *
 * Drives whether the picker's card offers a way into the README and whether the
 * widget editor grows a Doc tab — a plugin without one shows neither.
 */
export function hasPluginReadme(plugin: Plugin | undefined | null): boolean {
  if (!plugin?.readme) return false
  return Object.values(plugin.readme).some((text) => text?.trim())
}
