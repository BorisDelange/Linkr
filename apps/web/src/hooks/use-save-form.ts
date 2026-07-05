import { useCallback, useEffect, useMemo } from 'react'

interface UseSaveFormOptions<T> {
  /** Current form values. */
  current: T
  /** Baseline to compare against (the last saved values). */
  baseline: T
  /** Persist handler; only invoked when the form is dirty. */
  onSave: () => void | Promise<void>
  /** When true, Save stays disabled even if dirty (e.g. invalid input). */
  canSave?: boolean
}

interface UseSaveFormResult {
  /** True when `current` differs from `baseline`. */
  isDirty: boolean
  /** True when the Save action should be enabled (dirty and allowed). */
  canSaveNow: boolean
  /** Save wrapper that no-ops unless the form can be saved. */
  save: () => void
}

/**
 * Dirty-tracking + Cmd/Ctrl+S for settings-style forms. Compares `current` to
 * `baseline` by value so the Save button greys out when there's nothing to save,
 * and wires the keyboard shortcut to the same guarded save.
 */
export function useSaveForm<T>({
  current,
  baseline,
  onSave,
  canSave = true,
}: UseSaveFormOptions<T>): UseSaveFormResult {
  const isDirty = useMemo(
    () => JSON.stringify(current) !== JSON.stringify(baseline),
    [current, baseline],
  )
  const canSaveNow = isDirty && canSave

  const save = useCallback(() => {
    if (canSaveNow) void onSave()
  }, [canSaveNow, onSave])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [save])

  return { isDirty, canSaveNow, save }
}
