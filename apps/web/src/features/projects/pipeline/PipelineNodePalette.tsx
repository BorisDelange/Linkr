import { useTranslation } from 'react-i18next'
import { Database, Code, UsersRound, Table2, LayoutDashboard, Group } from 'lucide-react'
import type { PipelineNodeType } from '@/types'

interface PaletteItem {
  type: PipelineNodeType
  labelKey: string
  descriptionKey: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  iconBgClass: string
  iconColorClass: string
}

const paletteItems: PaletteItem[] = [
  {
    type: 'database',
    labelKey: 'pipeline.node_database',
    descriptionKey: 'pipeline.node_database_desc',
    icon: Database,
    iconBgClass: 'bg-teal-500/20',
    iconColorClass: 'text-teal-600 dark:text-teal-400',
  },
  {
    type: 'cohort',
    labelKey: 'pipeline.node_cohort',
    descriptionKey: 'pipeline.node_cohort_desc',
    icon: UsersRound,
    iconBgClass: 'bg-orange-500/20',
    iconColorClass: 'text-orange-600 dark:text-orange-400',
  },
  {
    type: 'scripts',
    labelKey: 'pipeline.node_scripts',
    descriptionKey: 'pipeline.node_scripts_desc',
    icon: Code,
    iconBgClass: 'bg-blue-500/20',
    iconColorClass: 'text-blue-600 dark:text-blue-400',
  },
  {
    type: 'dataset',
    labelKey: 'pipeline.node_dataset',
    descriptionKey: 'pipeline.node_dataset_desc',
    icon: Table2,
    iconBgClass: 'bg-violet-500/20',
    iconColorClass: 'text-violet-600 dark:text-violet-400',
  },
  {
    type: 'dashboard',
    labelKey: 'pipeline.node_dashboard',
    descriptionKey: 'pipeline.node_dashboard_desc',
    icon: LayoutDashboard,
    iconBgClass: 'bg-amber-500/20',
    iconColorClass: 'text-amber-600 dark:text-amber-400',
  },
  {
    type: 'group',
    labelKey: 'pipeline.node_group',
    descriptionKey: 'pipeline.node_group_desc',
    icon: Group,
    iconBgClass: 'bg-slate-500/20',
    iconColorClass: 'text-slate-600 dark:text-slate-400',
  },
]

interface PipelineNodePaletteProps {
  onAddNode: (type: PipelineNodeType) => void
}

function PaletteItemRow({ item, onAddNode, onDragStart }: {
  item: PaletteItem
  onAddNode: (type: PipelineNodeType) => void
  onDragStart: (e: React.DragEvent, type: PipelineNodeType) => void
}) {
  const { t } = useTranslation()
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, item.type)}
      onClick={() => onAddNode(item.type)}
      className="flex cursor-grab items-center gap-2.5 rounded-lg border border-border/60 bg-muted/50 px-2.5 py-2 transition-colors hover:border-border hover:bg-muted active:cursor-grabbing"
    >
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${item.iconBgClass}`}>
        <item.icon size={14} className={item.iconColorClass} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground">
          {t(item.labelKey)}
        </div>
        <div className="truncate text-[10px] text-muted-foreground">
          {t(item.descriptionKey)}
        </div>
      </div>
    </div>
  )
}

export function PipelineNodePalette({ onAddNode }: PipelineNodePaletteProps) {
  const { t } = useTranslation()

  const onDragStart = (event: React.DragEvent, type: PipelineNodeType) => {
    event.dataTransfer.setData('application/reactflow-node-type', type)
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div className="w-56 shrink-0 border-r border-border bg-card/80 p-3 overflow-auto">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t('pipeline.palette_title')}
      </h3>
      <div className="space-y-1.5">
        {paletteItems.map((item) => (
          <PaletteItemRow
            key={item.type}
            item={item}
            onAddNode={onAddNode}
            onDragStart={onDragStart}
          />
        ))}
      </div>
    </div>
  )
}
