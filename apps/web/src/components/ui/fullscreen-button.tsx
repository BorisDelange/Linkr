import { useTranslation } from 'react-i18next'
import { Maximize, Minimize } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** The toolbar button of `useFullscreen`: enter, or leave, full screen. */
export function FullscreenButton({ isFullscreen, onToggle }: { isFullscreen: boolean; onToggle: () => void }) {
  const { t } = useTranslation()
  const label = isFullscreen ? t('dashboard.exit_fullscreen') : t('dashboard.enter_fullscreen')
  return (
    <Button variant="ghost" size="icon-xs" onClick={onToggle} title={label} aria-label={label}>
      {isFullscreen ? <Minimize size={12} /> : <Maximize size={12} />}
    </Button>
  )
}
