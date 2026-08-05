import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Bot, Check, Loader2, Save, Trash2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { isLocalEndpoint } from '@/lib/agent/locality'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  clearAgentSettings,
  loadAgentSettings,
  saveAgentSettings,
} from '@/lib/agent/settings'

type TestState = { status: 'idle' | 'testing' | 'ok' | 'fail'; detail?: string }

/**
 * Points the dashboard assistant at an LLM. Local endpoints (Ollama, LM Studio,
 * llama.cpp) need nothing beyond a URL; a remote API forces an explicit,
 * recorded acknowledgement because prompts carrying clinical context would then
 * leave the institution.
 */
export function AgentSettingsTab() {
  const { t } = useTranslation()
  const initial = loadAgentSettings()
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? DEFAULT_BASE_URL)
  const [model, setModel] = useState(initial?.model ?? DEFAULT_MODEL)
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [acknowledged, setAcknowledged] = useState(Boolean(initial?.acknowledgedAt))
  const [saved, setSaved] = useState(false)
  const [test, setTest] = useState<TestState>({ status: 'idle' })

  const remote = baseUrl.trim().length > 0 && !isLocalEndpoint(baseUrl)
  const blocked = remote && !acknowledged
  const incomplete = !baseUrl.trim() || !model.trim()

  const handleSave = () => {
    if (incomplete || blocked) return
    saveAgentSettings({
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      apiKey: apiKey.trim() || undefined,
      acknowledgedAt: remote ? new Date().toISOString() : undefined,
    })
    setSaved(true)
  }

  const handleClear = () => {
    clearAgentSettings()
    setBaseUrl(DEFAULT_BASE_URL)
    setModel(DEFAULT_MODEL)
    setApiKey('')
    setAcknowledged(false)
    setTest({ status: 'idle' })
    setSaved(true)
  }

  const handleTest = async () => {
    setTest({ status: 'testing' })
    try {
      const url = `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
      const response = await fetch(url, {
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

        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_14rem]">
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
              placeholder={DEFAULT_BASE_URL}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('agent.settings_base_url_hint')}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-model">{t('agent.settings_model')}</Label>
            <Input
              id="agent-model"
              value={model}
              onChange={(e) => {
                setModel(e.target.value)
                setSaved(false)
                setTest({ status: 'idle' })
              }}
              placeholder={DEFAULT_MODEL}
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
                <p className="text-xs text-foreground">
                  {t('agent.remote_warning_body')}
                </p>
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
          <Button size="sm" onClick={handleSave} disabled={incomplete || blocked}>
            <Save size={14} />
            {t('common.save')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleTest}
            disabled={incomplete || test.status === 'testing'}
          >
            {test.status === 'testing' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : null}
            {t('agent.settings_test')}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleClear}>
            <Trash2 size={14} />
            {t('agent.settings_clear')}
          </Button>

          {test.status === 'ok' ? (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <Check size={13} />
              {t('agent.settings_test_ok')}
            </span>
          ) : null}
          {test.status === 'fail' ? (
            <span className="text-xs text-destructive">
              {t('agent.settings_test_fail')} {test.detail}
            </span>
          ) : null}
          {saved ? (
            <span className="text-xs text-muted-foreground">
              {t('agent.settings_saved')}
            </span>
          ) : null}
        </div>

        {blocked ? (
          <p className="mt-2 text-xs text-destructive">
            {t('agent.remote_blocked')}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
