import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { FieldError } from '@/components/ui/field-error'
import { FieldInfo } from '@/components/ui/field-info'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionLabel } from '@/components/ui/section-label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { localized } from '@/lib/localized'
import type { DataSource } from '@/types'
import { pseudonymSettingsValid, type BirthPrecision, type KeyedDerivation, type PseudonymSettings } from './pseudonym-settings'

/**
 * How the ids are replaced, and how precise the birth dates stay. The CNIL
 * health-data-warehouse referential asks each project space for pseudonyms of
 * its own, drawn by a keyed hash or a secure random generator (SEC-PSE-1,
 * SEC-ESP-2), and keeps the correspondence apart from the data (5.8).
 */
const NONE = '__none__'

export function DerivePseudonymTab({
  settings,
  onChange,
  birthPrecision,
  onBirthPrecisionChange,
  idColumns,
  unprovenTables,
  correspondenceTargets,
  keyedDerivations,
}: {
  settings: PseudonymSettings
  onChange: (next: PseudonymSettings) => void
  birthPrecision: BirthPrecision
  onBirthPrecisionChange: (precision: BirthPrecision) => void
  /** The id columns the copied tables carry. */
  idColumns: string[]
  /** The tables copied whole on the user's opt-in: no id of theirs is replaced. */
  unprovenTables: string[]
  /** Databases Linkr may write the correspondence into: never the derived one. */
  correspondenceTargets: DataSource[]
  keyedDerivations: KeyedDerivation[]
}) {
  const { t, i18n } = useTranslation()
  const set = (patch: Partial<PseudonymSettings>) => onChange({ ...settings, ...patch })
  const s = settings
  const lost = s.enabled && !s.correspondenceId && (s.method === 'random' || !s.keepKey)

  return (
    <>
      <div className="flex items-center gap-2">
        <Checkbox id="derive-pseudonymize" checked={s.enabled} onCheckedChange={(v) => set({ enabled: v === true })} />
        <Label htmlFor="derive-pseudonymize">
          {t('cohort_derive.pseudonymize')}
          <FieldInfo text={t('cohort_derive.pseudonymize_hint')} />
        </Label>
      </div>

      {s.enabled && (
        <>
          {unprovenTables.length > 0 && (
            <p className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-warning-foreground">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
              {t('cohort_derive.pseudonym_unproven_warning', { tables: unprovenTables.join(', ') })}
            </p>
          )}
          <div className="space-y-1">
            <SectionLabel>{t('cohort_derive.pseudonymized_columns')}</SectionLabel>
            <p className="font-mono text-xs">
              {idColumns.length ? idColumns.join(', ') : <span className="font-sans text-muted-foreground">{t('cohort_derive.pseudonymized_none')}</span>}
            </p>
            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
              {t('cohort_derive.pseudonymize_free_text')}
            </p>
          </div>

          <FormField label={t('cohort_derive.method')} hint={t(`cohort_derive.method_${s.method}_hint`)} hintInTooltip>
            {({ id }) => (
              <Select value={s.method} onValueChange={(v) => set({ method: v as PseudonymSettings['method'], ...(v === 'random' ? { reuseKeyOf: '' } : {}) })}>
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hmac">{t('cohort_derive.method_hmac')}</SelectItem>
                  <SelectItem value="random">{t('cohort_derive.method_random')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>

          {s.method === 'hmac' && (
            <>
              <div className="flex items-center gap-2">
                <Checkbox id="derive-keep-key" checked={s.keepKey} onCheckedChange={(v) => set({ keepKey: v === true })} />
                <Label htmlFor="derive-keep-key">
                  {t('cohort_derive.keep_key')}
                  <FieldInfo text={t('cohort_derive.keep_key_hint')} />
                </Label>
              </div>
              <FormField label={t('cohort_derive.reuse_key')} hint={t('cohort_derive.reuse_key_hint')} hintInTooltip>
                {({ id }) => (
                  <Select value={s.reuseKeyOf || NONE} onValueChange={(v) => set({ reuseKeyOf: v === NONE ? '' : v })}>
                    <SelectTrigger id={id}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t('cohort_derive.reuse_key_none')}</SelectItem>
                      {keyedDerivations.map((d) => (
                        <SelectItem key={d.derivationId} value={d.derivationId}>
                          {t('cohort_derive.reuse_key_of', { name: d.label })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            </>
          )}

          <FormField label={t('cohort_derive.correspondence')} hint={t('cohort_derive.correspondence_hint')} hintInTooltip>
            {({ id }) => (
              <Select value={s.correspondenceId || NONE} onValueChange={(v) => set({ correspondenceId: v === NONE ? '' : v })}>
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('cohort_derive.correspondence_none')}</SelectItem>
                  {correspondenceTargets.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{localized(d.name, i18n.language)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          {s.correspondenceId && (
            <div className="grid grid-cols-2 gap-2">
              <FormField label={t('cohort_derive.correspondence_schema')}>
                {({ id }) => (
                  <Input id={id} className="font-mono text-xs" value={s.correspondenceSchema} onChange={(e) => set({ correspondenceSchema: e.target.value })} />
                )}
              </FormField>
              <FormField label={t('cohort_derive.correspondence_table')}>
                {({ id }) => (
                  <Input id={id} className="font-mono text-xs" value={s.correspondenceTable} onChange={(e) => set({ correspondenceTable: e.target.value })} />
                )}
              </FormField>
            </div>
          )}
          <FieldError message={pseudonymSettingsValid(s) ? null : t('cohort_derive.schema_name_invalid')} />
          {lost && (
            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
              {s.method === 'random' ? t('cohort_derive.lost_random') : t('cohort_derive.lost_key')}
            </p>
          )}
        </>
      )}

      <FormField label={t('cohort_derive.birth_precision')} hint={t('cohort_derive.birth_precision_hint')} hintInTooltip>
        {({ id }) => (
          <Select value={birthPrecision} onValueChange={(v) => onBirthPrecisionChange(v as BirthPrecision)}>
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="year">{t('cohort_derive.birth_year')}</SelectItem>
              <SelectItem value="month">{t('cohort_derive.birth_month')}</SelectItem>
              <SelectItem value="day">{t('cohort_derive.birth_day')}</SelectItem>
            </SelectContent>
          </Select>
        )}
      </FormField>
    </>
  )
}
