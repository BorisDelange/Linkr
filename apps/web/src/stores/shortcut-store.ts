import { create } from 'zustand'
import {
  DEFAULT_SHORTCUTS,
  NOTEBOOK_PRESETS,
  notebookActionIds,
  type ShortcutActionId,
  type KeyCombo,
  type ShortcutDefinition,
  type NotebookPresetId,
} from '@/types/shortcuts'

const STORAGE_KEY = 'linkr-shortcuts'

/** Only customized bindings are persisted */
type PersistedShortcuts = Partial<Record<ShortcutActionId, KeyCombo>>

function loadPersisted(): PersistedShortcuts {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function savePersisted(custom: PersistedShortcuts): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(custom))
}

function buildShortcuts(
  custom: PersistedShortcuts
): Record<ShortcutActionId, ShortcutDefinition> {
  const result = {} as Record<ShortcutActionId, ShortcutDefinition>
  for (const [id, def] of Object.entries(DEFAULT_SHORTCUTS)) {
    const actionId = id as ShortcutActionId
    result[actionId] = {
      ...def,
      binding: custom[actionId] ?? def.defaultBinding,
    }
  }
  return result
}

function combosEqual(a: KeyCombo, b: KeyCombo): boolean {
  return (
    a.key.toLowerCase() === b.key.toLowerCase() &&
    a.ctrlOrMeta === b.ctrlOrMeta &&
    a.shift === b.shift &&
    a.alt === b.alt
  )
}

interface ShortcutState {
  shortcuts: Record<ShortcutActionId, ShortcutDefinition>
  customBindings: PersistedShortcuts

  setBinding: (id: ShortcutActionId, binding: KeyCombo) => void
  resetBinding: (id: ShortcutActionId) => void
  resetAll: () => void
  getBinding: (id: ShortcutActionId) => KeyCombo
  findConflict: (
    binding: KeyCombo,
    excludeId?: ShortcutActionId
  ) => ShortcutActionId | null
  isCustomized: (id: ShortcutActionId) => boolean
  applyPreset: (presetId: NotebookPresetId, prefix: 'rmd' | 'ipynb') => void
  getActivePreset: (prefix: 'rmd' | 'ipynb') => NotebookPresetId | null
}

const initialCustom = loadPersisted()

export const useShortcutStore = create<ShortcutState>((set, get) => ({
  shortcuts: buildShortcuts(initialCustom),
  customBindings: initialCustom,

  setBinding: (id, binding) => {
    const custom = { ...get().customBindings, [id]: binding }
    savePersisted(custom)
    set({ shortcuts: buildShortcuts(custom), customBindings: custom })
  },

  resetBinding: (id) => {
    const custom = { ...get().customBindings }
    delete custom[id]
    savePersisted(custom)
    set({ shortcuts: buildShortcuts(custom), customBindings: custom })
  },

  resetAll: () => {
    savePersisted({})
    set({ shortcuts: buildShortcuts({}), customBindings: {} })
  },

  getBinding: (id) => get().shortcuts[id].binding,

  findConflict: (binding, excludeId) => {
    if (!binding.key) return null // unbound
    for (const [id, def] of Object.entries(get().shortcuts)) {
      if (id === excludeId) continue
      if (!def.binding.key) continue // skip unbound
      if (combosEqual(def.binding, binding)) {
        return id as ShortcutActionId
      }
    }
    return null
  },

  isCustomized: (id) => id in get().customBindings,

  applyPreset: (presetId, prefix) => {
    const preset = NOTEBOOK_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    const custom = { ...get().customBindings }
    const actionIds = notebookActionIds(prefix)
    for (const actionId of actionIds) {
      const suffix = actionId.replace(`${prefix}_`, '')
      const presetBinding = preset.bindings[suffix]
      const defaultBinding = DEFAULT_SHORTCUTS[actionId].defaultBinding
      if (presetBinding && !combosEqual(presetBinding, defaultBinding)) {
        custom[actionId] = presetBinding
      } else {
        delete custom[actionId]
      }
    }
    savePersisted(custom)
    set({ shortcuts: buildShortcuts(custom), customBindings: custom })
  },

  getActivePreset: (prefix) => {
    const { shortcuts } = get()
    const actionIds = notebookActionIds(prefix)
    for (const preset of NOTEBOOK_PRESETS) {
      const matches = actionIds.every((actionId) => {
        const suffix = actionId.replace(`${prefix}_`, '')
        const current = shortcuts[actionId].binding
        const expected = preset.bindings[suffix]
        return expected ? combosEqual(current, expected) : true
      })
      if (matches) return preset.id
    }
    return null
  },
}))
