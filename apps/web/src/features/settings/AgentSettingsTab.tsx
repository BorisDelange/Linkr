import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronsUpDown,
  Loader2,
  RefreshCw,
  Save,
  Search,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { isLocalEndpoint } from '@/lib/agent/locality'
import {
  DEFAULT_BASE_URL,
  clearAgentSettings,
  fetchAvailableModels,
  loadAgentSettings,
  saveAgentSettings,
} from '@/lib/agent/settings'

type TestState = { status: 'idle' | 'testing' | 'ok' | 'fail'; detail?: string }
type ModelsState = { status: 'idle' | 'loading' | 'ok' | 'fail'; list: string[] }

/**
 * Points Linkr's AI assistant at a language model. The same endpoint serves every
 * assistant surface (dashboards, datasets, IDE, script collections), so this is
 * one setting, not one per page.
 *
 * Local endpoints (Ollama, LM Studio, llama.cpp) need only a URL; a remote API
 * forces an explicit, recorded acknowledgement, because prompts carrying clinical
 * context would then leave the institution.
 */
export function AgentSettingsTab() {
  const { t } = useTranslation()
  // Kept in state (not just read once) so "unsaved changes" stays accurate after
  // a save, without remounting the tab.
  const [initial, setInitial] = useState(() => loadAgentSettings())
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? DEFAULT_BASE_URL)
  const [model, setModel] = useState(initial?.model ?? '')
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [acknowledged, setAcknowledged] = useState(Boolean(initial?.acknowledgedAt))
  const [saved, setSaved] = useState(false)
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const [models, setModels] = useState<ModelsState>({ status: 'idle', list: [] })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [modelSearch, setModelSearch] = useState('')

  const remote = baseUrl.trim().length > 0 && !isLocalEndpoint(baseUrl)
  const blocked = remote && !acknowledged
  const incomplete = !baseUrl.trim() || !model.trim()

  const dirty =
    baseUrl.trim() !== (initial?.baseUrl ?? DEFAULT_BASE_URL) ||
    model.trim() !== (initial?.model ?? '') ||
    apiKey.trim() !== (initial?.apiKey ?? '') ||
    acknowledged !== Boolean(initial?.acknowledgedAt)

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
    } catch (error) {
      setTest({ status: 'fail', detail: (error as Error)?.message?.slice(0, 120) })
    }
  }

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
            <Label htmlFor="agent-url">{t('agent.settings_base_url')}</Label>
            <Input
              id="agent-url"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value)
                setSaved(false)
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
                            setModel(id)
                            setSaved(false)
                            setTest({ status: 'idle' })
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
                          {id === model ? (
                            <Check size={12} className="ml-auto shrink-0" />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              ) : (
                <Input
                  id="agent-model"
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value)
                    setSaved(false)
                    setTest({ status: 'idle' })
                  }}
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
              <Label htmlFor="agent-key">{t('agent.settings_api_key')}</Label>
              <Input
                id="agent-key"
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
          <Button
            size="sm"
            variant="outline"
            onClick={handleTest}
            disabled={!baseUrl.trim() || test.status === 'testing'}
          >
            {test.status === 'testing' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : null}
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
      </CardContent>
    </Card>
  )
}
