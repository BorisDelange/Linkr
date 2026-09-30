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
import { localized } from '@/lib/localized'
import { DEFAULT_CATALOG_BRANCH, DEFAULT_CATALOG_URL, parseCatalogUrl } from '@/lib/catalog/remote'
import { DEFAULT_CATALOG, DEFAULT_CATALOG_ID, type CatalogConfig } from '@/lib/catalog/settings'
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

  const hasDefault = catalogs.some((c) => c.id === DEFAULT_CATALOG_ID)

  return (
    <>
      <DialogShell
        open={open}
        onOpenChange={(next) => { if (!next) setEditing(null); onOpenChange(next) }}
        kind="settings"
        title={editing === 'new' ? t('catalog.sources_add_title') : editing ? t('catalog.sources_edit_title') : t('catalog.sources_title')}
        description={editing ? undefined : t('catalog.sources_description')}
        hideFooter={!!editing}
        cancelLabel={t('common.close')}
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
          <CatalogSourceForm
            initial={editing === 'new' ? null : editing}
            takenUrls={catalogs.filter((c) => editing === 'new' || c.id !== editing.id).map((c) => c.url)}
            onCancel={() => setEditing(null)}
            onSave={save}
          />
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
                      onClick={() => setEditing(catalog)}
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
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setEditing('new')}>
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
              {t('catalog.sources_delete_description', { name: localized(deleting?.name, language) })}
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

function CatalogSourceForm({
  initial,
  takenUrls,
  onCancel,
  onSave,
}: {
  initial: CatalogConfig | null
  /** Repos the other catalogs already point at: a second entry would be the same list twice. */
  takenUrls: string[]
  onCancel: () => void
  onSave: (catalog: CatalogConfig) => void
}) {
  const { t } = useTranslation()
  const [nameEn, setNameEn] = useState(initial?.name.en ?? '')
  const [nameFr, setNameFr] = useState(initial?.name.fr ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [branch, setBranch] = useState(initial?.branch ?? DEFAULT_CATALOG_BRANCH)

  const source = parseCatalogUrl(url, branch)
  const invalidUrl = url.trim().length > 0 && !source
  const duplicate = !!source && takenUrls.some((u) => parseCatalogUrl(u)?.repoUrl === source.repoUrl)
  const canSave = !!source && !duplicate && (nameEn.trim() || nameFr.trim())

  const submit = () => {
    if (!canSave || !source) return
    const en = nameEn.trim()
    const fr = nameFr.trim()
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      // Either language alone is enough: `localized` falls back to the other.
      name: { ...(en ? { en } : {}), ...(fr ? { fr } : {}) },
      url: source.repoUrl,
      branch: source.branch,
    })
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={t('catalog.sources_name_en')}>
          {({ id }) => <Input id={id} value={nameEn} onChange={(e) => setNameEn(e.target.value)} autoFocus />}
        </FormField>
        <FormField label={t('catalog.sources_name_fr')}>
          {({ id }) => <Input id={id} value={nameFr} onChange={(e) => setNameFr(e.target.value)} />}
        </FormField>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <FormField label={t('catalog.settings_url')} required hint={t('catalog.sources_url_hint')}>
          {({ id }) => (
            <Input
              id={id}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={DEFAULT_CATALOG_URL}
              aria-invalid={invalidUrl || duplicate}
            />
          )}
        </FormField>
        <FormField label={t('catalog.settings_branch')} className="self-end">
          {({ id }) => (
            <Input id={id} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={DEFAULT_CATALOG_BRANCH} />
          )}
        </FormField>
      </div>
      {invalidUrl && <p className="text-xs text-destructive">{t('catalog.settings_invalid_url')}</p>}
      {duplicate && <p className="text-xs text-destructive">{t('catalog.sources_duplicate')}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button size="sm" onClick={submit} disabled={!canSave}>
          {initial ? t('common.save') : t('common.add')}
        </Button>
      </div>
    </div>
  )
}
