import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronsUpDown,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { localized } from '@/lib/localized'
import { isServerMode } from '@/lib/api-client'
import { isLocalEndpoint } from '@/lib/agent/locality'
import {
  createProvider,
  deleteProvider,
  listProviders,
  updateProvider,
  type AgentSurface,
  type LlmProvider,
} from '@/lib/api/llm'
import {
  DEFAULT_BASE_URL,
  clearAgentSettings,
  fetchAvailableModels,
  loadAgentSettings,
  providerName,
  saveAgentSettings,
} from '@/lib/agent/settings'

type TestState = { status: 'idle' | 'testing' | 'ok' | 'fail'; detail?: string }
type ModelsState = { status: 'idle' | 'loading' | 'ok' | 'fail'; list: string[] }

const SURFACES: AgentSurface[] = ['dashboard', 'ide']


interface AgentSettingsTabProps {
  workspaceId: string
  /** Owner-only. Without it the tab is read-only: which model the assistant may
   *  use decides where prompts carrying clinical context end up. */
  canWrite: boolean
}

/**
 * Points Linkr's AI assistant at one or more language models.
 *
 * In server mode an admin configures providers for the whole workspace and
 * approves each one per surface, so an ordinary user picks from a vetted list
 * and no API key ever reaches a browser. A client-only (WASM) deployment has no
 * server, so it keeps a single browser-local endpoint.
 *
 * Local endpoints (Ollama, LM Studio, llama.cpp) need only a URL; a remote API
 * forces an explicit, recorded acknowledgement, because prompts carrying clinical
 * context would then leave the institution.
 */
