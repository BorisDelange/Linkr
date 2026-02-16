import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Database, UsersRound, Code, Table2, LayoutDashboard, CheckCircle2, AlertCircle, Loader2, Group } from 'lucide-react'
import type { PipelineNodeData } from '@/types'

// --- Status indicator ---

function StatusIcon({ status }: { status: PipelineNodeData['status'] }) {
  switch (status) {
    case 'success':
      return <CheckCircle2 size={12} className="text-emerald-500" />
    case 'error':
      return <AlertCircle size={12} className="text-red-500" />
    case 'running':
      return <Loader2 size={12} className="animate-spin text-blue-500" />
    case 'stale':
      return <AlertCircle size={12} className="text-amber-500" />
    default:
      return null
  }
}

// --- Shared node shell ---

interface NodeShellProps {
  children: React.ReactNode
  selected: boolean
  accentColor: string
}

function NodeShell({ children, selected, accentColor }: NodeShellProps) {
  const borderMap: Record<string, string> = {
    teal: selected ? 'border-teal-500 shadow-teal-500/15' : 'border-border hover:border-teal-500/40',
    blue: selected ? 'border-blue-500 shadow-blue-500/15' : 'border-border hover:border-blue-500/40',
    orange: selected ? 'border-orange-500 shadow-orange-500/15' : 'border-border hover:border-orange-500/40',
    violet: selected ? 'border-violet-500 shadow-violet-500/15' : 'border-border hover:border-violet-500/40',
    rose: selected ? 'border-rose-500 shadow-rose-500/15' : 'border-border hover:border-rose-500/40',
    amber: selected ? 'border-amber-500 shadow-amber-500/15' : 'border-border hover:border-amber-500/40',
    slate: selected ? 'border-slate-500 shadow-slate-500/15' : 'border-border hover:border-slate-500/40',
  }

  return (
    <div
      className={`
        group relative flex items-center gap-2.5 rounded-lg border-2 bg-card px-3 py-2.5
        shadow-sm transition-all
        ${borderMap[accentColor]}
      `}
      style={{ minWidth: 160, maxWidth: 240 }}
    >
      {children}
    </div>
  )
}

// --- Handle styling ---

function handleClass(color: string) {
  const colorMap: Record<string, string> = {
    teal: '!border-teal-500',
    blue: '!border-blue-500',
    orange: '!border-orange-500',
    violet: '!border-violet-500',
    rose: '!border-rose-500',
    amber: '!border-amber-500',
  }
  return `!h-3 !w-3 !rounded-full !border-2 !bg-background ${colorMap[color]}`
}

// --- Icon wrapper ---

function IconBox({ color, children }: { color: string; children: React.ReactNode }) {
  const bgMap: Record<string, string> = {
    teal: 'bg-teal-500/15',
    blue: 'bg-blue-500/15',
    orange: 'bg-orange-500/15',
    violet: 'bg-violet-500/15',
    rose: 'bg-rose-500/15',
    amber: 'bg-amber-500/15',
  }
  return (
    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${bgMap[color]}`}>
      {children}
    </div>
  )
}

// ===========================
// DATA WAREHOUSE NODES
// ===========================

// --- Database Node (source only) ---

export const DatabaseNode = memo(function DatabaseNode({ data, selected }: NodeProps) {
  const d = data as unknown as PipelineNodeData
  return (
    <NodeShell selected={!!selected} accentColor="teal">
      <IconBox color="teal">
        <Database size={16} className="text-teal-600 dark:text-teal-400" />
      </IconBox>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground" title={d.label}>{d.label}</span>
          <StatusIcon status={d.status} />
        </div>
        {d.rowCount != null && (
          <span className="text-[10px] text-muted-foreground">{d.rowCount.toLocaleString()} rows</span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className={handleClass('teal')} />
    </NodeShell>
  )
})

// --- Cohort Node (input + output) ---

export const CohortNode = memo(function CohortNode({ data, selected }: NodeProps) {
  const d = data as unknown as PipelineNodeData
  return (
    <NodeShell selected={!!selected} accentColor="orange">
      <Handle type="target" position={Position.Left} className={handleClass('orange')} />
      <IconBox color="orange">
        <UsersRound size={16} className="text-orange-600 dark:text-orange-400" />
      </IconBox>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground" title={d.label}>{d.label}</span>
          <StatusIcon status={d.status} />
        </div>
        {d.rowCount != null && (
          <span className="text-[10px] text-muted-foreground">{d.rowCount.toLocaleString()} patients</span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className={handleClass('orange')} />
    </NodeShell>
  )
})

// --- Scripts Node (input + output, container of ordered file references) ---

export const ScriptsNode = memo(function ScriptsNode({ data, selected }: NodeProps) {
  const d = data as unknown as PipelineNodeData
  const count = d.scripts?.length ?? 0
  return (
    <NodeShell selected={!!selected} accentColor="blue">
      <Handle type="target" position={Position.Left} className={handleClass('blue')} />
      <IconBox color="blue">
        <Code size={16} className="text-blue-600 dark:text-blue-400" />
      </IconBox>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground" title={d.label}>{d.label}</span>
          <StatusIcon status={d.status} />
        </div>
        {count > 0 && (
          <span className="text-[10px] text-muted-foreground">{count} {count === 1 ? 'script' : 'scripts'}</span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className={handleClass('blue')} />
    </NodeShell>
  )
})

// --- Dataset Node (input + output) ---

export const DatasetNode = memo(function DatasetNode({ data, selected }: NodeProps) {
  const d = data as unknown as PipelineNodeData
  return (
    <NodeShell selected={!!selected} accentColor="violet">
      <Handle type="target" position={Position.Left} className={handleClass('violet')} />
      <IconBox color="violet">
        <Table2 size={16} className="text-violet-600 dark:text-violet-400" />
      </IconBox>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground" title={d.label}>{d.label}</span>
          <StatusIcon status={d.status} />
        </div>
        {d.rowCount != null && d.columnCount != null && (
          <span className="text-[10px] text-muted-foreground">
            {d.rowCount.toLocaleString()} x {d.columnCount}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className={handleClass('violet')} />
    </NodeShell>
  )
})

// --- Dashboard Node (input only, terminal) ---

export const DashboardNode = memo(function DashboardNode({ data, selected }: NodeProps) {
  const d = data as unknown as PipelineNodeData
  return (
    <NodeShell selected={!!selected} accentColor="amber">
      <Handle type="target" position={Position.Left} className={handleClass('amber')} />
      <IconBox color="amber">
        <LayoutDashboard size={16} className="text-amber-600 dark:text-amber-400" />
      </IconBox>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground" title={d.label}>{d.label}</span>
          <StatusIcon status={d.status} />
        </div>
      </div>
    </NodeShell>
  )
})

// --- Group Node (parent container — children set parentId to this node) ---

export const GroupNode = memo(function GroupNode({ data, selected }: NodeProps) {
  const d = data as unknown as PipelineNodeData
  return (
    <div
      className={`
        rounded-xl border-2 border-dashed transition-all
        ${selected
          ? 'border-slate-400 bg-slate-500/8 shadow-sm'
          : 'border-slate-300/50 bg-slate-500/4 hover:border-slate-400/60'
        }
      `}
      style={{ width: '100%', height: '100%', minWidth: 200, minHeight: 120 }}
    >
      <div className="flex items-center gap-1.5 px-2 pt-2">
        <Group size={12} className="shrink-0 text-slate-500" />
        <span className="truncate text-[11px] font-medium text-slate-600 dark:text-slate-400" title={d.label}>
          {d.label}
        </span>
      </div>
    </div>
  )
})
