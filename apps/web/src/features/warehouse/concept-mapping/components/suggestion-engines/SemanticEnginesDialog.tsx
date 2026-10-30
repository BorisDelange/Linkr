import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cpu, Download, FolderOpen, Hammer, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { DialogShell } from '@/components/ui/dialog-shell'
import { GatedButton } from '@/components/ui/gated-button'
import { Input } from '@/components/ui/input'
import { SectionLabel } from '@/components/ui/section-label'
import { ServerPathPickerDialog } from '@/components/ui/server-path-picker-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { formatMegabytes } from '@/lib/concept-mapping/scores-csv'
import {
  addEmbeddingModel, buildEmbeddingIndex, deleteEmbeddingConfig, deleteEmbeddingModel, downloadEmbeddingModel,
  installEmbeddingsRuntime, setupDefaultEngine,
  type EmbeddingConfig, type EmbeddingModel, type SuggestionEngines,
} from '@/lib/api/suggestion-engines'
import { EmbeddingConfigDialog } from './EmbeddingConfigDialog'
import { JobLine } from './JobLine'
import { jobError, useJob } from './use-job'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  engines: SuggestionEngines
  canWrite: boolean
  reload: () => void
}

/**
 * What the semantic method needs: embedding models and configurations of the
 * workspace, shared by all its mapping projects, and the runtime they run on,
 * shared by the whole instance. Opened from the Compute tab.
 */
export function SemanticEnginesDialog({ open, onOpenChange, workspaceId, engines, canWrite, reload }: Props) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const [setupJobId, setSetupJobId] = useState<string | null>(null)
  const [runtimeJobId, setRuntimeJobId] = useState<string | null>(null)
  const setupJob = useJob(setupJobId ?? engines.setupJobId, (j) => { setError(jobError(j)); reload() })
  const runtimeJob = useJob(runtimeJobId ?? engines.runtime.jobId, (j) => { setError(jobError(j)); reload() })
  const [editing, setEditing] = useState<EmbeddingConfig | 'new' | null>(null)
  const notAllowed = t('concept_mapping.engines_not_allowed')

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const probe = engines.runtime.probe

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="settings"
      title={t('concept_mapping.engines_manage')}
      description={t('concept_mapping.engines_dialog_desc')}
      hideFooter
      contentClassName="space-y-6"
    >
      {error && <p className="whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{error}</p>}

      {engines.models.length === 0 && (
        <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3">
          <Sparkles size={16} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">{t('concept_mapping.engines_default_title')}</p>
            <p className="text-xs text-muted-foreground">{t('concept_mapping.engines_default_desc', { repo: engines.defaultModel.repoId })}</p>
            {setupJob && setupJob.status !== 'done' && <JobLine job={setupJob} />}
          </div>
          {!setupJob && (
            <GatedButton
              allowed={canWrite}
              notAllowedReason={notAllowed}
              size="sm"
              className="gap-1.5"
              onClick={() => act(async () => setSetupJobId((await setupDefaultEngine(workspaceId)).id))}
            >
              <Download size={14} />
              {t('concept_mapping.engines_default_install')}
            </GatedButton>
          )}
        </div>
      )}

      <section className="space-y-2">
        <SectionLabel as="h3" info={t('concept_mapping.engines_runtime_hint')}>{t('concept_mapping.engines_runtime')}</SectionLabel>
        <div className="flex items-center gap-3 text-xs">
          <Cpu size={14} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            {engines.runtime.installed && probe ? (
              <span>
                {t('concept_mapping.engines_runtime_ready', { torch: probe.torch, st: probe.sentenceTransformers })}
                {' · '}
                {probe.gpu ?? probe.devices.map((d) => d.toUpperCase()).join(', ')}
              </span>
            ) : (
              <span className="text-muted-foreground">{t('concept_mapping.engines_runtime_missing')}</span>
            )}
          </div>
          {!runtimeJob && (
            <GatedButton
              allowed={canWrite}
              notAllowedReason={notAllowed}
              size="xs"
              variant="outline"
              onClick={() => act(async () => setRuntimeJobId((await installEmbeddingsRuntime(workspaceId)).id))}
            >
              {engines.runtime.installed ? t('concept_mapping.engines_runtime_reinstall') : t('concept_mapping.engines_runtime_install')}
            </GatedButton>
          )}
        </div>
        {runtimeJob && runtimeJob.status !== 'done' && <JobLine job={runtimeJob} />}
      </section>

      <ModelsSection workspaceId={workspaceId} engines={engines} canWrite={canWrite} act={act} reload={reload} onError={setError} />

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <SectionLabel as="h3" info={t('concept_mapping.engines_configs_info')}>{t('concept_mapping.engines_configs')}</SectionLabel>
          <GatedButton
            allowed={canWrite && engines.models.length > 0}
            notAllowedReason={canWrite ? t('concept_mapping.engines_config_needs_model') : notAllowed}
            size="xs"
            variant="outline"
            className="gap-1"
            onClick={() => setEditing('new')}
          >
            <Plus size={12} />
            {t('concept_mapping.engines_config_new')}
          </GatedButton>
        </div>
        {engines.configs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('concept_mapping.engines_configs_empty')}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {engines.configs.map((c) => (
              <ConfigRow
                key={c.id}
                workspaceId={workspaceId}
                config={c}
                model={engines.models.find((m) => m.id === c.modelId)}
                runtimeReady={engines.runtime.installed}
                canWrite={canWrite}
                act={act}
                reload={reload}
                onError={setError}
                onEdit={() => setEditing(c)}
              />
            ))}
          </ul>
        )}
      </section>

      {editing && (
        <EmbeddingConfigDialog
          open
          onOpenChange={(o) => { if (!o) setEditing(null) }}
          workspaceId={workspaceId}
          models={engines.models}
          vocabularies={engines.vocabularies}
          conceptClasses={engines.conceptClasses}
          config={editing === 'new' ? null : editing}
          onSaved={reload}
        />
      )}
    </DialogShell>
  )
}

