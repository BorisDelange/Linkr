import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTallestPanel } from '@/hooks/use-tallest-panel'

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
  /** Controlled selection, for a dialog that needs to jump to a tab itself
   *  (e.g. sending the user to the tab holding a missing field). Uncontrolled
   *  when omitted. */
  value?: string
  onValueChange?: (value: string) => void
}

export function EntityDialogTabs({
  general,
  metadata,
  attribution,
  extraTabs = [],
  generalIncomplete,
  value,
  onValueChange,
}: EntityDialogTabsProps) {
  const { t } = useTranslation()
  const [uncontrolled, setUncontrolled] = useState('general')
  const tab = value ?? uncontrolled
  const setTab = onValueChange ?? setUncontrolled

  const { containerProps, measuredPanelProps } = useTallestPanel()

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
      {/* The dialog is sized to the tallest tab from the start, so switching never
          moves the triggers out from under the pointer — not even on the first
          visit to a taller tab.

          Every panel is rendered, but the inactive ones only inside a zero-height
          measuring layer: `absolute` takes them out of the flow and `invisible`
          hides them along with anything positioned inside them (a file drop zone
          would otherwise escape a plain hidden panel and show through). They are
          `inert`, so nothing in there takes focus or reaches a screen reader. */}
      <div className="relative pt-3" {...containerProps}>
        <div {...measuredPanelProps(tab)} className="flex flex-col gap-4">
          {tabs.find((tb) => tb.value === tab)?.content}
        </div>
        {tabs.filter((tb) => tb.value !== tab).map((tb) => (
          <div
            key={tb.value}
            aria-hidden
            inert
            {...measuredPanelProps(tb.value)}
            // Absolute so it lays out at its natural height without adding any,
            // invisible so neither it nor anything positioned inside it paints.
            className="pointer-events-none invisible absolute inset-x-0 top-3 flex flex-col gap-4"
          >
            {tb.content}
          </div>
        ))}
      </div>
    </Tabs>
  )
}
