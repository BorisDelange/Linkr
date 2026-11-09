import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { foldSteps, type FoldNode } from './use-fold-state'

interface Props {
  /** The groups shown, level by level, top first. */
  levels: FoldNode[][]
  isOpen: (key: string) => boolean
  onFold: (keys: string[], open: boolean) => void
  disabled?: boolean
}

/**
 * Opens the tree one level per click, top down, then folds it back one level
 * per click, bottom up. Half open, it keeps going the way it last went.
 */
export function FoldLevelButton({ levels, isOpen, onFold, disabled }: Props) {
  const { t } = useTranslation()
  const [lastOpened, setLastOpened] = useState(true)
  const shownLevels = levels.filter((level) => level.length > 0)
  const steps = foldSteps(shownLevels, isOpen)
  const opens = steps.expand && steps.collapse ? lastOpened : !!steps.expand
  const keys = opens ? steps.expand : steps.collapse
  const label = shownLevels.length > 1
    ? t(opens ? 'data_quality.expand_level' : 'data_quality.collapse_level')
    : t(opens ? 'common.expand_all' : 'common.collapse_all')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={disabled || !keys}
          onClick={() => {
            if (!keys) return
            setLastOpened(opens)
            onFold(keys, opens)
          }}
        >
          {opens ? <ChevronsUpDown size={12} /> : <ChevronsDownUp size={12} />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
