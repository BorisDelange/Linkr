import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { localized } from '@/lib/localized'
import type { DqResultNode, DqResultRow } from '@/lib/dq-report/tally'
import { cn } from '@/lib/utils'
import { SEVERITY_CONFIG, STATUS_CONFIG } from '../DqConstants'
import { StatusBar } from './DqResultsSummary'

interface Props {
  nodes: DqResultNode[]
  isOpen: (key: string) => boolean
  onToggle: (key: string) => void
  selectedCheckId: string | null
  onSelect: (checkId: string) => void
  emptyMessage: string
}

/**
 * A run's results under the groups their checks were filed in, each group with
 * the split of everything under it; a check opens in the detail panel.
 */
export function DqResultsTree({ nodes, isOpen, onToggle, selectedCheckId, onSelect, emptyMessage }: Props) {
  const { t, i18n } = useTranslation()

  const checkRow = ({ check, result }: DqResultRow) => {
    const status = STATUS_CONFIG[result.status]
    const StatusIcon = status.icon
    const severity = SEVERITY_CONFIG[check.severity]
    const SeverityIcon = severity.icon
    return (
      <button
        key={check.id}
        type="button"
        onClick={() => onSelect(check.id)}
        className={cn(
          'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs',
          selectedCheckId === check.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
        )}
      >
        <StatusIcon size={13} className={cn('shrink-0', status.color)} aria-label={t(`data_quality.${status.label}`)} />
        <span className="min-w-0 flex-1 truncate">{localized(check.name, i18n.language)}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {result.status === 'not_applicable' || result.status === 'error' ? '—' : `${result.pctViolated.toFixed(1)}%`}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <SeverityIcon size={13} className={cn('shrink-0', severity.color)} aria-label={t(`data_quality.severity_${check.severity}`)} />
          </TooltipTrigger>
          <TooltipContent>{t(`data_quality.severity_${check.severity}`)}</TooltipContent>
        </Tooltip>
      </button>
    )
  }

  const renderNode = (node: DqResultNode): ReactNode => {
    const open = isOpen(node.key)
    const problems = node.tally.failed + node.tally.errors
    return (
      <div key={node.key}>
        <button
          type="button"
          onClick={() => onToggle(node.key)}
          className={cn(
            'flex h-7 w-full items-center gap-1.5 rounded px-1 text-left text-xs hover:bg-accent/50',
            node.kind === 'ruleSet' ? 'font-semibold' : 'font-medium',
          )}
        >
          {open ? <ChevronDown size={12} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={12} className="shrink-0 text-muted-foreground" />}
          <span className={cn('min-w-0 flex-1 truncate', node.kind === 'other' && 'text-muted-foreground')}>
            {node.kind === 'other' ? t('data_quality.group_other') : node.label}
          </span>
          {problems > 0 && (
            <span className="shrink-0 text-[10px] tabular-nums text-destructive">
              {t('data_quality.results_problems', { count: problems })}
            </span>
          )}
          <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
            {node.tally.passed}/{node.tally.total - node.tally.notApplicable}
          </span>
          <StatusBar tally={node.tally} className="h-1.5 w-20 shrink-0" />
        </button>
        {open && (
          <div className="space-y-0.5 border-l border-border/60 pl-3 ml-2">
            {node.children.map(renderNode)}
            {node.rows.map(checkRow)}
          </div>
        )}
      </div>
    )
  }

  if (!nodes.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <ShieldCheck size={24} className="text-muted-foreground/50" />
        <p className="mt-2 text-xs text-muted-foreground">{emptyMessage}</p>
      </div>
    )
  }
  return (
    <ScrollArea className="h-full">
      <div className="space-y-0.5 p-2">{nodes.map(renderNode)}</div>
    </ScrollArea>
  )
}
