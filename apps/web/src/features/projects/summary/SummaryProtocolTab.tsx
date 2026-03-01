import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Pencil,
  Check,
  X,
  History,
  BookOpen,
  Target,
  FlaskConical,
  Users,
  Variable,
  BarChart3,
  Shield,
  Calendar,
  BookMarked,
  LayoutList,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/stores/app-store'
import type { StudyProtocol } from '@/types'
import { createDefaultProtocol } from './protocol/protocol-helpers'
import { MarkdownSectionField } from './protocol/MarkdownSectionField'
import { ObjectivesSection } from './protocol/ObjectivesSection'
import { StudyDesignSection } from './protocol/StudyDesignSection'
import { CriteriaListSection } from './protocol/CriteriaListSection'
import { VariablesSection } from './protocol/VariablesSection'
import { TimelineSection } from './protocol/TimelineSection'
import { ReferencesSection } from './protocol/ReferencesSection'
import { CustomSectionsManager } from './protocol/CustomSectionsManager'

type ViewMode = 'view' | 'edit'

interface SummaryProtocolTabProps {
  uid: string
}

interface SectionDef {
  id: string
  labelKey: string
  icon: React.ReactNode
  badge?: (p: StudyProtocol) => string | undefined
}

export function SummaryProtocolTab({ uid }: SummaryProtocolTabProps) {
  const { t } = useTranslation()
  const { _projectsRaw, updateProjectProtocol, language } = useAppStore()
  const project = _projectsRaw.find((p) => p.uid === uid)
  const storedProtocol = useMemo(
    () => project?.protocol ?? createDefaultProtocol(),
    [project?.protocol],
  )

  const [mode, setMode] = useState<ViewMode>('view')
  const [localProtocol, setLocalProtocol] = useState<StudyProtocol>(storedProtocol)
  const [activeSection, setActiveSection] = useState('scientific_context')

  // Sync local state when store changes while not editing
  useEffect(() => {
    if (mode !== 'edit') setLocalProtocol(storedProtocol)
  }, [storedProtocol, mode])

  const handleSave = useCallback(() => {
    updateProjectProtocol(uid, { ...localProtocol, updatedAt: new Date().toISOString() })
    setMode('view')
  }, [uid, localProtocol, updateProjectProtocol])

  const handleCancel = () => {
    setLocalProtocol(storedProtocol)
    setMode('view')
  }

  // Cmd/Ctrl+S to save in edit mode
  useEffect(() => {
    if (mode !== 'edit') return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [mode, handleSave])

  const handleChange = useCallback(
    (changes: Partial<StudyProtocol>) => {
      setLocalProtocol((prev) => ({ ...prev, ...changes }))
    },
    [],
  )

  // Use the right protocol for display: local when editing, stored when viewing
  const protocol = mode === 'edit' ? localProtocol : storedProtocol
  const editing = mode === 'edit'

  const totalCriteria =
    protocol.inclusionCriteria.length +
    protocol.nonInclusionCriteria.length +
    protocol.exclusionCriteria.length

  const sections: SectionDef[] = [
    { id: 'scientific_context', labelKey: 'protocol.section_scientific_context', icon: <BookOpen size={14} /> },
    { id: 'objectives', labelKey: 'protocol.section_objectives', icon: <Target size={14} /> },
    { id: 'study_design', labelKey: 'protocol.section_study_design', icon: <FlaskConical size={14} /> },
    {
      id: 'population', labelKey: 'protocol.section_population', icon: <Users size={14} />,
      badge: (p) => {
        const n = p.inclusionCriteria.length + p.nonInclusionCriteria.length + p.exclusionCriteria.length
        return n > 0 ? String(n) : undefined
      },
    },
    {
      id: 'variables', labelKey: 'protocol.section_variables', icon: <Variable size={14} />,
      badge: (p) => p.variables.length > 0 ? String(p.variables.length) : undefined,
    },
    { id: 'statistical_analysis', labelKey: 'protocol.section_statistical_analysis', icon: <BarChart3 size={14} /> },
    { id: 'ethics', labelKey: 'protocol.section_ethics', icon: <Shield size={14} /> },
    {
      id: 'timeline', labelKey: 'protocol.section_timeline', icon: <Calendar size={14} />,
      badge: (p) => p.timelinePhases.length > 0 ? String(p.timelinePhases.length) : undefined,
    },
    {
      id: 'references', labelKey: 'protocol.section_references', icon: <BookMarked size={14} />,
      badge: (p) => p.references.length > 0 ? String(p.references.length) : undefined,
    },
    {
      id: 'custom', labelKey: 'protocol.section_custom', icon: <LayoutList size={14} />,
      badge: (p) => p.customSections.length > 0 ? String(p.customSections.length) : undefined,
    },
  ]

  return (
    <div className="flex h-full flex-col pt-2">
      {/* Header bar */}
      <div className="flex shrink-0 items-center justify-between">
        <h2 className="text-xs font-semibold uppercase text-muted-foreground">
          {t('protocol.title')}
        </h2>
        <div className="flex items-center gap-1">
          {mode === 'edit' ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-2 text-xs text-muted-foreground"
                onClick={handleCancel}
              >
                <X size={12} />
                {t('common.cancel')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-2 text-xs text-primary"
                onClick={handleSave}
              >
                <Check size={12} />
                {t('common.save')}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled
                title={t('common.server_only')}
                className="h-5 px-2 text-xs text-muted-foreground"
              >
                <History size={12} />
                {t('summary.history')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-2 text-xs text-muted-foreground"
                onClick={() => setMode('edit')}
              >
                <Pencil size={12} />
                {t('summary.edit')}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Sidebar + Content */}
      <div className="mt-3 flex min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-sm">
        {/* Sidebar */}
        <nav className="flex w-48 shrink-0 flex-col overflow-y-auto border-r bg-muted/20 py-1">
          {sections.map((s) => {
            const badge = s.badge?.(protocol)
            const isActive = activeSection === s.id
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveSection(s.id)}
                className={`flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  isActive
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                }`}
              >
                <span className="shrink-0">{s.icon}</span>
                <span className="flex-1 truncate">{t(s.labelKey)}</span>
                {badge && (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                    {badge}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        {/* Content pane */}
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <SectionContent
            sectionId={activeSection}
            protocol={protocol}
            onChange={handleChange}
            editing={editing}
            language={language}
            workspaceId={project?.workspaceId}
          />
        </div>
      </div>
    </div>
  )
}

/** Renders the content for the currently active section. */
function SectionContent({
  sectionId,
  protocol,
  onChange,
  editing,
  language,
  workspaceId,
}: {
  sectionId: string
  protocol: StudyProtocol
  onChange: (changes: Partial<StudyProtocol>) => void
  editing: boolean
  language: string
  workspaceId?: string
}) {
  const { t } = useTranslation()

  switch (sectionId) {
    case 'scientific_context':
      return (
        <MarkdownSectionField
          value={protocol.scientificContext ?? ''}
          onChange={(v) => onChange({ scientificContext: v })}
          placeholder={t('protocol.scientific_context_placeholder')}
          editing={editing}
          fill
        />
      )

    case 'objectives':
      return <div className="min-h-0 flex-1 overflow-y-auto"><ObjectivesSection protocol={protocol} onChange={onChange} editing={editing} /></div>

    case 'study_design':
      return <div className="min-h-0 flex-1 overflow-y-auto"><StudyDesignSection protocol={protocol} onChange={onChange} editing={editing} /></div>

    case 'population':
      return (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          <CriteriaListSection
            title={t('protocol.inclusion_criteria')}
            criteria={protocol.inclusionCriteria}
            onChange={(c) => onChange({ inclusionCriteria: c })}
            editing={editing}
          />
          <CriteriaListSection
            title={t('protocol.non_inclusion_criteria')}
            criteria={protocol.nonInclusionCriteria}
            onChange={(c) => onChange({ nonInclusionCriteria: c })}
            editing={editing}
          />
          <CriteriaListSection
            title={t('protocol.exclusion_criteria')}
            criteria={protocol.exclusionCriteria}
            onChange={(c) => onChange({ exclusionCriteria: c })}
            editing={editing}
          />
        </div>
      )

    case 'variables':
      return (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <VariablesSection
            protocol={protocol}
            onChange={onChange}
            editing={editing}
            language={language}
            workspaceId={workspaceId}
          />
        </div>
      )

    case 'statistical_analysis':
      return (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <MarkdownSectionField value={protocol.primaryAnalysis ?? ''} onChange={(v) => onChange({ primaryAnalysis: v })} placeholder={t('protocol.primary_analysis_placeholder')} editing={editing} label={t('protocol.primary_analysis')} />
          <MarkdownSectionField value={protocol.secondaryAnalyses ?? ''} onChange={(v) => onChange({ secondaryAnalyses: v })} placeholder={t('protocol.secondary_analyses_placeholder')} editing={editing} label={t('protocol.secondary_analyses')} />
          <MarkdownSectionField value={protocol.subgroupAnalyses ?? ''} onChange={(v) => onChange({ subgroupAnalyses: v })} placeholder={t('protocol.subgroup_analyses_placeholder')} editing={editing} label={t('protocol.subgroup_analyses')} />
          <MarkdownSectionField value={protocol.missingDataHandling ?? ''} onChange={(v) => onChange({ missingDataHandling: v })} placeholder={t('protocol.missing_data_placeholder')} editing={editing} label={t('protocol.missing_data')} />
          <MarkdownSectionField value={protocol.sampleSizeCalculation ?? ''} onChange={(v) => onChange({ sampleSizeCalculation: v })} placeholder={t('protocol.sample_size_placeholder')} editing={editing} label={t('protocol.sample_size')} />
        </div>
      )

    case 'ethics':
      return (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <MarkdownSectionField value={protocol.ethicsApproval ?? ''} onChange={(v) => onChange({ ethicsApproval: v })} placeholder={t('protocol.ethics_approval_placeholder')} editing={editing} label={t('protocol.ethics_approval')} />
          <MarkdownSectionField value={protocol.consent ?? ''} onChange={(v) => onChange({ consent: v })} placeholder={t('protocol.consent_placeholder')} editing={editing} label={t('protocol.consent')} />
          <MarkdownSectionField value={protocol.dataProtection ?? ''} onChange={(v) => onChange({ dataProtection: v })} placeholder={t('protocol.data_protection_placeholder')} editing={editing} label={t('protocol.data_protection')} />
          <MarkdownSectionField value={protocol.regulatoryReferences ?? ''} onChange={(v) => onChange({ regulatoryReferences: v })} placeholder={t('protocol.regulatory_references_placeholder')} editing={editing} label={t('protocol.regulatory_references')} />
        </div>
      )

    case 'timeline':
      return <div className="min-h-0 flex-1 overflow-y-auto"><TimelineSection protocol={protocol} onChange={onChange} editing={editing} /></div>

    case 'references':
      return <div className="min-h-0 flex-1 overflow-y-auto"><ReferencesSection protocol={protocol} onChange={onChange} editing={editing} /></div>

    case 'custom':
      return <div className="min-h-0 flex-1 overflow-y-auto"><CustomSectionsManager protocol={protocol} onChange={onChange} editing={editing} language={language} /></div>

    default:
      return null
  }
}
