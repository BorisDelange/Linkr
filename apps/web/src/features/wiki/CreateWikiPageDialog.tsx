import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FileText,
  ClipboardList,
  BookOpen,
  UserCheck,
  Users,
  HelpCircle,
  FlaskConical,
  Newspaper,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { IconPicker } from '@/components/ui/icon-picker'
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'
import { useWikiStore } from '@/stores/wiki-store'

interface CreateWikiPageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  parentId: string | null
}

interface WikiTemplate {
  id: string
  labelKey: string
  icon: React.ReactNode
  content: string
}

const TEMPLATES: WikiTemplate[] = [
  {
    id: 'blank',
    labelKey: 'wiki.template_blank',
    icon: <FileText size={16} />,
    content: '',
  },
  {
    id: 'sop',
    labelKey: 'wiki.template_sop',
    icon: <ClipboardList size={16} />,
    content: `## Objective

Describe the purpose of this procedure.

## Scope

Who does this apply to and when.

## Responsibilities

| Role | Responsibility |
| --- | --- |
| | |

## Procedure

1. Step one
2. Step two
3. Step three

> [!IMPORTANT]
> Critical steps or safety information here.

## Revision History

| Version | Date | Author | Changes |
| --- | --- | --- | --- |
| 1.0 | ${new Date().toISOString().split('T')[0]} | | Initial version |
`,
  },
  {
    id: 'data-dictionary',
    labelKey: 'wiki.template_data_dictionary',
    icon: <BookOpen size={16} />,
    content: `## Overview

Brief description of the dataset/table.

## Variables

| Variable | Type | Description | Values | Source |
| --- | --- | --- | --- | --- |
| patient_id | integer | Unique patient identifier | | person table |
| | | | | |

## Notes

Additional context or transformation rules.
`,
  },
  {
    id: 'onboarding',
    labelKey: 'wiki.template_onboarding',
    icon: <UserCheck size={16} />,
    content: `## Welcome!

Welcome to the team. This guide will help you get started.

## Day 1 Checklist

- [ ] Get access credentials
- [ ] Set up your development environment
- [ ] Read the data warehouse documentation
- [ ] Meet the team

## Week 1

- [ ] Complete the introductory training
- [ ] Run your first query
- [ ] Familiarize yourself with existing projects

## Key Contacts

| Name | Role | Email |
| --- | --- | --- |
| | | |

## Useful Links

- [Data Warehouse Documentation]()
- [Code Repository]()
- [Team Calendar]()
`,
  },
  {
    id: 'meeting-notes',
    labelKey: 'wiki.template_meeting_notes',
    icon: <Users size={16} />,
    content: `## Meeting — ${new Date().toISOString().split('T')[0]}

**Participants:**

**Agenda:**
1.
2.
3.

## Decisions

-

## Action Items

- [ ] **@person** — Task description — Due: YYYY-MM-DD

## Notes

`,
  },
  {
    id: 'faq',
    labelKey: 'wiki.template_faq',
    icon: <HelpCircle size={16} />,
    content: `## Frequently Asked Questions

<details>
<summary>Question 1?</summary>

Answer to question 1.

</details>

<details>
<summary>Question 2?</summary>

Answer to question 2.

</details>

<details>
<summary>Question 3?</summary>

Answer to question 3.

</details>
`,
  },
  {
    id: 'study-protocol',
    labelKey: 'wiki.template_protocol',
    icon: <FlaskConical size={16} />,
    content: `## Background

Brief literature review and rationale.

## Objectives

### Primary Objective
-

### Secondary Objectives
-

## Methods

### Study Design

### Population

**Inclusion Criteria:**
1.
2.

**Exclusion Criteria:**
1.
2.

### Endpoints

| Endpoint | Type | Measure | Timeframe |
| --- | --- | --- | --- |
| | Primary | | |
| | Secondary | | |

### Statistical Analysis Plan

$$
n = \\frac{(Z_{\\alpha/2} + Z_\\beta)^2 \\cdot 2\\sigma^2}{\\delta^2}
$$

## Ethics

## Timeline

\`\`\`mermaid
gantt
    title Study Timeline
    dateFormat  YYYY-MM-DD
    section Protocol
    Design           :a1, 2024-01-01, 90d
    Ethics approval  :a2, after a1, 60d
    section Data Collection
    Recruitment      :b1, after a2, 180d
    Follow-up        :b2, after b1, 90d
    section Analysis
    Data analysis    :c1, after b2, 60d
    Publication      :c2, after c1, 90d
\`\`\`

## References
`,
  },
  {
    id: 'article',
    labelKey: 'wiki.template_article',
    icon: <Newspaper size={16} />,
    content: `## Title

## Affiliations

1. **Department, Institution, City, Country**
2.

**Corresponding author:** Name, email

## Abstract

**Background:**

**Methods:**

**Results:**

**Conclusion:**

**Keywords:**

## Introduction

## Methods

## Results

## Discussion

## Conclusion

## References
`,
  },
]

export function CreateWikiPageDialog({
  open,
  onOpenChange,
  workspaceId,
  parentId,
}: CreateWikiPageDialogProps) {
  const { t } = useTranslation()
  const { addPage, setActivePage, pages } = useWikiStore()
  const [title, setTitle] = useState('')
  const [entityId, setEntityId] = useState('')
  const [icon, setIcon] = useState('FileText')
  const [selectedTemplate, setSelectedTemplate] = useState('blank')

  const existingIds = pages.map(p => p.entityId).filter((id): id is string => !!id)

  const handleCreate = async () => {
    if (!title.trim() || !isEntityIdValid(entityId, existingIds)) return
    const template = TEMPLATES.find((tpl) => tpl.id === selectedTemplate)
    const id = await addPage({
      workspaceId,
      parentId,
      title: title.trim(),
      entityId: entityId || undefined,
      content: template?.content ?? '',
      icon: icon || undefined,
      template: selectedTemplate,
    })
    setActivePage(id)
    onOpenChange(false)
    setTitle('')
    setEntityId('')
    setIcon('FileText')
    setSelectedTemplate('blank')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('wiki.new_page')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs">{t('wiki.page_title')}</Label>
            <div className="flex items-center gap-2">
              <IconPicker value={icon} onChange={setIcon} modal={false} />
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('wiki.page_title_placeholder')}
                className="h-9 flex-1"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
              />
            </div>
          </div>

          <EntityIdField
            name={title}
            value={entityId}
            onChange={setEntityId}
            existingIds={existingIds}
            htmlId="wiki-page-id"
            placeholder="my-wiki-page"
          />

          <div>
            <Label className="text-xs">{t('wiki.template')}</Label>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => setSelectedTemplate(tpl.id)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                    selectedTemplate === tpl.id
                      ? 'border-primary bg-primary/5 text-primary'
                      : 'border-border hover:bg-accent'
                  }`}
                >
                  <span className="shrink-0 text-muted-foreground">{tpl.icon}</span>
                  <span className="truncate">{t(tpl.labelKey)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={!title.trim() || !isEntityIdValid(entityId, existingIds)}>
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
