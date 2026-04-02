import { useRef, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { slugifyId } from '@/lib/slugify-id'

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/

interface EntityIdFieldProps {
  /** Current name value to auto-generate the id from */
  name: string
  /** Controlled entityId value */
  value: string
  /** Called when the user changes the id (or it's auto-generated) */
  onChange: (value: string) => void
  /** Existing entityIds in the same scope (for duplicate check) */
  existingIds: string[]
  /** HTML id prefix for the input (default: "entity") */
  htmlId?: string
  /** Placeholder text */
  placeholder?: string
}

/**
 * Reusable entity identifier field.
 * Auto-generates a slug from the name until the user manually edits it.
 * Validates: format, length, uniqueness.
 */
export function EntityIdField({
  name,
  value,
  onChange,
  existingIds,
  htmlId = 'entity-id',
  placeholder = 'my-entity',
}: EntityIdFieldProps) {
  const { t } = useTranslation()
  const [touched, setTouched] = useState(false)

  // Auto-generate from name until user edits manually
  useEffect(() => {
    if (!touched) {
      onChange(slugifyId(name))
    }
  }, [name, touched, onChange])

  const idValid = value.length === 0 || (value.length >= 2 && value.length <= 50 && ID_PATTERN.test(value))
  const idDuplicate = value.length > 0 && existingIds.includes(value)

  return (
    <div className="space-y-2">
      <Label htmlFor={htmlId} className="flex items-center gap-1.5">
        <Lock size={12} className="text-muted-foreground" />
        {t('entity_id.label')}
      </Label>
      <IdInput
        htmlId={htmlId}
        value={value}
        onChange={(v) => { setTouched(true); onChange(v) }}
        placeholder={placeholder}
      />
      <p className="text-[11px] text-muted-foreground">
        {t('entity_id.hint')}
      </p>
      {idDuplicate && (
        <p className="text-[11px] text-destructive">{t('entity_id.duplicate')}</p>
      )}
      {!idValid && value.length > 0 && (
        <p className="text-[11px] text-destructive">{t('entity_id.invalid')}</p>
      )}
    </div>
  )
}

/** Returns true when the current entityId is valid and can be submitted. */
export function isEntityIdValid(value: string, existingIds: string[]): boolean {
  if (value.length < 2 || value.length > 50) return false
  if (!ID_PATTERN.test(value)) return false
  if (existingIds.includes(value)) return false
  return true
}

/** Reset touched state — call this via ref or re-mount when dialog opens. */
EntityIdField.reset = () => {}

// ---------------------------------------------------------------------------
// Internal IdInput — strips invalid chars while preserving cursor position
// ---------------------------------------------------------------------------

function IdInput({ htmlId, value, onChange, placeholder }: {
  htmlId: string
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  const ref = useRef<HTMLInputElement>(null)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target
    const raw = input.value.toLowerCase()
    const cleaned = raw.replace(/[^a-z0-9-]/g, '')
    const cursorBefore = input.selectionStart ?? raw.length
    const removedBefore = raw.slice(0, cursorBefore).length - raw.slice(0, cursorBefore).replace(/[^a-z0-9-]/g, '').length
    const newCursor = cursorBefore - removedBefore

    onChange(cleaned)

    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(newCursor, newCursor)
    })
  }

  return (
    <Input
      ref={ref}
      id={htmlId}
      value={value}
      onChange={handleChange}
      placeholder={placeholder}
      className="font-mono text-sm"
    />
  )
}
