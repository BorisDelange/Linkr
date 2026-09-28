import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileJson, GitBranch, Loader2 } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  createDictionary,
  previewSync,
  readDictionarySource,
  syncDictionary,
  type DictionarySource,
} from '@/lib/data-dictionary/dictionaries'
import type { DictionaryContent, DictionarySyncPlan } from '@/lib/data-dictionary/content'
import { DEFAULT_DICTIONARY_BRANCH, DEFAULT_DICTIONARY_REPO } from '@/lib/data-dictionary/repo'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import type { ConceptSet, DataDictionary } from '@/types'

interface DictionarySyncDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  /** The dictionary to update; null to add one. */
  dictionary: DataDictionary | null
  onDone: () => void
}

const LISTED = 8

/**
 * Add a data dictionary, or update one: read its repository (or files), show
 * what would be added, updated and removed, then apply.
 */
export function DictionarySyncDialog({ open, onOpenChange, workspaceId, dictionary, onDone }: DictionarySyncDialogProps) {
  const { t, i18n } = useTranslation()
  const conceptSets = useConceptMappingStore((s) => s.conceptSets)
  const filesInput = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState<'repo' | 'files'>('repo')
  const [url, setUrl] = useState(DEFAULT_DICTIONARY_REPO)
  const [branch, setBranch] = useState(DEFAULT_DICTIONARY_BRANCH)
  const [name, setName] = useState('')
  const [source, setSource] = useState<DictionarySource | null>(null)
  const [content, setContent] = useState<DictionaryContent | null>(null)
  const [plan, setPlan] = useState<DictionarySyncPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const read = async (next: DictionarySource) => {
    setBusy(true)
    setError(null)
    try {
      const read = await readDictionarySource(next, i18n.language)
      setSource(next)
      setContent(read)
      setPlan(previewSync(conceptSets, dictionary, read))
      if (!dictionary && !name) setName(read.title ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setContent(null)
    setPlan(null)
    setSource(null)
    setError(null)
    setName('')
    setKind(dictionary && !dictionary.sourceRepo ? 'files' : 'repo')
    setUrl(dictionary?.sourceRepo ?? DEFAULT_DICTIONARY_REPO)
    setBranch(dictionary?.branch ?? DEFAULT_DICTIONARY_BRANCH)
    // An update of a repository dictionary starts by reading it.
    if (dictionary?.sourceRepo) void read({ kind: 'repo', url: dictionary.sourceRepo, branch: dictionary.branch ?? DEFAULT_DICTIONARY_BRANCH })
    // Runs once per opening; `read` is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dictionary])

  const apply = async () => {
    if (!content || !source) return
    setBusy(true)
    setError(null)
    try {
      if (dictionary) await syncDictionary(dictionary, content)
      else await createDictionary(workspaceId, source, content, name)
      onDone()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // The name in the reader's language, as every concept-set list shows it.
  const label = (s: Pick<ConceptSet, 'name' | 'translations'>) => {
    const tr = s.translations?.[i18n.language.substring(0, 2)] ?? s.translations?.en
    return tr?.name || s.name
  }

  const nothingChanges = !!plan && plan.added.length + plan.updated.length + plan.removed.length === 0
    && (content?.commit == null || content.commit === dictionary?.commit)

  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => { if (!busy) onOpenChange(next) }}
      kind="settings"
      title={dictionary ? t('data_dictionaries.update_title', { name: dictionary.name }) : t('data_dictionaries.add_title')}
      description={dictionary ? undefined : t('data_dictionaries.add_description')}
      onConfirm={plan ? apply : () => { void read(kind === 'repo' ? { kind: 'repo', url, branch } : { kind: 'files', files: [] }) }}
      confirmLabel={plan
        ? (dictionary ? t('data_dictionaries.apply_update') : t('data_dictionaries.apply_add'))
        : t('data_dictionaries.read')}
      confirmDisabled={busy || (!plan && kind === 'files') || (!plan && !url.trim())}
      busy={busy}
    >
      {!plan && (
        <div className="space-y-3">
          {!dictionary && (
            <Tabs value={kind} onValueChange={(v) => setKind(v as 'repo' | 'files')}>
              <TabsList className="w-full">
                <TabsTrigger value="repo" className="flex-1"><GitBranch size={14} />{t('data_dictionaries.source_repo')}</TabsTrigger>
                <TabsTrigger value="files" className="flex-1"><FileJson size={14} />{t('data_dictionaries.source_files')}</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          {kind === 'repo' ? (
            <>
              <FormField label={t('data_dictionaries.repo_url')} hint={t('data_dictionaries.repo_url_hint')}>
                {({ id }) => <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} disabled={!!dictionary} />}
              </FormField>
              <FormField label={t('data_dictionaries.branch')}>
                {({ id }) => <Input id={id} value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!!dictionary} />}
              </FormField>
            </>
          ) : (
            <>
              <FileDropZone
                icon={<FileJson size={20} />}
                label={t('data_dictionaries.pick_files')}
                hint={t('data_dictionaries.pick_files_hint')}
                onClick={() => filesInput.current?.click()}
              />
              <input
                ref={filesInput}
                type="file"
                accept=".json"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])]
                  e.target.value = ''
                  if (files.length > 0) void read({ kind: 'files', files })
                }}
              />
            </>
          )}
          {busy && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              {t('data_dictionaries.reading')}
            </p>
          )}
        </div>
      )}

      {plan && content && (
        <div className="space-y-3">
          {!dictionary && (
            <FormField label={t('data_dictionaries.name')}>
              {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
            </FormField>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Badge>{t('data_dictionaries.plan_added', { count: plan.added.length })}</Badge>
            <Badge variant="secondary">{t('data_dictionaries.plan_updated', { count: plan.updated.length })}</Badge>
            <Badge variant="outline" className={plan.removed.length ? 'text-destructive' : ''}>{t('data_dictionaries.plan_removed', { count: plan.removed.length })}</Badge>
            <Badge variant="outline">{t('data_dictionaries.plan_unchanged', { count: plan.unchanged })}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('data_dictionaries.plan_units', {
              conversions: content.unitConversions?.length ?? 0,
              units: content.recommendedUnits?.length ?? 0,
            })}
            {content.commit && <span className="font-mono"> · {content.commit.slice(0, 7)}</span>}
          </p>
          {nothingChanges && <p className="text-xs text-muted-foreground">{t('data_dictionaries.up_to_date')}</p>}
          {dictionary && plan.updated.length > 0 && (
            <ChangeList title={t('data_dictionaries.list_updated')} items={plan.updated.map((u) => `${label(u.incoming)}${u.fromVersion && u.incoming.version && u.fromVersion !== u.incoming.version ? ` (${u.fromVersion} → ${u.incoming.version})` : ''}`)} />
          )}
          {plan.removed.length > 0 && (
            <ChangeList title={t('data_dictionaries.list_removed')} items={plan.removed.map((s) => label(s))} />
          )}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </DialogShell>
  )
}

function ChangeList({ title, items }: { title: string; items: string[] }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{title}</p>
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        {items.slice(0, LISTED).map((item, i) => <li key={i} className="truncate">{item}</li>)}
        {items.length > LISTED && <li>{t('data_dictionaries.list_more', { count: items.length - LISTED })}</li>}
      </ul>
    </div>
  )
}
