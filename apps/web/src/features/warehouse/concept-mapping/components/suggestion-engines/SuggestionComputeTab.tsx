import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, RotateCcw, Settings2 } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { FormField } from '@/components/ui/form-field'
import { GatedButton } from '@/components/ui/gated-button'
import { Label } from '@/components/ui/label'
import { NumberInput } from '@/components/ui/number-input'
import { SectionLabel } from '@/components/ui/section-label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { METHOD_LABELS } from '@/lib/concept-mapping/syntactic-suggestions'
import {
  computeSuggestionScores, getScoresCompute, pauseScoresCompute, resumeScoresCompute, SYNTACTIC_METHODS,
  type PausedScores, type SuggestionEngines, type TargetFilters,
} from '@/lib/api/suggestion-engines'
import { JobLine } from './JobLine'
import { SemanticEnginesDialog } from './SemanticEnginesDialog'
import { jobError, useJob } from './use-job'
import { TargetScopeFields } from './TargetScopeFields'

const NONE = '__none__'

interface Props {
  projectId: string
  workspaceId: string
  engines: SuggestionEngines
  canWrite: boolean
  /** May install the runtime, add models, edit configurations (workspace-wide). */
  canManageEngines: boolean
  /** Called once a run ends, to reload the project's scores index. */
  onComputed: () => void
  reloadEngines: () => void
}

