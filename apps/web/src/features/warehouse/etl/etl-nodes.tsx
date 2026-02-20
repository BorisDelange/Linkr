import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Database, FileCode, Target, CheckCircle2, AlertCircle, Loader2, Clock, Ban } from 'lucide-react'

// --- Status indicator ---

export type EtlNodeStatus = 'idle' | 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'disabled'

function StatusIcon({ status }: { status: EtlNodeStatus }) {
  switch (status) {
    case 'success':
      return <CheckCircle2 size={12} className="text-emerald-500" />
    case 'error':
      return <AlertCircle size={12} className="text-red-500" />
    case 'running':
      return <Loader2 size={12} className="animate-spin text-blue-500" />
    case 'pending':
      return <Clock size={12} className="text-muted-foreground/50" />
    case 'skipped':
      return <AlertCircle size={12} className="text-amber-500" />
    case 'disabled':
      return <Ban size={12} className="text-muted-foreground/40" />
    default:
      return null
  }
}

// --- Shared node shell ---

function NodeShell({ children, selected, accentColor }: {
  children: React.ReactNode
  selected: boolean
  accentColor: string
}) {
  const borderMap: Record<string, string> = {
    teal: selected ? 'border-teal-500 shadow-teal-500/15' : 'border-border hover:border-teal-500/40',
    blue: selected ? 'border-blue-500 shadow-blue-500/15' : 'border-border hover:border-blue-500/40',
    emerald: selected ? 'border-emerald-500 shadow-emerald-500/15' : 'border-border hover:border-emerald-500/40',
  }

  return (
    <div
      className={`
        group relative flex items-center gap-2.5 rounded-lg border-2 bg-card px-3 py-2.5
        shadow-sm transition-all
        ${borderMap[accentColor]}
      `}
      style={{ minWidth: 160, maxWidth: 260 }}
    >
      {children}
    </div>
  )
}

function handleClass(color: string) {
  const colorMap: Record<string, string> = {
    teal: '!border-teal-500',
    blue: '!border-blue-500',
    emerald: '!border-emerald-500',
  }
  return `!h-3 !w-3 !rounded-full !border-2 !bg-background ${colorMap[color]}`
}

function IconBox({ color, children }: { color: string; children: React.ReactNode }) {
  const bgMap: Record<string, string> = {
    teal: 'bg-teal-500/15',
    blue: 'bg-blue-500/15',
    emerald: 'bg-emerald-500/15',
  }
  return (
    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${bgMap[color]}`}>
      {children}
    </div>
  )
}

// --- ETL Node data types ---

export interface EtlSourceNodeData {
  nodeType: 'source'
  label: string
  dataSourceName?: string
}

export interface EtlScriptNodeData {
  nodeType: 'script'
  label: string
  fileId: string
  order: number
  status: EtlNodeStatus
  disabled?: boolean
  durationMs?: number
  rowsAffected?: number
}

export interface EtlTargetNodeData {
  nodeType: 'target'
  label: string
  dataSourceName?: string
}

export type EtlNodeData = EtlSourceNodeData | EtlScriptNodeData | EtlTargetNodeData

// --- Source Node (teal, output only) ---

export const EtlSourceNode = memo(function EtlSourceNode({ data, selected }: NodeProps) {
  const d = data as unknown as EtlSourceNodeData
  return (
    <NodeShell selected={!!selected} accentColor="teal">
      <IconBox color="teal">
        <Database size={16} className="text-teal-600 dark:text-teal-400" />
      </IconBox>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground" title={d.label}>{d.label}</span>
        </div>
        {d.dataSourceName && (
          <span className="text-[10px] text-muted-foreground">{d.dataSourceName}</span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className={handleClass('teal')} />
    </NodeShell>
  )
})

// --- Script Node (blue, input + output) ---

export const EtlScriptNode = memo(function EtlScriptNode({ data, selected }: NodeProps) {
  const d = data as unknown as EtlScriptNodeData
  const isDisabled = !!d.disabled
  return (
    <div style={{ opacity: isDisabled ? 0.45 : 1 }}>
      <NodeShell selected={!!selected} accentColor={isDisabled ? 'blue' : 'blue'}>
        <Handle type="target" position={Position.Top} className={handleClass('blue')} />
        <IconBox color="blue">
          {isDisabled
            ? <Ban size={16} className="text-muted-foreground/40" />
            : <FileCode size={16} className="text-blue-600 dark:text-blue-400" />
          }
        </IconBox>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`truncate text-xs font-medium ${isDisabled ? 'line-through text-muted-foreground/60' : 'text-foreground'}`} title={d.label}>{d.label}</span>
            <StatusIcon status={d.status} />
          </div>
          {!isDisabled && (
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              {d.durationMs != null && (
                <span>{d.durationMs < 1000 ? `${d.durationMs}ms` : `${(d.durationMs / 1000).toFixed(1)}s`}</span>
              )}
              {d.rowsAffected != null && (
                <span>{d.rowsAffected.toLocaleString()} rows</span>
              )}
            </div>
          )}
        </div>
        <Handle type="source" position={Position.Bottom} className={handleClass('blue')} />
      </NodeShell>
    </div>
  )
})

// --- Target Node (emerald, input only) ---

export const EtlTargetNode = memo(function EtlTargetNode({ data, selected }: NodeProps) {
  const d = data as unknown as EtlTargetNodeData
  return (
    <NodeShell selected={!!selected} accentColor="emerald">
      <Handle type="target" position={Position.Top} className={handleClass('emerald')} />
      <IconBox color="emerald">
        <Target size={16} className="text-emerald-600 dark:text-emerald-400" />
      </IconBox>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground" title={d.label}>{d.label}</span>
        </div>
        {d.dataSourceName && (
          <span className="text-[10px] text-muted-foreground">{d.dataSourceName}</span>
        )}
      </div>
    </NodeShell>
  )
})

// --- Node types registry ---

export const etlNodeTypes = {
  source: EtlSourceNode,
  script: EtlScriptNode,
  target: EtlTargetNode,
}
