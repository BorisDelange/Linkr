import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Download, FileText, GitBranch, MoreHorizontal, Scale } from 'lucide-react'
import { TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * The tabs an entity page folds behind the "More" trigger, in display order.
 *
 * 'export' is not one of them: an entity exports as a ZIP download, so selecting
 * it runs the action and leaves the active tab alone. (The concept-mapping page
 * is the exception — Export is a real tab there, so it keeps its own trigger.)
 */
export const ENTITY_SECONDARY_TABS = ['readme', 'license', 'versioning'] as const
export type EntitySecondaryTabId = (typeof ENTITY_SECONDARY_TABS)[number]

export function isEntitySecondaryTab(tab: string): tab is EntitySecondaryTabId {
  return (ENTITY_SECONDARY_TABS as readonly string[]).includes(tab)
}

/**
 * The trailing "More" tab: readme, licence, export and versioning, which every
 * entity page carries but none wants spending a full tab slot on. Selecting one
 * switches tab; Export downloads the entity ZIP instead, so it never becomes the
 * active tab.
 */
export function EntitySecondaryTabsTrigger<T extends string>({
  activeTab,
  onSelect,
  onExport,
}: {
  activeTab: T
  onSelect: (tab: EntitySecondaryTabId) => void
  onExport: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const active = isEntitySecondaryTab(activeTab) ? activeTab : undefined

  const items: { id: EntitySecondaryTabId | 'export'; label: string; icon: typeof FileText }[] = [
    { id: 'readme', label: t('common.readme'), icon: FileText },
    { id: 'license', label: t('license.title'), icon: Scale },
    { id: 'export', label: t('common.export'), icon: Download },
    { id: 'versioning', label: t('common.versioning'), icon: GitBranch },
  ]
  const current = items.find((i) => i.id === active)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <TabsTrigger
          value={active ?? '__secondary__'}
          // TabsTrigger paints "active" from data-state, but DropdownMenuTrigger
          // owns that attribute on a composed trigger and writes open/closed into
          // it. aria-selected stays the tab's own, so drive the styles off that.
          className="aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm"
          // The menu is the point: let it open instead of switching tab.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.preventDefault(); setOpen((v) => !v) }}
        >
          {current ? <current.icon size={14} /> : <MoreHorizontal size={14} />}
          {current ? current.label : t('common.more')}
          <ChevronDown size={12} className="opacity-60" />
        </TabsTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onSelect={() => { if (item.id === 'export') onExport(); else onSelect(item.id) }}
            className={item.id === active ? 'bg-accent' : undefined}
          >
            <item.icon size={14} className="text-muted-foreground" />
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
