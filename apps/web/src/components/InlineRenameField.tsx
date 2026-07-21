import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface InlineRenameFieldProps {
  /** Initial value; the field manages its own draft from here. */
  initialValue: string
  /** Called with the trimmed new name on confirm (only if changed + valid). */
  onSubmit: (value: string) => void
  onCancel: () => void
  /** Optional clash check: return true if `candidate` collides with a sibling. */
  hasClash?: (candidate: string) => boolean
  /** For files: select only the base name (before the last dot) on focus. */
  selectBaseName?: boolean
  className?: string
}

/**
 * Inline rename input matching the IDE file-tree UX: auto-focus with the text
 * selected (base name for files), Enter to confirm, Escape to cancel, plus
 * cancel (✕) and confirm (✓) icon buttons. Reused by dataset analyses + the
 * dataset file tree so all three renames behave identically.
 */
export function InlineRenameField({
  initialValue,
  onSubmit,
  onCancel,
  hasClash,
  selectBaseName,
  className,
}: InlineRenameFieldProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  const trimmed = value.trim()
  const clashes = !!trimmed && trimmed.toLowerCase() !== initialValue.toLowerCase() && !!hasClash?.(trimmed)
  const canSubmit = !!trimmed && !clashes

  const submit = () => {
    if (!canSubmit) return
    if (trimmed !== initialValue) onSubmit(trimmed)
    else onCancel()
  }

  useEffect(() => {
    // A context menu / double-click restores focus a frame or two later and would
    // steal it from the input (clearing the selection). Poll a few frames until
    // focus settles on our input, then select (base name for files).
    let tries = 0
    let raf = 0
    const applySelection = (el: HTMLInputElement) => {
      const dot = initialValue.lastIndexOf('.')
      if (selectBaseName && dot > 0) el.setSelectionRange(0, dot)
      else el.select()
    }
    const tick = () => {
      const el = inputRef.current
      if (el) {
        if (document.activeElement !== el) el.focus()
        if (document.activeElement === el) { applySelection(el); return }
      }
      if (tries++ < 10) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [initialValue, selectBaseName])

  return (
    <span
      className={cn(
        'flex min-w-0 flex-1 items-center gap-0.5 rounded border bg-background pr-0.5',
        clashes ? 'border-destructive' : 'border-primary',
        className,
      )}
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        title={clashes ? t('files.name_exists', { name: trimmed }) : undefined}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') submit()
          else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        }}
        className="w-0 min-w-0 flex-1 bg-transparent px-1 text-xs outline-none"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={t('common.cancel')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.stopPropagation(); onCancel() }}
        className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
      >
        <X size={11} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        disabled={!canSubmit}
        aria-label={t('common.save')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.stopPropagation(); submit() }}
        className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-green-600 disabled:pointer-events-none disabled:opacity-40"
      >
        <Check size={11} />
      </button>
    </span>
  )
}
