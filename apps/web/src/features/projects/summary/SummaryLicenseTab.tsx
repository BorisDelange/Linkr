import { useAppStore } from '@/stores/app-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { LicenseEditor } from '@/components/editor/LicenseEditor'
import { localized } from '@/lib/localized'

interface SummaryLicenseTabProps {
  uid: string
}

export function SummaryLicenseTab({ uid }: SummaryLicenseTabProps) {
  const canWrite = useMyProjectRole(uid).can('project-summary:write')
  const language = useAppStore((s) => s.language)
  const project = useAppStore((s) => s._projectsRaw.find((p) => p.uid === uid))
  const updateProjectLicense = useAppStore((s) => s.updateProjectLicense)
  const getOrganization = useOrganizationStore((s) => s.getOrganization)

  const org = project?.organization?.name
    ? project.organization
    : project?.organizationId
      ? getOrganization(project.organizationId)
      : undefined

  return (
    <LicenseEditor
      className="flex h-full flex-col pt-4 pb-1.5"
      license={project?.license ?? null}
      onSave={(license) => updateProjectLicense(uid, license)}
      copyrightHolder={localized(org?.name, language)}
      canEdit={canWrite}
    />
  )
}
