import { useTranslation } from 'react-i18next'
import { Download, ExternalLink, Library, RefreshCw, Repeat } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

interface ConceptsSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  statsEnabled: boolean
  onStatsEnabledChange: (value: boolean) => void
  excludeOutliers: boolean
  onExcludeOutliersChange: (value: boolean) => void
  /** The dictionary currently loaded in this workspace, if any. The page holds
   *  exactly one at a time, so this is null or the whole story. */
  dictionary: ImportedDictionary | null
  onImportDictionary: () => void
  onReplaceDictionary: () => void
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

/** Identity of the imported dictionary, derived from the concept sets it made. */
export interface ImportedDictionary {
  name: string
  sourceRepo?: string
  /** How many concept sets it contributed. */
  count: number
  importedAt: string
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
  dictionary,
  onImportDictionary,
  onReplaceDictionary,
}: ConceptsSettingsDialogProps) {
  const { t, i18n } = useTranslation()
  const repoUrl = repoHref(dictionary?.sourceRepo)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('concepts.settings_title')}</DialogTitle>
          <DialogDescription>{t('concepts.settings_description')}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="general">
          <TabsList className="w-full">
            <TabsTrigger value="general" className="flex-1">
              {t('concepts.settings_tab_general')}
            </TabsTrigger>
            <TabsTrigger value="dictionary" className="flex-1">
              {t('concepts.settings_section_dictionary')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-5 pt-3">
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
          </TabsContent>

          <TabsContent value="dictionary" className="space-y-5 pt-3">
            <p className="text-[11px] text-muted-foreground">
              {t('concepts.settings_dictionary_hint')}
            </p>

            {dictionary ? (
              <>
                <div className="rounded-md border p-2.5">
                  <div className="flex items-center gap-2">
                    <Library size={13} className="shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs font-medium">{dictionary.name}</span>
                    <Badge variant="secondary" className="ml-auto shrink-0">
                      {t('concepts.dictionary_imported')}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {t('concepts.dictionary_summary', {
                      count: dictionary.count,
                      date: new Date(dictionary.importedAt).toLocaleDateString(i18n.language),
                    })}
                  </p>
                  {dictionary.sourceRepo &&
                    (repoUrl ? (
                      <a
                        href={repoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                      >
                        <span className="truncate">{dictionary.sourceRepo}</span>
                        <ExternalLink size={10} className="shrink-0" />
                      </a>
                    ) : (
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {dictionary.sourceRepo}
                      </p>
                    ))}
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={onImportDictionary}
                  >
                    <RefreshCw size={12} />
                    {t('concepts.dictionary_update')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={onReplaceDictionary}
                  >
                    <Repeat size={12} />
                    {t('concepts.dictionary_replace')}
                  </Button>
                </div>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={onImportDictionary}
              >
                <Download size={12} />
                {t('concepts.settings_import_dictionary')}
              </Button>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
