import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface CopySelectButtonProps {
  /** Called to produce the SQL to copy (lazy, so it uses the current selection). */
  getSql: () => string | null
}

/**
 * Shared "Copy SELECT" button — a white (outline) button sized like the Run
 * button. Used by every database schema view (SchemaBrowser, app-database
 * dialog) so they stay visually identical.
 */
export function CopySelectButton({ getSql }: CopySelectButtonProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    const sql = getSql()
    if (!sql) return
    void navigator.clipboard.writeText(sql).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleCopy}>
          {copied ? (
            <Check size={12} className="text-green-500" />
          ) : (
            <Copy size={12} />
          )}
          {t('etl.copy_select')}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('etl.copy_select_tooltip')}</TooltipContent>
    </Tooltip>
  )
}
