import { useTranslation } from 'react-i18next'
import { useReactFlow } from '@xyflow/react'
import { ZoomIn, ZoomOut, Maximize2, Trash2, PanelLeftClose, PanelLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import type { Pipeline } from '@/types'

interface PipelineToolbarProps {
  pipeline: Pipeline | null
  selectedNodeId: string | null
  onDeleteSelected: () => void
  paletteOpen: boolean
  onTogglePalette: () => void
}

export function PipelineToolbar({ pipeline, selectedNodeId, onDeleteSelected, paletteOpen, onTogglePalette }: PipelineToolbarProps) {
  const { t } = useTranslation()
  const { zoomIn, zoomOut, fitView } = useReactFlow()

  return (
    <div className="flex h-10 items-center justify-between border-b border-border bg-card px-3">
      <div className="flex items-center gap-2">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={onTogglePalette}
              >
                {paletteOpen ? <PanelLeftClose size={14} /> : <PanelLeft size={14} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {paletteOpen ? t('pipeline.hide_palette') : t('pipeline.show_palette')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <span className="text-sm font-medium text-foreground">
          {pipeline?.name ?? t('pipeline.title')}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <TooltipProvider delayDuration={300}>
          {selectedNodeId && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-red-500"
                    onClick={onDeleteSelected}
                  >
                    <Trash2 size={14} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('pipeline.delete_node')}</TooltipContent>
              </Tooltip>
              <Separator orientation="vertical" className="mx-1 h-4" />
            </>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={() => zoomIn()}
              >
                <ZoomIn size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('pipeline.zoom_in')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={() => zoomOut()}
              >
                <ZoomOut size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('pipeline.zoom_out')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={() => fitView({ padding: 0.2 })}
              >
                <Maximize2 size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('pipeline.fit_view')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  )
}
