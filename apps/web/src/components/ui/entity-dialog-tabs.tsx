import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

/**
 * The tab frame every entity create/edit dialog wears, so a project, an ETL
 * pipeline and a catalog are laid out identically:
 *
 * - **General**   what names the entity: name, identifier, description.
 * - **Metadata**  what situates it: status, badges, version.
 * - **Attribution** who made it. Editing only — on create the author is the
 *   current user and there is nothing to re-attribute yet.
 *
 * Dialogs with a domain tab of their own (the mapping project's Source) pass it
 * through `extraTabs`, which slots in right after General.
 *
 * Triggers stretch to fill the row (`flex-1`), which is what centres the labels;
 * a dialog is narrow enough that left-aligned tabs read as an unfinished row.
 */
export interface EntityDialogTab {
  value: string
  label: string
  content: ReactNode
  /** Dot on the trigger, for a tab holding a required field that is still empty. */
  incomplete?: boolean
}

interface EntityDialogTabsProps {
  general: ReactNode
  metadata: ReactNode
  /** Omit on create: there is no prior authorship to show. */
  attribution?: ReactNode
  /** Domain tabs, inserted between General and Metadata. */
  extraTabs?: EntityDialogTab[]
  /** Marks the General trigger, for a required field left empty. */
  generalIncomplete?: boolean
}

export function EntityDialogTabs({
  general,
  metadata,
  attribution,
  extraTabs = [],
  generalIncomplete,
}: EntityDialogTabsProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState('general')

  const tabs: EntityDialogTab[] = [
    { value: 'general', label: t('common.tab_general'), content: general, incomplete: generalIncomplete },
    ...extraTabs,
    { value: 'metadata', label: t('common.tab_metadata'), content: metadata },
    ...(attribution
      ? [{ value: 'attribution', label: t('common.tab_attribution'), content: attribution }]
      : []),
  ]

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="w-full">
        {tabs.map((tb) => (
          <TabsTrigger key={tb.value} value={tb.value} className="flex-1 gap-1.5">
            {tb.label}
            {tb.incomplete && <span className="size-1.5 rounded-full bg-destructive" />}
          </TabsTrigger>
        ))}
      </TabsList>
      {/* The grid stacks every panel in one cell, so the dialog is always as tall as
          its tallest tab and switching never moves the triggers out from under the
          cursor. Inactive panels stay mounted but inert: `invisible` keeps them
          filling the cell (unlike `hidden`), and they must not take focus or be
          announced while hidden. */}
      <div className="grid pt-3">
        {tabs.map((tb) => {
          const active = tb.value === tab
          return (
            <div
              key={tb.value}
              role="tabpanel"
              aria-hidden={!active}
              inert={!active || undefined}
              className={cn(
                'col-start-1 row-start-1 flex flex-col gap-4',
                !active && 'invisible',
              )}
            >
              {tb.content}
            </div>
          )
        })}
      </div>
    </Tabs>
  )
}
