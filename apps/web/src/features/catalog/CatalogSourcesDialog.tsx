import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Plus, RotateCcw, Store, Trash2 } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/ui/dialog-shell'
import { EmptyState } from '@/components/ui/empty-state'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { cleanLocalized, localized, localizedRaw, seedLocalizedForEditing, setLocalized } from '@/lib/localized'
import { DEFAULT_CATALOG_BRANCH, DEFAULT_CATALOG_URL, parseCatalogUrl } from '@/lib/catalog/remote'
import { DEFAULT_CATALOG, DEFAULT_CATALOG_ID, type CatalogConfig } from '@/lib/catalog/settings'
import type { LocalizedString } from '@/types'
import { useCatalogSourcesStore } from '@/stores/catalog-sources-store'
import { useAppStore } from '@/stores/app-store'

interface CatalogSourcesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The catalogs the switcher offers: name them, point them at a repo, remove them.
 *
 * Every change applies at once — the list is small and each edit is its own
 * decision, so a draft with a global Save would only add a way to lose one.
 * The community catalog can be removed like any other; it can be brought back
 * from here, since it is the one catalog a user cannot be expected to know the
 * URL of.
 */
export function CatalogSourcesDialog({ open, onOpenChange }: CatalogSourcesDialogProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const catalogs = useCatalogSourcesStore((s) => s.catalogs)
  const setCatalogs = useCatalogSourcesStore((s) => s.setCatalogs)
  /** The catalog being edited, `'new'` for the add form, null for the list. */
  const [editing, setEditing] = useState<CatalogConfig | 'new' | null>(null)
  const [deleting, setDeleting] = useState<CatalogConfig | null>(null)
  const [draft, setDraft] = useState<CatalogDraft>(() => draftOf(null, language))

  const startEditing = (catalog: CatalogConfig | 'new') => {
    setDraft(draftOf(catalog === 'new' ? null : catalog, language))
    setEditing(catalog)
  }

  const takenUrls = editing
    ? catalogs.filter((c) => editing === 'new' || c.id !== editing.id).map((c) => c.url)
    : []
  const { source: draftSource, invalidUrl, duplicate } = validateDraft(draft, takenUrls, language)

  const submit = () => {
    if (!editing || !draftSource) return
    save({
      id: editing === 'new' ? crypto.randomUUID() : editing.id,
      // The other language may stay blank: `localized` falls back to this one.
      name: cleanLocalized(draft.name) ?? {},
      url: draftSource.repoUrl,
      branch: draftSource.branch,
    })
  }

  const save = (catalog: CatalogConfig) => {
    const exists = catalogs.some((c) => c.id === catalog.id)
    setCatalogs(
      exists ? catalogs.map((c) => (c.id === catalog.id ? catalog : c)) : [...catalogs, catalog],
      // A catalog just added is the one the user wants to browse.
      exists ? undefined : catalog.id,
    )
    setEditing(null)
  }

  const remove = (catalog: CatalogConfig) => {
    setCatalogs(catalogs.filter((c) => c.id !== catalog.id))
    setDeleting(null)
  }

  const defaultRepo = parseCatalogUrl(DEFAULT_CATALOG_URL)?.repoUrl
  // An entry the user added for the community repo counts: restoring would list it twice.
  const hasDefault = catalogs.some((c) => c.id === DEFAULT_CATALOG_ID || parseCatalogUrl(c.url)?.repoUrl === defaultRepo)

  return (
    <>
      <DialogShell
        open={open}
        // In the form, Cancel and Esc step back to the list rather than closing it.
        onOpenChange={(next) => { if (!next && editing) setEditing(null); else onOpenChange(next) }}
        kind="settings"
        title={editing === 'new' ? t('catalog.sources_add_title') : editing ? t('catalog.sources_edit_title') : t('catalog.sources_title')}
        description={editing ? undefined : t('catalog.sources_description')}
        onConfirm={editing ? submit : undefined}
        confirmLabel={editing === 'new' ? t('common.add') : t('common.save')}
        confirmDisabled={!draftSource}
        cancelLabel={editing ? t('common.cancel') : t('common.close')}
        footerExtra={
          !editing && !hasDefault ? (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1"
              onClick={() => setCatalogs([DEFAULT_CATALOG, ...catalogs], DEFAULT_CATALOG_ID)}
            >
              <RotateCcw size={14} />
              {t('catalog.sources_restore_default')}
            </Button>
          ) : undefined
        }
      >
        {editing ? (
          <CatalogSourceForm draft={draft} onChange={setDraft} invalidUrl={invalidUrl} duplicate={duplicate} />
        ) : (
          <div className="space-y-3">
            {catalogs.length === 0 ? (
              <EmptyState icon={Store} title={t('catalog.sources_empty')} />
            ) : (
              <ul className="divide-y rounded-md border">
                {catalogs.map((catalog) => (
                  <li key={catalog.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {localized(catalog.name, language) || catalog.url}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground" title={catalog.url}>
                        {catalog.url}
                        {catalog.branch !== DEFAULT_CATALOG_BRANCH && ` @ ${catalog.branch}`}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('common.edit')}
                      onClick={() => startEditing(catalog)}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={t('common.delete')}
                      onClick={() => setDeleting(catalog)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Button size="sm" variant="outline" className="gap-1" onClick={() => startEditing('new')}>
              <Plus size={14} />
              {t('catalog.sources_add')}
            </Button>
          </div>
        )}
      </DialogShell>

      <AlertDialog open={!!deleting} onOpenChange={(next) => { if (!next) setDeleting(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('catalog.sources_delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('catalog.sources_delete_description', { name: localized(deleting?.name, language) || deleting?.url })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => deleting && remove(deleting)}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

interface CatalogDraft {
  name: LocalizedString
  url: string
  branch: string
}

function draftOf(initial: CatalogConfig | null, language: string): CatalogDraft {
  return {
    // One field, edited in the active language like every other multilingual name;
    // seeded once so an untranslated catalog starts from its other-language name.
    name: seedLocalizedForEditing(initial?.name, language),
    url: initial?.url ?? '',
    branch: initial?.branch ?? DEFAULT_CATALOG_BRANCH,
  }
}

/** The draft as a catalog to save, or null while it cannot be saved. */
function validateDraft(draft: CatalogDraft, takenUrls: string[], language: string) {
  const source = parseCatalogUrl(draft.url, draft.branch)
  const invalidUrl = draft.url.trim().length > 0 && !source
  const duplicate = !!source && takenUrls.some((u) => parseCatalogUrl(u)?.repoUrl === source.repoUrl)
  const canSave = !!source && !duplicate && localizedRaw(draft.name, language).trim() !== ''
  return { source: canSave ? source : null, invalidUrl, duplicate }
}

function CatalogSourceForm({
  draft,
  onChange,
  invalidUrl,
  duplicate,
}: {
  draft: CatalogDraft
  onChange: (draft: CatalogDraft) => void
  invalidUrl: boolean
  duplicate: boolean
}) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)

  return (
    <div className="space-y-4">
      <FormField label={t('common.name')} required>
        {({ id }) => (
          <Input
            id={id}
            value={localizedRaw(draft.name, language)}
            onChange={(e) => onChange({ ...draft, name: setLocalized(draft.name, language, e.target.value) })}
            autoFocus
          />
        )}
      </FormField>
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <FormField label={t('catalog.settings_url')} required hint={t('catalog.sources_url_hint')}>
          {({ id }) => (
            <Input
              id={id}
              value={draft.url}
              onChange={(e) => onChange({ ...draft, url: e.target.value })}
              placeholder={DEFAULT_CATALOG_URL}
              aria-invalid={invalidUrl || duplicate}
            />
          )}
        </FormField>
        <FormField label={t('catalog.settings_branch')} className="self-end">
          {({ id }) => (
            <Input
              id={id}
              value={draft.branch}
              onChange={(e) => onChange({ ...draft, branch: e.target.value })}
              placeholder={DEFAULT_CATALOG_BRANCH}
            />
          )}
        </FormField>
      </div>
      {invalidUrl && <p className="text-xs text-destructive">{t('catalog.settings_invalid_url')}</p>}
      {duplicate && <p className="text-xs text-destructive">{t('catalog.sources_duplicate')}</p>}
    </div>
  )
}
