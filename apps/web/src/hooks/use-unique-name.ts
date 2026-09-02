import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { isNameTaken } from '@/lib/unique-name'
import { localized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import type { LocalizedString } from '@/types'

interface UseUniqueNameOptions<T extends { id: string; name: LocalizedString | string }> {
  /** The name being typed. */
  name: string
  /** Every entity the name must be unique among — already narrowed to its scope. */
  siblings: T[]
  /** The entity being renamed, so it does not report itself as its own twin. */
  exceptId?: string
  /** i18n key of the message shown on a collision. */
  errorKey: string
}

/**
 * Whether `name` is already taken among `siblings`, ignoring `exceptId`.
 *
 * Split out of the hook so the rule is testable without rendering: the hook
 * only supplies the active language and the translated message.
 */
export function nameCollides<T extends { id: string; name: LocalizedString | string }>(
  name: string,
  siblings: T[],
  language: string,
  exceptId?: string,
): boolean {
  return isNameTaken(
    name,
    siblings.filter((s) => s.id !== exceptId).map((s) => localized(s.name, language)),
  )
}

/**
 * Live duplicate-name check for a create/rename form.
 *
 * Names are compared in the ACTIVE language: that is the string the user typed
 * and the one the list shows them, so a clash in another translation is not a
 * clash on the screen they are looking at.
 *
 * Exists because create and rename are separate dialogs for dashboards and
 * patient boards, and only the create half validated — so a name refused at
 * creation could be reached by renaming, which is how twins appeared anyway.
 * Both halves now call this.
 */
export function useUniqueName<T extends { id: string; name: LocalizedString | string }>({
  name,
  siblings,
  exceptId,
  errorKey,
}: UseUniqueNameOptions<T>) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)

  const nameError = useMemo(
    () => (nameCollides(name, siblings, language, exceptId) ? t(errorKey) : null),
    [name, siblings, exceptId, language, t, errorKey],
  )

  return { nameError, canSubmit: name.trim().length > 0 && !nameError }
}
