import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Code2, Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { CATEGORY_COLORS, STATUS_CONFIG } from './DqConstants'
import type { DqCheck, DqCheckResult } from '@/lib/duckdb/data-quality'

interface Props {
  item: { check: DqCheck; result: DqCheckResult } | null
}

export function DqCheckDetailPanel({ item }: Props) {
  const { t } = useTranslation()
  const [sqlDialogOpen, setSqlDialogOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center border-l p-6 text-center">
        <ShieldCheck size={24} className="text-muted-foreground/50" />
        <p className="mt-3 text-xs text-muted-foreground">{t('data_quality.detail_select')}</p>
      </div>
    )
  }

  const { check, result } = item
  const statusCfg = STATUS_CONFIG[result.status]
  const StatusIcon = statusCfg.icon

  const handleCopySql = async () => {
    await navigator.clipboard.writeText(result.sql.trim())
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex h-full flex-col border-l">
      {/* Header */}
      <div className="border-b px-3 py-2">
        <div className="flex items-center gap-1.5">
          <StatusIcon size={14} className={statusCfg.color} />
          <span className="text-xs font-medium">{t(`data_quality.status_${result.status}`)}</span>
        </div>
        <p className="mt-1 text-xs text-foreground">{check.description}</p>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="space-y-3 p-3 text-xs">
          {/* Severity + Category */}
          <div className="flex items-center gap-2">
            <span className={cn('inline-block rounded px-1.5 py-0.5 text-[10px] font-medium', CATEGORY_COLORS[check.category])}>
              {t(`data_quality.category_${check.category}`)}
            </span>
            <span className="text-muted-foreground">{t(`data_quality.severity_${check.severity}`)}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{t(`data_quality.source_${check.source}`)}</span>
          </div>

          {/* Violation bar */}
          {result.totalRows > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-muted-foreground">{t('data_quality.col_violated')}</span>
                <span className="tabular-nums">{result.pctViolated.toFixed(2)}%</span>
              </div>
              <div className="h-3 w-full overflow-hidden rounded-sm bg-emerald-500/15">
                <div
                  className="h-full rounded-sm bg-red-500/70 transition-all"
                  style={{ width: `${Math.min(result.pctViolated, 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>{t('data_quality.detail_threshold')}: {check.threshold}%</span>
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="space-y-1 border-t pt-3">
            <StatRow label={t('data_quality.detail_violated_rows')} value={result.violatedRows.toLocaleString()} />
            <StatRow label={t('data_quality.detail_total_rows')} value={result.totalRows.toLocaleString()} />
            <StatRow label={t('data_quality.detail_execution_time')} value={`${result.executionTimeMs} ms`} />
            {check.tableName && <StatRow label={t('data_quality.col_table')} value={check.tableName} />}
            {check.fieldName && <StatRow label={t('data_quality.col_field')} value={check.fieldName} />}
          </div>

          {/* Error message */}
          {result.errorMessage && (
            <div className="border-t pt-3">
              <p className="text-[10px] font-medium uppercase tracking-wider text-destructive">{t('data_quality.detail_error')}</p>
              <p className="mt-1 rounded bg-destructive/10 p-2 font-mono text-[10px] text-destructive">
                {result.errorMessage}
              </p>
            </div>
          )}

          {/* SQL button */}
          <div className="border-t pt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSqlDialogOpen(true)}
              className="w-full gap-1.5 text-xs"
            >
              <Code2 size={12} />
              {t('data_quality.detail_sql')}
            </Button>
          </div>
        </div>
      </ScrollArea>

      {/* SQL Dialog */}
      <Dialog open={sqlDialogOpen} onOpenChange={setSqlDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {t('data_quality.sql_dialog_title')}
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleCopySql}
              >
                {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
              </Button>
            </DialogTitle>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded bg-muted p-4 font-mono text-xs leading-relaxed text-muted-foreground">
            {result.sql.trim()}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-right tabular-nums">{value}</span>
    </div>
  )
}
