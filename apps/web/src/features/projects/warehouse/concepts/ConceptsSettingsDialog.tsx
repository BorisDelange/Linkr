import { useTranslation } from 'react-i18next'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'

interface ConceptsSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  statsEnabled: boolean
  onStatsEnabledChange: (value: boolean) => void
  excludeOutliers: boolean
  onExcludeOutliersChange: (value: boolean) => void
}

/** A labelled checkbox row: the label and its explanation are both clickable. */
function SettingRow({
  checked,
  onCheckedChange,
  label,
  hint,
}: {
  checked: boolean
  onCheckedChange: (value: boolean) => void
  label: string
  hint: string
}) {
  return (
    <label className="flex cursor-pointer select-none items-start gap-2.5">
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        className="mt-0.5 size-4"
      />
      <span className="space-y-0.5">
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}

/** Concepts page options, gathered out of the toolbar so it stays readable. */
export function ConceptsSettingsDialog({
  open,
  onOpenChange,
  statsEnabled,
  onStatsEnabledChange,
  excludeOutliers,
  onExcludeOutliersChange,
}: ConceptsSettingsDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{t('concepts.settings_title')}</DialogTitle>
          <DialogDescription className="text-xs">
            {t('concepts.settings_description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('concepts.settings_section_stats')}
          </p>
          <SettingRow
            checked={statsEnabled}
            onCheckedChange={onStatsEnabledChange}
            label={t('etl.profiling_compute_stats')}
            hint={t('concepts.settings_stats_hint')}
          />
          <Separator />
          <SettingRow
            checked={excludeOutliers}
            onCheckedChange={onExcludeOutliersChange}
            label={t('concepts.stats_exclude_outliers')}
            hint={t('concepts.settings_outliers_hint')}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
