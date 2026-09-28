import { useTranslation } from 'react-i18next'
import { ExternalLink, Library, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

interface ConceptsSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  statsEnabled: boolean
  onStatsEnabledChange: (value: boolean) => void
  excludeOutliers: boolean
  onExcludeOutliersChange: (value: boolean) => void
  /** The workspace's data dictionaries, managed in the workspace settings. */
  dictionaries: DictionarySummary[]
  onManageDictionaries: () => void
}

/** `sourceRepo` is whatever the dictionary author wrote in its metadata: a full
 *  URL in practice, but an `owner/repo` slug is expanded rather than dropped.
 *  Anything else stays plain text — never an href that would 404. */
export function repoHref(sourceRepo: string | undefined): string | null {
  if (!sourceRepo) return null
  if (/^https?:\/\//.test(sourceRepo)) return sourceRepo
  if (/^[\w.-]+\/[\w.-]+$/.test(sourceRepo)) return `https://github.com/${sourceRepo}`
  return null
}

export interface DictionarySummary {
  id: string
  name: string
  sourceRepo?: string
  /** How many concept sets it holds. */
  count: number
  syncedAt?: string
}

/** Label + hint on the left, switch on the right — the settings-row shape the
 *  dashboard and patient-board dialogs use. */
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
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5">
        <Label>{label}</Label>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
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
  dictionaries,
  onManageDictionaries,
}: ConceptsSettingsDialogProps) {
  const { t, i18n } = useTranslation()

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      title={t('concepts.settings_title')}
      description={t('concepts.settings_description')}
      // Every option here applies on the spot, so there is nothing to confirm.
      hideFooter
      contentClassName="space-y-0"
    >
        <Tabs defaultValue="general" className="py-2">
          <TabsList className="w-full">
            <TabsTrigger value="general" className="flex-1">
              {t('concepts.settings_tab_general')}
            </TabsTrigger>
            <TabsTrigger value="dictionary" className="flex-1">
              {t('concepts.settings_section_dictionary')}
            </TabsTrigger>
          </TabsList>

          <div className="min-h-[210px]">
          <TabsContent value="general" className="space-y-5 pt-3">
            <SettingRow
              checked={statsEnabled}
              onCheckedChange={onStatsEnabledChange}
              label={t('etl.profiling_compute_stats')}
              hint={t('concepts.settings_stats_hint')}
            />
            <SettingRow
              checked={excludeOutliers}
              onCheckedChange={onExcludeOutliersChange}
              label={t('concepts.stats_exclude_outliers')}
              hint={t('concepts.settings_outliers_hint')}
            />
          </TabsContent>

          <TabsContent value="dictionary" className="space-y-5 pt-3">
            <p className="text-[11px] text-muted-foreground">
              {t('concepts.settings_dictionary_hint')}
            </p>

            {dictionaries.map((d) => {
              const repoUrl = repoHref(d.sourceRepo)
              return (
                <div key={d.id} className="rounded-md border p-2.5">
                  <div className="flex items-center gap-2">
                    <Library size={13} className="shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs font-medium">{d.name}</span>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {d.syncedAt
                      ? t('concepts.dictionary_summary', { count: d.count, date: new Date(d.syncedAt).toLocaleDateString(i18n.language) })
                      : t('concepts.dictionary_count', { count: d.count })}
                  </p>
                  {repoUrl && (
                    <a
                      href={repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      <span className="truncate">{d.sourceRepo}</span>
                      <ExternalLink size={10} className="shrink-0" />
                    </a>
                  )}
                </div>
              )
            })}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onManageDictionaries}>
              <Settings2 size={12} />
              {t('concepts.dictionary_manage')}
            </Button>
          </TabsContent>
          </div>
        </Tabs>
    </DialogShell>
  )
}
