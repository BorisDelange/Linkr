import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  EntityLicensePanel,
  EntityReadmePanel,
  type AttachmentOwner,
} from '@/components/ui/entity-docs-panels'
import type { EntityLicense, LocalizedString } from '@/types'

export type DocsTab = 'readme' | 'license'

export interface EntityDocsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: DocsTab
  /** Entity name, shown in the dialog description so the user knows what they document. */
  entityName?: string
  readme: LocalizedString | string | undefined
  onSaveReadme: (readme: LocalizedString) => void | Promise<void>
  license: EntityLicense | null | undefined
  onSaveLicense: (license: EntityLicense | null) => void | Promise<void>
  canEdit?: boolean
  /** Owner of the README image attachments. */
  attachmentOwner?: AttachmentOwner
  copyrightHolder?: string
}

/**
 * README + license of one entity, in the same editors the project and workspace
 * pages use. Reachable from the header badge and every card's "..." menu, so an
 * entity can be documented without a page of its own.
 *
 * Both values are held locally after a save: callers pass a snapshot of the entity
 * (menu items capture the item they were rendered with), which would otherwise
 * show the pre-save content until the list re-renders.
 */
export function EntityDocsDialog({
  open,
  onOpenChange,
  initialTab = 'readme',
  entityName,
  readme,
  onSaveReadme,
  license,
  onSaveLicense,
  canEdit = true,
  attachmentOwner,
  copyrightHolder,
}: EntityDocsDialogProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<DocsTab>(initialTab)
  const [localReadme, setLocalReadme] = useState(readme)
  const [localLicense, setLocalLicense] = useState(license)

  useEffect(() => {
    if (open) {
      setTab(initialTab)
      setLocalReadme(readme)
      setLocalLicense(license)
    }
    // Seed from props only when the dialog opens: re-syncing on every prop change
    // would clobber a just-saved value with the caller's stale snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleSaveReadme = async (next: LocalizedString) => {
    setLocalReadme(next)
    await onSaveReadme(next)
  }

  const handleSaveLicense = async (next: EntityLicense | null) => {
    setLocalLicense(next)
    await onSaveLicense(next)
  }

  return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex h-[90vh] max-h-[90vh] flex-col sm:max-w-5xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t('entity_docs.title')}</DialogTitle>
            <DialogDescription>
              {entityName ? t('entity_docs.description_named', { name: entityName }) : t('entity_docs.description')}
            </DialogDescription>
          </DialogHeader>

          <Tabs value={tab} onValueChange={(v) => setTab(v as DocsTab)} className="flex min-h-0 flex-1 flex-col">
            {/* -ml-[11px] cancels the list's p-[3px] + the trigger's px-2, so the
                first tab's label lines up with the dialog title above it. */}
            <TabsList variant="line" className="-ml-[11px] shrink-0">
              <TabsTrigger value="readme">{t('summary.tab_readme')}</TabsTrigger>
              <TabsTrigger value="license">{t('license.title')}</TabsTrigger>
            </TabsList>

            <TabsContent value="readme" className="min-h-0 flex-1 overflow-hidden">
              <EntityReadmePanel
                readme={localReadme}
                onSave={handleSaveReadme}
                canEdit={canEdit}
                attachmentOwner={attachmentOwner}
              />
            </TabsContent>

            <TabsContent value="license" className="min-h-0 flex-1 overflow-hidden">
              <EntityLicensePanel
                license={localLicense}
                onSave={handleSaveLicense}
                copyrightHolder={copyrightHolder}
                canEdit={canEdit}
              />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
  )
}
