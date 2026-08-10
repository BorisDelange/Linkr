import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { ArrowLeft, Check, Pencil, Repeat, Scale, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
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
import { remarkPlugins, rehypePlugins, urlTransform } from '@/components/editor/ReadmeEditor'
import { MarkdownToolbar, applyMarkdownFormat, type MarkdownFormat } from '@/components/editor/MarkdownToolbar'
import {
  LICENSE_CATEGORY_KEYS,
  LICENSE_TEMPLATES,
  fillLicensePlaceholders,
  licenseTitle,
  loadLicenseText,
} from '@/lib/licenses'
import type { EntityLicense } from '@/types'

interface LicenseEditorProps {
  license: EntityLicense | null | undefined
  onSave: (license: EntityLicense | null) => void | Promise<void>
  /** Pre-fills the copyright holder of licenses that ask for one (MIT, BSD). */
  copyrightHolder?: string
  canEdit?: boolean
  className?: string
}

type Mode = 'view' | 'pick' | 'edit'

export function LicenseEditor({
  license,
  onSave,
  copyrightHolder,
  canEdit = true,
  className = 'flex h-full flex-col pt-2',
}: LicenseEditorProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<Mode>('view')
  const [draft, setDraft] = useState<EntityLicense | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handlePickStandard = async (id: (typeof LICENSE_TEMPLATES)[number]['id']) => {
    const raw = await loadLicenseText(id)
    const text = fillLicensePlaceholders(raw, {
      year: new Date().getFullYear(),
      holder: copyrightHolder?.trim() || '<copyright holders>',
    })
    setDraft({ id, text })
    setMode('edit')
  }

  const handlePickCustom = () => {
    setDraft({ id: 'custom', name: '', text: '' })
    setMode('edit')
  }

  const backToView = () => {
    setDraft(null)
    setMode('view')
  }

  const handleSave = async () => {
    if (!draft) return
    const trimmedName = draft.name?.trim()
    await onSave({
      id: draft.id,
      ...(draft.id === 'custom' ? { name: trimmedName } : trimmedName ? { name: trimmedName } : {}),
      text: draft.text,
    })
    backToView()
  }

  const applyFormat = (format: MarkdownFormat) => {
    const textarea = textareaRef.current
    if (!textarea || !draft) return
    const { text, cursorStart, cursorEnd } = applyMarkdownFormat(
      draft.text,
      textarea.selectionStart,
      textarea.selectionEnd,
      format,
    )
    setDraft({ ...draft, text })
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(cursorStart, cursorEnd)
    })
  }

  const saveDisabled = !draft?.text.trim() || (draft.id === 'custom' && !draft.name?.trim())

  return (
    <div className={className}>
      {/* Header bar */}
      <div className="flex shrink-0 items-center justify-between">
        <h2 className="text-xs font-semibold uppercase text-muted-foreground">
          {t('license.title')}
        </h2>
        <div className="flex items-center gap-1">
          {mode === 'view' && canEdit && license && (
            <>
              <Button variant="ghost" size="sm" className="h-5 px-2 text-xs text-muted-foreground" onClick={() => setMode('pick')}>
                <Repeat size={12} />
                {t('license.change')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-2 text-xs text-muted-foreground"
                onClick={() => { setDraft(license); setMode('edit') }}
              >
                <Pencil size={12} />
                {t('summary.edit')}
              </Button>
              <Button variant="ghost" size="sm" className="h-5 px-2 text-xs text-muted-foreground hover:text-destructive" onClick={() => setRemoveOpen(true)}>
                <Trash2 size={12} />
                {t('license.remove')}
              </Button>
            </>
          )}
          {mode === 'pick' && (
            <Button variant="ghost" size="sm" className="h-5 px-2 text-xs text-muted-foreground" onClick={backToView}>
              <ArrowLeft size={12} />
              {t('common.cancel')}
            </Button>
          )}
          {mode === 'edit' && (
            <>
              <Button variant="ghost" size="sm" className="h-5 px-2 text-xs text-muted-foreground" onClick={backToView}>
                <X size={12} />
                {t('common.cancel')}
              </Button>
              <Button variant="ghost" size="sm" className="h-5 px-2 text-xs text-primary" onClick={handleSave} disabled={saveDisabled}>
                <Check size={12} />
                {t('common.save')}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      {mode === 'pick' ? (
        <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-xl border bg-card p-4 shadow-sm">
          <div className="grid gap-2 sm:grid-cols-2">
            {LICENSE_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => handlePickStandard(tpl.id)}
                className="rounded-lg border p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-card-foreground">{tpl.title}</span>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {t(LICENSE_CATEGORY_KEYS[tpl.category])}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t(tpl.descriptionKey)}</p>
              </button>
            ))}
            <button
              type="button"
              onClick={handlePickCustom}
              className="rounded-lg border border-dashed p-3 text-left transition-colors hover:border-primary/50 hover:bg-accent"
            >
              <span className="text-sm font-medium text-card-foreground">{t('license.custom')}</span>
              <p className="mt-1 text-xs text-muted-foreground">{t('license.custom_description')}</p>
            </button>
          </div>
        </div>
      ) : mode === 'edit' && draft ? (
        <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-xs">
          <div className="border-b p-3">
            <Input
              value={draft.id === 'custom' ? (draft.name ?? '') : licenseTitle(draft)}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              disabled={draft.id !== 'custom'}
              placeholder={t('license.name_placeholder')}
              className="h-8 text-sm"
            />
          </div>
          <MarkdownToolbar onFormat={applyFormat} />
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-0">
            <div className="overflow-auto border-r">
              <textarea
                ref={textareaRef}
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                placeholder={t('license.text_placeholder')}
                className="h-full w-full resize-none border-0 bg-transparent p-4 font-mono text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
                spellCheck={false}
              />
            </div>
            <div className="overflow-auto p-4">
              {/* Preview as markdown: standard texts are plain prose either way, and a
                  custom license may legitimately use headings or lists. */}
              <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap [&>*:first-child]:!mt-0">
                <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={urlTransform}>
                  {draft.text}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3 min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="h-full overflow-auto p-4">
            {license ? (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <Scale size={14} className="text-muted-foreground" />
                  <span className="text-sm font-medium text-card-foreground">{licenseTitle(license)}</span>
                </div>
                <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
                  {license.text}
                </pre>
              </>
            ) : (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-muted-foreground">{t('license.no_license')}</p>
                {canEdit && (
                  <Button variant="outline" size="sm" onClick={() => setMode('pick')}>
                    <Scale size={14} />
                    {t('license.choose')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('license.remove_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('license.remove_confirm_description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { void onSave(null); setRemoveOpen(false) }}>
              {t('license.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
