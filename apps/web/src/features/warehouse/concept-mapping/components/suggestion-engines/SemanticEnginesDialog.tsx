import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cpu, Download, FolderOpen, Hammer, Loader2, Pencil, Plus, RotateCw, Sparkles, Trash2, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { DialogShell } from '@/components/ui/dialog-shell'
import { GatedButton } from '@/components/ui/gated-button'
import { useAuthStore } from '@/stores/auth-store'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { FileSource } from '@/components/ui/file-source'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionLabel } from '@/components/ui/section-label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { Job } from '@/lib/api/environments'
import { cn } from '@/lib/utils'
import { formatMegabytes } from '@/lib/concept-mapping/scores-csv'
import {
  addEmbeddingModel, buildEmbeddingIndex, deleteEmbeddingConfig, deleteEmbeddingModel, downloadEmbeddingModel,
  installEmbeddingsRuntime, setupDefaultEngine, uploadEmbeddingModel,
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

type Tab = 'models' | 'configs'

const STACKED = 'col-start-1 row-start-1 flex flex-col gap-6 data-[state=inactive]:invisible'

/**
 * What the semantic method needs: embedding models and configurations of the
 * workspace, shared by all its mapping projects, and the runtime they run on,
 * shared by the whole instance. Opened from the Compute tab.
 */
export function SemanticEnginesDialog({ open, onOpenChange, workspaceId, engines, canWrite, reload }: Props) {
  const { t } = useTranslation()
  const isAdmin = useAuthStore((s) => s.user?.role) === 'admin'
  const [tab, setTab] = useState<Tab>('models')
  const [error, setError] = useState<string | null>(null)
  const [setupJobId, setSetupJobId] = useState<string | null>(null)
  const [runtimeJobId, setRuntimeJobId] = useState<string | null>(null)
  const setupJob = useJob(setupJobId ?? engines.setupJobId, (j) => { setError(jobError(j)); setSetupJobId(null); reload() })
  const runtimeJob = useJob(runtimeJobId ?? engines.runtime.jobId, (j) => { setError(jobError(j)); setRuntimeJobId(null); reload() })
  const [editing, setEditing] = useState<EmbeddingConfig | 'new' | null>(null)
  const notAllowed = t('concept_mapping.engines_not_allowed')

  // A job may have started or ended while the dialog was closed: its rows
  // unmounted with it and stopped following.
  useEffect(() => {
    if (open) reload()
  }, [open, reload])

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
      kind="workbench"
      className="h-auto sm:max-w-3xl"
      title={t('concept_mapping.engines_manage')}
      description={t('concept_mapping.engines_dialog_desc')}
      hideFooter
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex h-full min-h-0 flex-col">
        <TabsList className="w-full">
          <TabsTrigger value="models" className="flex-1">{t('concept_mapping.engines_tab_models')}</TabsTrigger>
          <TabsTrigger value="configs" className="flex-1">{t('concept_mapping.engines_configs')}</TabsTrigger>
        </TabsList>
        {error && <p className="mt-3 whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{error}</p>}
        {/* Both tabs stay mounted in one grid cell, the hidden one invisible: the
            dialog keeps its height across a switch, and a row's job its state. */}
        <div className="grid min-h-0 flex-1 overflow-auto pt-4">
          <TabsContent value="models" forceMount className={STACKED}>
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
                    allowed={canWrite && isAdmin && !setupJob}
                    notAllowedReason={!canWrite ? notAllowed : !isAdmin ? t('concept_mapping.engines_runtime_admin_only') : t('concept_mapping.engines_setup_running')}
                    size="xs"
                    variant="outline"
                    className="gap-1"
                    onClick={() => act(async () => setRuntimeJobId((await installEmbeddingsRuntime(workspaceId)).id))}
                  >
                    {engines.runtime.installed ? <RotateCw size={12} /> : <Download size={12} />}
                    {engines.runtime.installed ? t('concept_mapping.engines_runtime_reinstall') : t('concept_mapping.engines_runtime_install')}
                  </GatedButton>
                )}
              </div>
              {runtimeJob && runtimeJob.status !== 'done' && <JobLine job={runtimeJob} />}
            </section>

            <ModelsSection
              workspaceId={workspaceId}
              engines={engines}
              canWrite={canWrite}
              setupJob={setupJob}
              runtimeBusy={!!runtimeJob}
              onSetup={async () => setSetupJobId((await setupDefaultEngine(workspaceId)).id)}
              act={act}
              reload={reload}
              onError={setError}
            />
          </TabsContent>

          <TabsContent value="configs" forceMount className={STACKED}>
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
          </TabsContent>
        </div>
      </Tabs>

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

type AddOption = 'default' | 'huggingface' | 'folder'

type Act = (fn: () => Promise<unknown>) => Promise<void>

function ModelsSection({ workspaceId, engines, canWrite, setupJob, runtimeBusy, onSetup, act, reload, onError }: {
  workspaceId: string
  engines: SuggestionEngines
  canWrite: boolean
  /** The one-click BioLORD setup in flight: it shows on the default model's line. */
  setupJob: Job | null
  runtimeBusy: boolean
  onSetup: () => Promise<void>
  act: Act
  reload: () => void
  onError: (e: string | null) => void
}) {
  const { t } = useTranslation()
  const isAdmin = useAuthStore((s) => s.user?.role) === 'admin'
  const [adding, setAdding] = useState<AddOption | null>(null)
  const [repoId, setRepoId] = useState('')
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const [toDelete, setToDelete] = useState<EmbeddingModel | null>(null)
  const defaultRepo = engines.defaultModel.repoId
  // The setup adds the model halfway (after the runtime): until then its job
  // shows on a placeholder line, then on the model's own row.
  const hasDefault = engines.models.some((m) => m.repoId === defaultRepo)

  const add = (fn: () => Promise<unknown>) => act(async () => {
    await fn()
    setAdding(null)
  })
  const uploadFolder = (files: File[]) => add(async () => {
    setUpload({ done: 0, total: 1 })
    try {
      await uploadEmbeddingModel(workspaceId, files, (done, total) => setUpload({ done, total }))
    } finally {
      setUpload(null)
    }
  })

  const options: { id: AddOption; icon: typeof Download; title: string; desc: string; disabled?: boolean }[] = [
    {
      id: 'default', icon: Sparkles, title: defaultRepo.split('/').at(-1) ?? defaultRepo,
      desc: hasDefault
        ? t('concept_mapping.engines_add_default_installed')
        : setupJob ? t('concept_mapping.engines_add_default_installing') : t('concept_mapping.engines_default_badge'),
      disabled: hasDefault || !!setupJob,
    },
    { id: 'huggingface', icon: Download, title: t('concept_mapping.engines_model_hf'), desc: t('concept_mapping.engines_add_hf_desc') },
    { id: 'folder', icon: FolderOpen, title: t('concept_mapping.engines_add_folder'), desc: t('concept_mapping.engines_add_folder_desc') },
  ]

  return (
    <section className="space-y-3">
      <SectionLabel as="h3" info={t('concept_mapping.engines_models_hint')}>{t('concept_mapping.engines_models')}</SectionLabel>
      {engines.models.length === 0 && !setupJob ? (
        <p className="text-xs text-muted-foreground">{t('concept_mapping.engines_models_empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {setupJob && !hasDefault && (
            <li className="space-y-1 px-3 py-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium">{defaultRepo.split('/').at(-1)}</span>
                <code className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">{defaultRepo}</code>
              </div>
              {setupJob.status !== 'done' && <JobLine job={setupJob} />}
            </li>
          )}
          {engines.models.map((m) => (
            <ModelRow
              key={m.id}
              workspaceId={workspaceId}
              model={m}
              setupJob={m.repoId === defaultRepo ? setupJob : null}
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

      {canWrite && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {options.map(({ id, icon: Icon, title, desc, disabled }) => (
              <button
                key={id}
                type="button"
                disabled={disabled}
                aria-pressed={adding === id}
                onClick={() => setAdding((a) => (a === id ? null : id))}
                className={cn(
                  'flex items-start gap-2 rounded-lg border p-2.5 text-left transition-colors disabled:cursor-default disabled:opacity-50',
                  adding === id ? 'border-primary bg-primary/5' : 'enabled:hover:bg-accent',
                )}
              >
                <Icon size={14} className={cn('mt-0.5 shrink-0', adding === id ? 'text-primary' : 'text-muted-foreground')} />
                <span className="min-w-0 space-y-0.5">
                  <span className={cn('block truncate text-xs font-medium', adding === id && 'text-primary')}>{title}</span>
                  <span className="block text-[10px] text-muted-foreground">{desc}</span>
                </span>
              </button>
            ))}
          </div>

          {adding === 'default' && (
            <div className="flex items-center gap-3 rounded-md bg-muted/40 p-3">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t('concept_mapping.engines_default_desc', { repo: defaultRepo })}</p>
              <GatedButton
                allowed={!runtimeBusy && (engines.runtime.installed || isAdmin)}
                notAllowedReason={runtimeBusy ? t('concept_mapping.engines_runtime_installing') : t('concept_mapping.engines_runtime_admin_only')}
                size="sm"
                className="gap-1.5"
                onClick={() => add(onSetup)}
              >
                <Download size={14} />
                {t('concept_mapping.engines_default_install')}
              </GatedButton>
            </div>
          )}

          {adding === 'huggingface' && (
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                className="h-8 flex-1 font-mono text-xs"
                placeholder={t('concept_mapping.engines_model_hf_placeholder')}
                value={repoId}
                onChange={(e) => setRepoId(e.target.value)}
              />
              <GatedButton
                allowed={engines.runtime.installed}
                notAllowedReason={t('concept_mapping.engines_needs_runtime')}
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={!/^[\w.-]+\/[\w.-]+$/.test(repoId.trim())}
                onClick={() => add(async () => {
                  await addEmbeddingModel(workspaceId, { source: 'huggingface', repoId: repoId.trim() })
                  setRepoId('')
                })}
              >
                <Download size={14} />
                {t('concept_mapping.engines_model_download')}
              </GatedButton>
            </div>
          )}

          {adding === 'folder' && (
            <FileSource
              scope={{ kind: 'workspace', workspaceId }}
              expect="dir"
              serverPath=""
              onServerPathChange={(path) => {
                if (path) void add(() => addEmbeddingModel(workspaceId, { source: 'server', serverPath: path }))
              }}
            >
              <div className="space-y-2">
                <Label>{t('files.upload_from_computer')}</Label>
                <FileDropZone
                  icon={upload
                    ? <Loader2 size={20} className="animate-spin text-muted-foreground" />
                    : <Upload size={20} className="text-muted-foreground" />}
                  label={upload
                    ? t('concept_mapping.engines_model_uploading', { percent: Math.round((upload.done / upload.total) * 100) })
                    : t('concept_mapping.engines_model_upload_hint')}
                  onClick={() => folderInput.current?.click()}
                  disabled={!!upload}
                />
                <input
                  ref={folderInput}
                  type="file"
                  className="hidden"
                  // @ts-expect-error webkitdirectory is non-standard but widely supported
                  webkitdirectory=""
                  onChange={(e) => {
                    const files = [...(e.target.files ?? [])]
                    // Cleared so re-picking the same folder fires change again.
                    e.target.value = ''
                    if (files.length) void uploadFolder(files)
                  }}
                />
              </div>
            </FileSource>
          )}
        </div>
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

function ModelRow({ workspaceId, model, setupJob, runtimeReady, canWrite, act, reload, onError, onDelete }: {
  workspaceId: string
  model: EmbeddingModel
  /** The BioLORD setup downloading this model: followed by the dialog, shown here. */
  setupJob: Job | null
  runtimeReady: boolean
  canWrite: boolean
  act: Act
  reload: () => void
  onError: (e: string | null) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [jobId, setJobId] = useState<string | null>(null)
  const ownJob = useJob(jobId ?? model.jobId, (j) => { onError(jobError(j)); setJobId(null); reload() })
  const job = ownJob ?? setupJob
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
