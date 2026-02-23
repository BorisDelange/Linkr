import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { importAtlasCohort, type ImportResult } from './atlas-converter'
import type { CriteriaGroupNode } from '@/types'

interface ImportAtlasDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImport: (tree: CriteriaGroupNode) => void
}

export function ImportAtlasDialog({ open, onOpenChange, onImport }: ImportAtlasDialogProps) {
  const { t } = useTranslation()
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setFileName(file.name)
    setError(null)
    setResult(null)

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result as string)
        if (!json.ConceptSets && !json.PrimaryCriteria) {
          setError(t('cohorts.atlas_invalid_format'))
          return
        }
        const importResult = importAtlasCohort(json)
        setResult(importResult)
      } catch {
        setError(t('cohorts.atlas_parse_error'))
      }
    }
    reader.readAsText(file)
  }, [t])

  const handleImport = () => {
    if (!result) return
    onImport(result.criteriaTree)
    onOpenChange(false)
    setResult(null)
    setFileName(null)
    setError(null)
  }

  const handleClose = (open: boolean) => {
    if (!open) {
      setResult(null)
      setFileName(null)
      setError(null)
    }
    onOpenChange(open)
  }

  const criteriaCount = result ? countNodes(result.criteriaTree) : 0

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('cohorts.atlas_import_title')}</DialogTitle>
          <DialogDescription>{t('cohorts.atlas_import_description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* File input */}
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors hover:border-primary/50 hover:bg-muted/30">
            <Upload size={24} className="text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {fileName ?? t('cohorts.atlas_drop_file')}
            </span>
            <input
              type="file"
              accept=".json"
              onChange={handleFileChange}
              className="hidden"
            />
          </label>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {error}
            </div>
          )}

          {/* Preview */}
          {result && (
            <div className="space-y-2">
              <p className="text-sm">
                {t('cohorts.atlas_import_preview', { count: criteriaCount })}
              </p>

              {/* Warnings */}
              {result.warnings.length > 0 && (
                <div className="space-y-1 rounded-md bg-yellow-500/10 px-3 py-2">
                  <p className="text-xs font-medium text-yellow-700 dark:text-yellow-400">
                    {t('cohorts.atlas_warnings', { count: result.warnings.length })}
                  </p>
                  <ul className="space-y-0.5">
                    {result.warnings.map((w, i) => (
                      <li key={i} className="text-xs text-yellow-600 dark:text-yellow-300">
                        {w}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleImport} disabled={!result}>
            {t('cohorts.atlas_import_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function countNodes(node: CriteriaGroupNode): number {
  let count = 0
  for (const child of node.children) {
    if (child.kind === 'criterion') count++
    else count += countNodes(child)
  }
  return count
}
