import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw, Save, Store } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DEFAULT_CATALOG_BRANCH, DEFAULT_CATALOG_URL, parseCatalogUrl } from '@/lib/catalog/remote'
import {
  loadCatalogSettings,
  resetCatalogSettings,
  saveCatalogSettings,
} from '@/lib/catalog/settings'

/**
 * Points the Catalog page at a different index repo — e.g. a hospital's internal
 * catalog. Any GitLab instance works; the default is the community catalog.
 *
 * Changing the source clears the cached entries (in saveCatalogSettings), since entries
 * from the previous catalog must not be diffed against the new one.
 */
export function CatalogSettingsTab() {
  const { t } = useTranslation()
  const initial = loadCatalogSettings()
  const [url, setUrl] = useState(initial.url)
  const [branch, setBranch] = useState(initial.branch)
  const [saved, setSaved] = useState(false)

  const invalid = url.trim().length > 0 && !parseCatalogUrl(url, branch)
  const dirty = url !== initial.url || branch !== initial.branch

  const handleSave = () => {
    if (invalid) return
    saveCatalogSettings(url, branch)
    setSaved(true)
  }

  const handleReset = () => {
    resetCatalogSettings()
    setUrl(DEFAULT_CATALOG_URL)
    setBranch(DEFAULT_CATALOG_BRANCH)
    setSaved(true)
  }

  return (
    <Card className="mt-4">
      <CardContent className="px-5 pb-5 pt-5">
        <div className="flex items-start gap-2">
          <Store size={18} className="mt-0.5 shrink-0 text-violet-500" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{t('catalog.settings_title')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('catalog.settings_description')}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_10rem]">
          <div className="space-y-1.5">
            <Label htmlFor="catalog-url">{t('catalog.settings_url')}</Label>
            <Input
              id="catalog-url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setSaved(false) }}
              placeholder={DEFAULT_CATALOG_URL}
              aria-invalid={invalid}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="catalog-branch">{t('catalog.settings_branch')}</Label>
            <Input
              id="catalog-branch"
              value={branch}
              onChange={(e) => { setBranch(e.target.value); setSaved(false) }}
              placeholder={DEFAULT_CATALOG_BRANCH}
            />
          </div>
        </div>

        {invalid && <p className="mt-2 text-xs text-destructive">{t('catalog.settings_invalid_url')}</p>}
        {saved && !dirty && <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{t('catalog.settings_saved')}</p>}

        <div className="mt-4 flex items-center gap-2">
          <Button size="sm" className="gap-1 text-xs" onClick={handleSave} disabled={invalid || !dirty}>
            <Save size={14} />
            {t('common.save')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1 text-xs"
            onClick={handleReset}
            disabled={url === DEFAULT_CATALOG_URL && branch === DEFAULT_CATALOG_BRANCH}
          >
            <RotateCcw size={14} />
            {t('catalog.settings_reset')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
