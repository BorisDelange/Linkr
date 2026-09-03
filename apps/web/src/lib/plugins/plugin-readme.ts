import type { Plugin } from '@/types/plugin'

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
