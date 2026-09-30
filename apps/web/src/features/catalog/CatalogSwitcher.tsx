import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { localized } from '@/lib/localized'
import { useCatalogSourcesStore } from '@/stores/catalog-sources-store'
import { useAppStore } from '@/stores/app-store'
import { CatalogSourcesDialog } from './CatalogSourcesDialog'

/** Which catalog is browsed, and the gear that opens their configuration. */
export function CatalogSwitcher() {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const catalogs = useCatalogSourcesStore((s) => s.catalogs)
  const activeId = useCatalogSourcesStore((s) => s.activeId)
  const setActive = useCatalogSourcesStore((s) => s.setActive)
  const [managing, setManaging] = useState(false)

  return (
    <div className="flex shrink-0 items-center gap-1">
      {catalogs.length > 0 && (
        <Select value={activeId} onValueChange={setActive}>
          <SelectTrigger className="h-9 w-56" aria-label={t('catalog.sources_select')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {catalogs.map((c) => (
              <SelectItem key={c.id} value={c.id}>{localized(c.name, language) || c.url}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label={t('catalog.sources_manage')}
            onClick={() => setManaging(true)}
          >
            <Settings size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('catalog.sources_manage')}</TooltipContent>
      </Tooltip>
      <CatalogSourcesDialog open={managing} onOpenChange={setManaging} />
    </div>
  )
}
