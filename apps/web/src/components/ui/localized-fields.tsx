import { Input } from '@/components/ui/input'
import { localizedRaw } from '@/lib/localized'
import { cn } from '@/lib/utils'
import type { LocalizedString } from '@/types'

/** The languages Linkr's own content is written in. */
export const CONTENT_LANGUAGES = ['en', 'fr'] as const

interface Props {
  /** Base id; each field gets `<id>-<lang>`. */
  id?: string
  value: LocalizedString | null | undefined
  onChange: (next: LocalizedString) => void
  /** Called when a field loses focus, with the value as it then stands. */
  onCommit?: (next: LocalizedString) => void
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  /** `row`: the languages side by side (a dense editor bar); `stack`: one under the other (a dialog). */
  layout?: 'row' | 'stack'
  size?: 'default' | 'xs'
  className?: string
}

/**
 * One input per content language, each tagged with its code, for text that
 * must exist in every language rather than only the one the UI is in.
 */
export function LocalizedFields({
  id, value, onChange, onCommit, placeholder, disabled, autoFocus, layout = 'stack', size = 'default', className,
}: Props) {
  const current = value ?? {}
  return (
    <div className={cn(layout === 'row' ? 'flex min-w-0 gap-2' : 'space-y-1.5', className)}>
      {CONTENT_LANGUAGES.map((lang, i) => (
        <div key={lang} className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="w-5 shrink-0 text-[10px] font-semibold uppercase text-muted-foreground">{lang}</span>
          <Input
            id={id ? `${id}-${lang}` : undefined}
            value={localizedRaw(current, lang)}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus && i === 0}
            onChange={(e) => onChange({ ...current, [lang]: e.target.value })}
            onBlur={(e) => onCommit?.({ ...current, [lang]: e.target.value })}
            className={cn('min-w-0', size === 'xs' && 'h-6 px-2 text-xs')}
          />
        </div>
      ))}
    </div>
  )
}

/** The value with each language trimmed and the empty ones dropped. */
export function trimLocalized(value: LocalizedString): LocalizedString {
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, (v ?? '').trim()]).filter(([, v]) => v),
  )
}