export function AgentSettingsTab({ workspaceId, canWrite }: AgentSettingsTabProps) {
  const { t } = useTranslation()
  const server = isServerMode()

  const [providers, setProviders] = useState<LlmProvider[]>([])
  const [loading, setLoading] = useState(server)
  const [editing, setEditing] = useState<LlmProvider | 'new' | null>(null)
  const [deleting, setDeleting] = useState<LlmProvider | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!server || !workspaceId) return
    setLoading(true)
    try {
      setProviders(await listProviders(workspaceId))
      setError(null)
    } catch (caught) {
      setError((caught as Error)?.message ?? 'error')
    } finally {
      setLoading(false)
    }
  }, [server, workspaceId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggleSurface = async (provider: LlmProvider, surface: AgentSurface) => {
    const next = provider.surfaces.includes(surface)
      ? provider.surfaces.filter((s) => s !== surface)
      : [...provider.surfaces, surface]
    await updateProvider(provider.id, { surfaces: next })
    await refresh()
  }

  const confirmRemove = async () => {
    if (!deleting) return
    await deleteProvider(deleting.id)
    setDeleting(null)
    await refresh()
  }

  // WASM mode: no server to hold a provider list, so keep the single-endpoint form.
  if (!server) {
    return <LocalEndpointForm />
  }

  return (
    <Card className="mt-4">
      <CardContent className="px-5 pb-5 pt-5">
        <div className="flex items-start gap-2">
          <Bot size={18} className="mt-0.5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground">
              {t('agent.settings_title')}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('agent.providers_description')}
            </p>
          </div>
          {canWrite && !editing ? (
            <Button size="sm" className="h-8" onClick={() => setEditing('new')}>
              <Plus size={13} />
              {t('agent.provider_add')}
            </Button>
          ) : null}
        </div>

        {editing ? (
          <ProviderForm
            workspaceId={workspaceId}
            provider={editing === 'new' ? null : editing}
            onDone={async () => {
              setEditing(null)
              await refresh()
            }}
            onCancel={() => setEditing(null)}
          />
        ) : null}

        {loading ? (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 size={13} className="animate-spin" />
            {t('common.loading')}
          </p>
        ) : null}

        {error ? <p className="mt-4 text-xs text-destructive">{error}</p> : null}

        {!loading && !providers.length && !editing ? (
          <p className="mt-4 text-xs text-muted-foreground">{t('agent.providers_empty')}</p>
        ) : null}

        {providers.length ? (
          <div className="mt-4 divide-y divide-border rounded-md border">
            {providers.map((provider) => (
              <div key={provider.id} className="p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">
                        {providerName(provider)}
                      </span>
                      {provider.isLocal ? (
                        <Badge variant="secondary" className="text-[10px]">
                          {t('agent.provider_local')}
                        </Badge>
                      ) : (
                        <Badge variant="destructive" className="text-[10px]">
                          {t('agent.provider_remote')}
                        </Badge>
                      )}
                      {provider.hasApiKey ? (
                        <Badge variant="outline" className="text-[10px]">
                          {t('agent.provider_has_key')}
                        </Badge>
                      ) : null}
                    </div>
                    {/* Keep the model id visible even under a custom name —
                        otherwise "Ollama Gemma 4B" hides which model runs. */}
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {providerName(provider) === provider.model
                        ? provider.baseUrl
                        : `${provider.model} · ${provider.baseUrl}`}
                    </p>
                  </div>
                  {canWrite ? (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => setEditing(provider)}
                      >
                        <Pencil size={13} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => setDeleting(provider)}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  ) : null}
                </div>

                {/* Approval is per surface: a model can drive a dashboard well
                    and be poor in the IDE, so one global on/off would be wrong. */}
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <span className="text-[11px] text-muted-foreground">
                    {t('agent.provider_approved_for')}
                  </span>
                  {SURFACES.map((surface) => (
                    <label key={surface} className="flex items-center gap-1.5 text-xs">
                      <Checkbox
                        checked={provider.surfaces.includes(surface)}
                        disabled={!canWrite}
                        onCheckedChange={() => void toggleSurface(provider, surface)}
                      />
                      <span>{t(`agent.surface_${surface}`)}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {!canWrite ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {t('agent.providers_read_only')}
          </p>
        ) : null}

        <AlertDialog
          open={!!deleting}
          onOpenChange={(open) => {
            if (!open) setDeleting(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('agent.provider_delete_title')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('agent.provider_delete_confirm', { name: providerName(deleting) })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmRemove}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {t('common.delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

/**
 * Create or edit one provider.
 *
 * The API key is write-only: an existing one shows as "set" and is only replaced
 * if the user types a new value, because the server never returns it.
 */
function ProviderForm({
  workspaceId,
  provider,
  onDone,
  onCancel,
}: {
  workspaceId: string
  provider: LlmProvider | null
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? DEFAULT_BASE_URL)
  const [model, setModel] = useState(provider?.model ?? '')
  // Raw stored value, NOT providerName(): that falls back to the model id, which
  // would pre-fill the field and turn "no custom name" into a name on next save.
  const [displayName, setDisplayName] = useState(localized(provider?.name, 'en'))
  const [apiKey, setApiKey] = useState('')
  const [acknowledged, setAcknowledged] = useState(Boolean(provider?.acknowledgedAt))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const [models, setModels] = useState<ModelsState>({ status: 'idle', list: [] })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [modelSearch, setModelSearch] = useState('')

  const remote = baseUrl.trim().length > 0 && !isLocalEndpoint(baseUrl)
  const blocked = remote && !acknowledged
  const incomplete = !baseUrl.trim() || !model.trim()

  /**
   * Picking a model fills the name with it, unless the user typed one.
   *
   * Tracked against the previous model rather than "is the field empty", so
   * clearing the name deliberately and then switching model does not silently
   * refill it — but the common case (pick a model, keep the default name) needs
   * no typing.
   */
  const chooseModel = (next: string) => {
    setDisplayName((current) => (current.trim() === model.trim() ? next : current))
    setModel(next)
    setTest({ status: 'idle' })
  }

  const visibleModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase()
    if (!query) return models.list
    return models.list.filter((id) => id.toLowerCase().includes(query))
  }, [models.list, modelSearch])

  const loadModels = useCallback(async () => {
    if (!baseUrl.trim()) return
    setModels((prev) => ({ ...prev, status: 'loading' }))
    try {
      const list = await fetchAvailableModels(baseUrl, apiKey)
      setModels({ status: 'ok', list })
    } catch {
      setModels({ status: 'fail', list: [] })
    }
  }, [baseUrl, apiKey])

  // Populate the picker on mount so a configured endpoint shows its models
  // straight away; later refreshes are manual (the URL may be mid-edit).
  useEffect(() => {
    void loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSave = async () => {
    if (blocked || incomplete) return
    setSaving(true)
    setError(null)
    try {
      const acknowledgementText = remote ? t('agent.remote_acknowledge') : undefined
      // Empty = no custom name; the list then shows the model id.
      const name = { en: displayName.trim() }
      if (provider) {
        await updateProvider(provider.id, {
          name,
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          // Absent leaves the stored key alone; only send what the user typed.
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          acknowledgementText,
        })
      } else {
        await createProvider({
          workspaceId,
          name,
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          apiKey: apiKey.trim() || undefined,
          surfaces: [],
          acknowledgementText,
        })
      }
      onDone()
    } catch (caught) {
      setError((caught as Error)?.message ?? 'error')
    } finally {
      setSaving(false)
    }
  }

  /**
   * Two tests in one button, because they answer different questions and the
   * user needs the first one before they can even pick a model: with no model
   * chosen, check the endpoint responds at all (/models); with one, send a real
   * completion, which is the check that matters before saving.
   */
  const handleTest = async () => {
    setTest({ status: 'testing' })
    const root = baseUrl.trim().replace(/\/+$/, '')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`

    try {
      if (!model.trim()) {
        const list = await fetchAvailableModels(baseUrl, apiKey)
        setModels({ status: 'ok', list })
        setTest({
          status: 'ok',
          detail: t('agent.settings_test_endpoint_ok', { count: list.length }),
        })
        return
      }

      const response = await fetch(`${root}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model.trim(),
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        setTest({ status: 'fail', detail: `${response.status} ${detail.slice(0, 120)}` })
        return
      }
      setTest({ status: 'ok' })
    } catch (caught) {
      setTest({ status: 'fail', detail: (caught as Error)?.message?.slice(0, 120) })
    }
  }

  return (
    <div className="relative mt-4 rounded-md border bg-muted/30 p-3">
      <button
        type="button"
        onClick={onCancel}
        aria-label={t('common.close')}
        className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X size={14} />
      </button>

      <div className="space-y-1.5 pr-8">
        <Label htmlFor="agent-name">{t('agent.provider_name')}</Label>
        <Input
          id="agent-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={model.trim() || t('agent.provider_name_placeholder')}
        />
        <p className="text-[11px] text-muted-foreground">
          {t('agent.provider_name_hint')}
        </p>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_16rem]">
        <div className="space-y-1.5">
          <Label htmlFor="agent-url">{t('agent.settings_base_url')}</Label>
          <Input
            id="agent-url"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value)
              setTest({ status: 'idle' })
            }}
            onBlur={() => void loadModels()}
            placeholder={DEFAULT_BASE_URL}
          />
          <p className="text-[11px] text-muted-foreground">
            {t('agent.settings_base_url_hint')}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="agent-model">{t('agent.settings_model')}</Label>
          <div className="flex gap-1.5">
            {models.status === 'ok' && models.list.length > 0 ? (
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    id="agent-model"
                    className="flex h-9 flex-1 items-center justify-between rounded-md border px-3 text-sm transition-colors hover:bg-accent/50"
                  >
                    <span className={cn('truncate', !model && 'text-muted-foreground')}>
                      {model || t('agent.settings_model_placeholder')}
                    </span>
                    <ChevronsUpDown size={12} className="ml-1 shrink-0 text-muted-foreground" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-[var(--radix-popover-trigger-width)] bg-popover p-2"
                  align="start"
                  side="bottom"
                  // Keep it below the field even when space is tight, rather
                  // than flipping above and covering the endpoint URL.
                  avoidCollisions={false}
                >
                  {models.list.length > 5 ? (
                    <div className="relative mb-2">
                      <Search
                        size={12}
                        className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                      />
                      <Input
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                        placeholder={t('common.search')}
                        className="h-7 pl-7 text-xs"
                      />
                    </div>
                  ) : null}
                  <div
                    className="max-h-[200px] divide-y divide-border overflow-y-auto overscroll-contain rounded-md border bg-popover"
                    onWheel={(e) => {
                      e.stopPropagation()
                      e.currentTarget.scrollTop += e.deltaY
                    }}
                  >
                    {visibleModels.length === 0 ? (
                      <p className="px-2 py-1.5 text-xs text-muted-foreground">
                        {t('common.no_results')}
                      </p>
                    ) : null}
                    {visibleModels.map((id) => (
                      <button
                        key={id}
                        onClick={() => {
                          chooseModel(id)
                          setPickerOpen(false)
                          setModelSearch('')
                        }}
                        className={cn(
                          'flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors',
                          id === model
                            ? 'bg-accent/60 text-accent-foreground'
                            : 'hover:bg-accent/30'
                        )}
                      >
                        <span className="truncate">{id}</span>
                        {id === model ? <Check size={12} className="ml-auto shrink-0" /> : null}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            ) : (
              <Input
                id="agent-model"
                value={model}
                onChange={(e) => chooseModel(e.target.value)}
                placeholder={t('agent.settings_model_placeholder')}
                className="flex-1"
              />
            )}
            <Button
              variant="outline"
              size="icon"
              onClick={() => void loadModels()}
              disabled={models.status === 'loading' || !baseUrl.trim()}
              title={t('agent.settings_refresh_models')}
            >
              {models.status === 'loading' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
            </Button>
          </div>
          {models.status === 'fail' ? (
            <p className="text-[11px] text-muted-foreground">
              {t('agent.settings_models_failed')}
            </p>
          ) : null}
        </div>
      </div>

      {/* Outside the remote warning on purpose: needing a token and sending data
          off-site are different things. A local vLLM or LiteLLM behind a reverse
          proxy wants a key with no warning; a remote endpoint may need none. */}
      <div className="mt-3 space-y-1.5">
        <Label htmlFor="agent-key">{t('agent.settings_api_key')}</Label>
        <Input
          id="agent-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            provider?.hasApiKey
              ? t('agent.provider_key_set')
              : t('agent.provider_key_placeholder')
          }
          autoComplete="off"
        />
        <p className="text-[11px] text-muted-foreground">{t('agent.provider_key_hint')}</p>
      </div>

      {remote ? (
        <div className="mt-4 space-y-3 rounded-md border-2 border-destructive bg-destructive/5 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold text-destructive">
                {t('agent.remote_warning_title')}
              </p>
              <p className="text-xs text-foreground">{t('agent.remote_warning_body')}</p>
            </div>
          </div>

          <label className="flex items-start gap-2 text-xs">
            <Checkbox
              checked={acknowledged}
              onCheckedChange={(value) => setAcknowledged(value === true)}
              className="mt-0.5"
            />
            <span>{t('agent.remote_acknowledge')}</span>
          </label>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={blocked || incomplete || saving}>
          {saving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : provider ? (
            <Save size={14} />
          ) : (
            <Plus size={14} />
          )}
          {provider ? t('common.save') : t('agent.provider_add')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleTest}
          disabled={!baseUrl.trim() || test.status === 'testing'}
        >
          {test.status === 'testing' ? <Loader2 size={14} className="animate-spin" /> : null}
          {t('agent.settings_test')}
        </Button>

        {test.status === 'ok' ? (
          <span className="flex items-center gap-1 text-xs text-emerald-600">
            <Check size={13} />
            {test.detail ?? t('agent.settings_test_ok')}
          </span>
        ) : null}
        {test.status === 'fail' ? (
          <span className="text-xs text-destructive">
            {t('agent.settings_test_fail')} {test.detail}
          </span>
        ) : null}
      </div>

      {blocked ? (
        <p className="mt-2 text-xs text-destructive">{t('agent.remote_blocked')}</p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

/**
 * WASM mode: one endpoint, stored in this browser. There is no server to hold a
 * shared provider list, nor anywhere safer to keep an API key.
 */
function LocalEndpointForm() {
  const { t } = useTranslation()
  const [initial, setInitial] = useState(() => loadAgentSettings())
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? DEFAULT_BASE_URL)
  const [model, setModel] = useState(initial?.model ?? '')
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [acknowledged, setAcknowledged] = useState(Boolean(initial?.acknowledgedAt))
  const [saved, setSaved] = useState(false)

  const remote = baseUrl.trim().length > 0 && !isLocalEndpoint(baseUrl)
  const blocked = remote && !acknowledged
  const incomplete = !baseUrl.trim() || !model.trim()

  const dirty =
    baseUrl.trim() !== (initial?.baseUrl ?? DEFAULT_BASE_URL) ||
    model.trim() !== (initial?.model ?? '') ||
    apiKey.trim() !== (initial?.apiKey ?? '') ||
    acknowledged !== Boolean(initial?.acknowledgedAt)

  const handleSave = () => {
    if (blocked) return
    // Emptying the fields and saving is how you turn the assistant off — no
    // separate clear button needed.
    if (incomplete) {
      clearAgentSettings()
    } else {
      saveAgentSettings({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
        acknowledgedAt: remote ? new Date().toISOString() : undefined,
      })
    }
    setInitial(loadAgentSettings())
    setSaved(true)
  }

  // The button says "Saved" briefly, then reverts — a confirmation the user
  // cannot miss, without leaving a stale label next to a since-edited form.
  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => setSaved(false), 2000)
    return () => clearTimeout(timer)
  }, [saved])

  return (
    <Card className="mt-4">
      <CardContent className="px-5 pb-5 pt-5">
        <div className="flex items-start gap-2">
          <Bot size={18} className="mt-0.5 shrink-0 text-primary" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              {t('agent.settings_title')}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('agent.settings_description')}
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_16rem]">
          <div className="space-y-1.5">
            <Label htmlFor="agent-url-local">{t('agent.settings_base_url')}</Label>
            <Input
              id="agent-url-local"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value)
                setSaved(false)
              }}
              placeholder={DEFAULT_BASE_URL}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('agent.settings_base_url_hint')}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-model-local">{t('agent.settings_model')}</Label>
            <Input
              id="agent-model-local"
              value={model}
              onChange={(e) => {
                setModel(e.target.value)
                setSaved(false)
              }}
              placeholder={t('agent.settings_model_placeholder')}
            />
          </div>
        </div>

        {remote ? (
          <div className="mt-4 space-y-3 rounded-md border-2 border-destructive bg-destructive/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" />
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-semibold text-destructive">
                  {t('agent.remote_warning_title')}
                </p>
                <p className="text-xs text-foreground">{t('agent.remote_warning_body')}</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="agent-key-local">{t('agent.settings_api_key')}</Label>
              <Input
                id="agent-key-local"
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setSaved(false)
                }}
                autoComplete="off"
              />
            </div>

            <label className="flex items-start gap-2 text-xs">
              <Checkbox
                checked={acknowledged}
                onCheckedChange={(value) => {
                  setAcknowledged(value === true)
                  setSaved(false)
                }}
                className="mt-0.5"
              />
              <span>{t('agent.remote_acknowledge')}</span>
            </label>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={handleSave} disabled={blocked || (!dirty && !saved)}>
            {saved ? <Check size={14} /> : <Save size={14} />}
            {saved
              ? incomplete
                ? t('agent.settings_disabled')
                : t('agent.settings_saved')
              : t('common.save')}
          </Button>
        </div>

        {blocked ? (
          <p className="mt-2 text-xs text-destructive">{t('agent.remote_blocked')}</p>
        ) : null}
      </CardContent>
    </Card>
  )
}