type Act = (fn: () => Promise<unknown>) => Promise<void>

function ModelsSection({ workspaceId, engines, canWrite, act, reload, onError }: {
  workspaceId: string
  engines: SuggestionEngines
  canWrite: boolean
  act: Act
  reload: () => void
  onError: (e: string | null) => void
}) {
  const { t } = useTranslation()
  const [repoId, setRepoId] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [toDelete, setToDelete] = useState<EmbeddingModel | null>(null)
  const notAllowed = t('concept_mapping.engines_not_allowed')

  return (
    <section className="space-y-2">
      <SectionLabel as="h3" info={t('concept_mapping.engines_models_hint')}>{t('concept_mapping.engines_models')}</SectionLabel>
      {engines.models.length > 0 && (
        <ul className="divide-y rounded-md border">
          {engines.models.map((m) => (
            <ModelRow
              key={m.id}
              workspaceId={workspaceId}
              model={m}
              runtimeReady={engines.runtime.installed}
              canWrite={canWrite}
              act={act}
              reload={reload}
              onError={onError}
              onDelete={() => setToDelete(m)}
            />
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input
          className="h-8 flex-1 font-mono text-xs"
          placeholder={t('concept_mapping.engines_model_hf_placeholder')}
          value={repoId}
          disabled={!canWrite}
          onChange={(e) => setRepoId(e.target.value)}
        />
        <GatedButton
          allowed={canWrite && engines.runtime.installed}
          notAllowedReason={canWrite ? t('concept_mapping.engines_needs_runtime') : notAllowed}
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={!/^[\w.-]+\/[\w.-]+$/.test(repoId.trim())}
          onClick={() => act(async () => {
            await addEmbeddingModel(workspaceId, { source: 'huggingface', repoId: repoId.trim() })
            setRepoId('')
          })}
        >
          <Download size={14} />
          {t('concept_mapping.engines_model_download')}
        </GatedButton>
        <GatedButton
          allowed={canWrite}
          notAllowedReason={notAllowed}
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => setPickerOpen(true)}
        >
          <FolderOpen size={14} />
          {t('concept_mapping.engines_model_server')}
        </GatedButton>
      </div>
      {pickerOpen && (
        <ServerPathPickerDialog
          open
          mode="folder"
          scope={{ kind: 'workspace', workspaceId }}
          title={t('concept_mapping.engines_model_server')}
          onClose={() => setPickerOpen(false)}
          onPick={(path) => {
            setPickerOpen(false)
            void act(() => addEmbeddingModel(workspaceId, { source: 'server', serverPath: path }))
          }}
        />
      )}
      <AlertDialog open={!!toDelete} onOpenChange={(o) => { if (!o) setToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.engines_model_delete_title', { name: toDelete?.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {toDelete?.source === 'server'
                ? t('concept_mapping.engines_model_delete_server')
                : t('concept_mapping.engines_model_delete_desc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => { const m = toDelete; setToDelete(null); if (m) void act(() => deleteEmbeddingModel(workspaceId, m.id)) }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function ModelRow({ workspaceId, model, runtimeReady, canWrite, act, reload, onError, onDelete }: {
  workspaceId: string
  model: EmbeddingModel
  runtimeReady: boolean
  canWrite: boolean
  act: Act
  reload: () => void
  onError: (e: string | null) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useJob(jobId ?? model.jobId, (j) => { onError(jobError(j)); setJobId(null); reload() })
  return (
    <li className="space-y-1 px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">{model.name}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground" title={model.repoId ?? model.serverPath}>
          {model.repoId ?? model.serverPath}
        </code>
        {model.dimension && <span className="text-[10px] text-muted-foreground">{t('concept_mapping.engines_model_dim', { dim: model.dimension })}</span>}
        {model.sizeBytes ? <span className="font-mono text-[10px] text-muted-foreground">{formatMegabytes(model.sizeBytes)}</span> : null}
        {model.ready
          ? <Badge variant="secondary">{t('concept_mapping.engines_model_ready')}</Badge>
          : !job && (
            <GatedButton
              allowed={canWrite && runtimeReady}
              notAllowedReason={canWrite ? t('concept_mapping.engines_needs_runtime') : t('concept_mapping.engines_not_allowed')}
              size="xs"
              variant="outline"
              onClick={() => act(async () => setJobId((await downloadEmbeddingModel(workspaceId, model.id)).id))}
            >
              {t('concept_mapping.engines_model_download')}
            </GatedButton>
          )}
        <GatedButton
          allowed={canWrite}
          notAllowedReason={t('concept_mapping.engines_not_allowed')}
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          aria-label={t('common.delete')}
          disabled={!!job}
          onClick={onDelete}
        >
          <Trash2 size={12} />
        </GatedButton>
      </div>
      {job && job.status !== 'done' && <JobLine job={job} />}
    </li>
  )
}

function indexSummary(config: EmbeddingConfig) {
  const built = config.index.filter((s) => s.status === 'built')
  const stale = config.index.filter((s) => s.status === 'stale')
  const missing = config.index.filter((s) => s.status === 'missing')
  const concepts = config.index.reduce((n, s) => n + (s.status !== 'missing' ? s.count ?? 0 : 0), 0)
  return { built, stale, missing, concepts }
}

/** Names shown per status in the index tooltip; the rest are counted. */
const TOOLTIP_VOCABULARIES = 12

/** One line per status — "not built (129): ABMS, AMT, … +117 more" — so a long library stays readable. */
function indexTooltip(config: EmbeddingConfig, t: (key: string, options?: Record<string, unknown>) => string): string {
  return (['built', 'stale', 'missing'] as const).flatMap((status) => {
    const names = config.index.filter((s) => s.status === status).map((s) => s.vocabularyId)
    if (names.length === 0) return []
    const shown = names.slice(0, TOOLTIP_VOCABULARIES).join(', ')
    const more = names.length > TOOLTIP_VOCABULARIES
      ? ` ${t('concept_mapping.engines_index_more', { count: names.length - TOOLTIP_VOCABULARIES })}` : ''
    return [`${t(`concept_mapping.engines_index_status_${status}`)} (${names.length}): ${shown}${more}`]
  }).join('\n')
}

function ConfigRow({ workspaceId, config, model, runtimeReady, canWrite, act, reload, onError, onEdit }: {
  workspaceId: string
  config: EmbeddingConfig
  model: EmbeddingModel | undefined
  runtimeReady: boolean
  canWrite: boolean
  act: Act
  reload: () => void
  onError: (e: string | null) => void
  onEdit: () => void
}) {
  const { t } = useTranslation()
  const [jobId, setJobId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const job = useJob(jobId ?? config.jobId, (j) => { onError(jobError(j)); setJobId(null); reload() })
  const { built, stale, missing, concepts } = indexSummary(config)
  const upToDate = config.index.length > 0 && stale.length === 0 && missing.length === 0
  const canBuild = canWrite && runtimeReady && !!model?.ready
  const blocker = !canWrite
    ? t('concept_mapping.engines_not_allowed')
    : !runtimeReady ? t('concept_mapping.engines_needs_runtime') : t('concept_mapping.engines_needs_model')
  const scope = [
    config.filters.onlyStandard && t('concept_mapping.engines_scope_standard'),
    config.filters.onlyValid && t('concept_mapping.engines_scope_valid'),
    config.filters.domains.length ? config.filters.domains.join(', ') : t('concept_mapping.engines_scope_all_domains'),
  ].filter(Boolean).join(' · ')

  return (
    <li className="space-y-1.5 px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">{config.name}</span>
        <code className="font-mono text-[10px] text-muted-foreground">{config.method}</code>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{model?.name ?? '—'}</span>
        <GatedButton allowed={canWrite} notAllowedReason={t('concept_mapping.engines_not_allowed')} size="icon-xs" variant="ghost" aria-label={t('common.edit')} disabled={!!job} onClick={onEdit}>
          <Pencil size={12} />
        </GatedButton>
        <GatedButton
          allowed={canWrite}
          notAllowedReason={t('concept_mapping.engines_not_allowed')}
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          aria-label={t('common.delete')}
          disabled={!!job}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 size={12} />
        </GatedButton>
      </div>
      <p className="truncate text-[10px] text-muted-foreground">{scope}</p>
      <div className="flex items-center gap-2 text-[10px]">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={upToDate ? 'text-foreground' : 'text-warning-foreground'}>
              {config.index.length === 0
                ? t('concept_mapping.engines_index_no_vocab')
                : t('concept_mapping.engines_index_summary', {
                  built: built.length, total: config.index.length, concepts: concepts.toLocaleString(),
                })}
              {stale.length > 0 && ` · ${t('concept_mapping.engines_index_stale', { count: stale.length })}`}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm whitespace-pre-line">
            {indexTooltip(config, t) || '—'}
          </TooltipContent>
        </Tooltip>
        <span className="flex-1" />
        {!job && config.index.length > 0 && (
          <GatedButton
            allowed={canBuild}
            notAllowedReason={blocker}
            size="xs"
            variant={upToDate ? 'ghost' : 'outline'}
            className="gap-1"
            onClick={() => act(async () => setJobId((await buildEmbeddingIndex(workspaceId, config.id, upToDate)).id))}
          >
            <Hammer size={12} />
            {upToDate ? t('concept_mapping.engines_index_rebuild') : t('concept_mapping.engines_index_build')}
          </GatedButton>
        )}
      </div>
      {job && job.status !== 'done' && <JobLine job={job} />}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.engines_config_delete_title', { name: config.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t('concept_mapping.engines_config_delete_desc', { method: config.method })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void act(() => deleteEmbeddingConfig(workspaceId, config.id))}>
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}