/** Compute a project's precomputed suggestions: syntactic methods and/or one semantic configuration. */
export function SuggestionComputeTab({ projectId, workspaceId, engines, canWrite, canManageEngines, onComputed, reloadEngines }: Props) {
  const { t, i18n } = useTranslation()
  const [enginesOpen, setEnginesOpen] = useState(false)
  const [paused, setPaused] = useState<PausedScores | null>(null)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [methods, setMethods] = useState<string[]>(['syntactic/jaro-winkler'])
  const usable = engines.configs.filter((c) => c.index.some((s) => s.status !== 'missing' && (s.count ?? 0) > 0))
  const [configId, setConfigId] = useState<string>(usable[0]?.id ?? NONE)
  const [filters, setFilters] = useState<TargetFilters>({ onlyStandard: true, onlyValid: true, domains: [], vocabularies: [], conceptClasses: [] })
  const [topK, setTopK] = useState(20)
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const job = useJob(jobId, (j) => {
    setJobId(null)
    setError(jobError(j))
    if (j.status === 'done') {
      const rows = (j.result ?? {}) as Record<string, number>
      setSummary(Object.entries(rows).map(([m, n]) => `${m}: ${n.toLocaleString()}`).join(' · ') || t('concept_mapping.engines_compute_nothing'))
    }
    // A paused run wrote what it had finished, too.
    if (j.status !== 'error') onComputed()
    getScoresCompute(projectId).then((s) => setPaused(s.paused)).catch(() => {})
  })
  useEffect(() => {
    let live = true
    getScoresCompute(projectId).then((s) => {
      if (!live) return
      setPaused(s.paused)
      if (s.jobId) setJobId(s.jobId)
    }).catch(() => {})
    return () => { live = false }
  }, [projectId])
  const semantic = configId !== NONE ? engines.configs.find((c) => c.id === configId) : undefined
  const ready = methods.length > 0 || !!semantic

  const launch = async (run: () => Promise<{ id: string }>) => {
    setError(null)
    setSummary(null)
    try {
      setJobId((await run()).id)
      setPaused(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const start = () => launch(() => computeSuggestionScores(projectId, {
    methods, configId: semantic?.id ?? null, filters, topK, onlyMissing,
  }))

  const toggle = (method: string, on: boolean) =>
    setMethods((m) => (on ? [...m, method] : m.filter((x) => x !== method)))

  return (
    <div className="space-y-5 p-4">
      <section className="space-y-2">
        <SectionLabel as="h3" info={t('concept_mapping.engines_compute_syntactic_info')}>
          {t('concept_mapping.engines_compute_syntactic')}
        </SectionLabel>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {SYNTACTIC_METHODS.map((m) => (
            <div key={m} className="flex items-center gap-2">
              <Checkbox id={`method-${m}`} checked={methods.includes(m)} onCheckedChange={(v) => toggle(m, v === true)} />
              <Label htmlFor={`method-${m}`}>{METHOD_LABELS[m] ?? m}</Label>
            </div>
          ))}
        </div>
        {methods.includes('syntactic/ngram-idf') && (
          <p className="text-xs text-warning-foreground">{t('concept_mapping.engines_compute_ngram_slow')}</p>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <SectionLabel as="h3" info={t('concept_mapping.engines_compute_semantic_info')}>
            {t('concept_mapping.engines_compute_semantic')}
          </SectionLabel>
          <Button size="xs" variant="outline" className="gap-1" onClick={() => setEnginesOpen(true)}>
            <Settings2 size={12} />
            {t('concept_mapping.engines_manage')}
          </Button>
        </div>
        {engines.configs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('concept_mapping.engines_compute_no_config')}</p>
        ) : (
          <Select value={configId} onValueChange={setConfigId}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('concept_mapping.engines_compute_no_semantic')}</SelectItem>
              {engines.configs.map((c) => {
                const hasIndex = usable.includes(c)
                return (
                  <SelectItem key={c.id} value={c.id} disabled={!hasIndex}>
                    {c.name} <span className="font-mono text-muted-foreground">({c.method})</span>
                    {!hasIndex && ` — ${t('concept_mapping.engines_compute_no_index')}`}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        )}
        {semantic && !engines.runtime.installed && (
          <p className="text-xs text-warning-foreground">{t('concept_mapping.engines_needs_runtime')}</p>
        )}
      </section>

      <section className="space-y-2">
        <SectionLabel as="h3" info={t('concept_mapping.engines_compute_targets_hint')}>
          {t('concept_mapping.engines_compute_targets')}
        </SectionLabel>
        <TargetScopeFields value={filters} onChange={setFilters} vocabularies={engines.vocabularies} conceptClasses={engines.conceptClasses} allLabel={t('concept_mapping.engines_all')} />
      </section>

      <section className="grid grid-cols-2 items-end gap-3">
        <FormField label={t('concept_mapping.engines_compute_topk')} hint={t('concept_mapping.engines_compute_topk_hint')} hintInTooltip>
          {({ id }) => <NumberInput id={id} value={topK} onValueChange={setTopK} min={1} max={200} integer />}
        </FormField>
        <div className="flex h-8 items-center gap-2">
          <Checkbox id="only-missing" checked={onlyMissing} onCheckedChange={(v) => setOnlyMissing(v === true)} />
          <Label htmlFor="only-missing">{t('concept_mapping.engines_compute_only_missing')}</Label>
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        {t(onlyMissing ? 'concept_mapping.engines_compute_missing_hint' : 'concept_mapping.engines_compute_replace_hint')}
      </p>

      {job ? (
        <JobLine job={job} onPause={canWrite ? () => pauseScoresCompute(projectId) : undefined} />
      ) : paused ? (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {t('concept_mapping.engines_paused', {
              date: new Date(paused.pausedAt).toLocaleString(i18n.language),
              percent: Math.floor((100 * paused.done) / Math.max(paused.total, 1)),
            })}
          </p>
          <GatedButton
            allowed={canWrite}
            notAllowedReason={t('concept_mapping.engines_not_allowed')}
            size="sm"
            variant="ghost"
            className="gap-1.5"
            disabled={!ready || (!!semantic && !engines.runtime.installed)}
            onClick={() => setConfirmRestart(true)}
          >
            <RotateCcw size={14} />
            {t('concept_mapping.engines_restart')}
          </GatedButton>
          <GatedButton
            allowed={canWrite}
            notAllowedReason={t('concept_mapping.engines_not_allowed')}
            size="sm"
            className="gap-1.5"
            onClick={() => void launch(() => resumeScoresCompute(projectId))}
          >
            <Play size={14} />
            {t('concept_mapping.engines_resume')}
          </GatedButton>
        </div>
      ) : (
        <div className="flex justify-end">
          <GatedButton
            allowed={canWrite}
            notAllowedReason={t('concept_mapping.engines_not_allowed')}
            size="sm"
            className="gap-1.5"
            disabled={!ready || (!!semantic && !engines.runtime.installed)}
            onClick={() => void start()}
          >
            <Play size={14} />
            {t('concept_mapping.engines_compute_run')}
          </GatedButton>
        </div>
      )}
      <AlertDialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.engines_restart_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('concept_mapping.engines_restart_desc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void start()}>{t('concept_mapping.engines_restart')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {summary && <p className="text-xs text-foreground">{t('concept_mapping.engines_compute_done', { summary })}</p>}
      {error && <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p>}
      {enginesOpen && (
        <SemanticEnginesDialog
          open
          onOpenChange={setEnginesOpen}
          workspaceId={workspaceId}
          engines={engines}
          canWrite={canManageEngines}
          reload={reloadEngines}
        />
      )}
    </div>
  )
}
