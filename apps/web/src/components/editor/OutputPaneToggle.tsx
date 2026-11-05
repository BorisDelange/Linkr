import { useTranslation } from 'react-i18next'
import { PanelRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/** The Output toggle at the far right of a plugin editor's Config / Code row. */
export function OutputPaneToggle({
  visible,
  onToggle,
  disabled,
  className,
}: {
  visible: boolean
  onToggle: () => void
  /** The other pane is hidden: hiding this one too would leave nothing. */
  disabled?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      aria-pressed={visible}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50',
        visible ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-accent/50',
        className,
      )}
    >
      <PanelRight size={12} />
      {t('datasets.analysis_output_tab')}
    </button>
  )
}
