import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { DialogShell } from '@/components/ui/dialog-shell'
import { getConceptSetI18n } from '@/lib/concept-mapping/i18n'
import { paths } from '@/lib/paths'
import { getStorage } from '@/lib/storage'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import type { ConceptSet, DataDictionary, MappingProject } from '@/types'

interface PickConceptSetsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: MappingProject
}

interface Row {
  set: ConceptSet
  name: string
  dictionary: string
  category: string
}

/**
 * Add concept sets to a mapping project from the workspace's data dictionaries.
 * The sets themselves are managed (imported, updated) in the workspace settings;
 * a project only picks which ones it maps onto.
 */
export function PickConceptSetsDialog({ open, onOpenChange, project }: PickConceptSetsDialogProps) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const conceptSets = useConceptMappingStore((s) => s.conceptSets)
  const updateMappingProject = useConceptMappingStore((s) => s.updateMappingProject)
  const [dictionaries, setDictionaries] = useState<DataDictionary[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [visible, setVisible] = useState<Row[]>([])

  useEffect(() => {
    if (!open) return
    setPicked(new Set())
    getStorage().dataDictionaries.getByWorkspace(project.workspaceId).then(setDictionaries).catch(() => setDictionaries([]))
  }, [open, project.workspaceId])

  const already = useMemo(() => new Set(project.conceptSetIds ?? []), [project.conceptSetIds])
  const rows = useMemo<Row[]>(() => {
    const names = new Map(dictionaries.map((d) => [d.id, d.name]))
    return conceptSets
      .filter((s) => s.workspaceId === project.workspaceId && !already.has(s.id))
      .map((set) => {
        const tr = getConceptSetI18n(set, i18n.language)
        return {
          set,
          name: tr.name,
          dictionary: (set.dictionaryId && names.get(set.dictionaryId)) || t('data_dictionaries.local_name'),
          category: tr.category ?? '',
        }
      })
  }, [conceptSets, dictionaries, project.workspaceId, already, i18n.language, t])

  const columns = useMemo<DataTableColumn<Row>[]>(() => [
    {
      id: 'pick',
      header: t('common.select_all'),
      headerCell: () => {
        const n = visible.filter((r) => picked.has(r.set.id)).length
        return (
          <Checkbox
            checked={n > 0 && n === visible.length ? true : n > 0 ? 'indeterminate' : false}
            disabled={visible.length === 0}
            aria-label={t('common.select_all')}
            onCheckedChange={() => setPicked((prev) => {
              const next = new Set(prev)
              const all = n === visible.length
              for (const r of visible) {
                if (all) next.delete(r.set.id)
                else next.add(r.set.id)
              }
              return next
            })}
          />
        )
      },
      size: 36,
      sortable: false,
      accessor: (r) => (picked.has(r.set.id) ? 1 : 0),
      cell: (r) => (
        <Checkbox
          checked={picked.has(r.set.id)}
          onCheckedChange={() => setPicked((prev) => {
            const next = new Set(prev)
            if (next.has(r.set.id)) next.delete(r.set.id)
            else next.add(r.set.id)
            return next
          })}
        />
      ),
    },
    { id: 'name', header: t('common.name'), accessor: (r) => r.name, filter: 'text', size: 320 },
    { id: 'category', header: t('concept_mapping.col_category'), accessor: (r) => r.category, filter: 'select', size: 180 },
    { id: 'dictionary', header: t('data_dictionaries.title'), accessor: (r) => r.dictionary, filter: 'select', size: 180 },
    { id: 'version', header: t('common.version'), accessor: (r) => r.set.version ?? '', size: 80 },
  ], [picked, visible, t])

  const add = async () => {
    if (picked.size === 0) return
    setBusy(true)
    try {
      await updateMappingProject(project.id, { conceptSetIds: [...(project.conceptSetIds ?? []), ...picked] })
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="workbench"
      title={t('concept_mapping.cs_pick_title')}
      description={t('concept_mapping.cs_pick_description')}
      onConfirm={add}
      confirmLabel={t('concept_mapping.cs_pick_confirm', { count: picked.size })}
      confirmDisabled={picked.size === 0}
      busy={busy}
      footerExtra={
        <Button variant="ghost" size="sm" onClick={() => navigate(paths.workspaceSettings(project.workspaceId, 'dictionaries'))}>
          <Settings2 size={14} />
          {t('concept_mapping.cs_manage_dictionaries')}
        </Button>
      }
    >
      <DataTable
        data={rows}
        columns={columns}
        rowKey={(r) => r.set.id}
        pageSize={100}
        initialSorting={{ columnId: 'name', desc: false }}
        viewKey="pick-concept-sets"
        onVisibleRowsChange={setVisible}
        emptyMessage={t('concept_mapping.cs_pick_empty')}
      />
    </DialogShell>
  )
}
