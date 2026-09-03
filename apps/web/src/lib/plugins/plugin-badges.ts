/**
 * The language chips a plugin card shows. Shared so the picker and the Plugins
 * page cannot drift apart — they used to carry two copies with different labels
 * and sizes.
 */
export const LANG_BADGE: Record<string, { label: string; color: string }> = {
  python: { label: 'Python', color: 'text-yellow-500 bg-yellow-500/10' },
  r: { label: 'R', color: 'text-blue-500 bg-blue-500/10' },
}

/** The one chip shape every plugin card uses, whatever the chip says. */
export const PLUGIN_CHIP_CLASS =
  'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight'
