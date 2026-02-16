import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useFileStore } from '@/stores/file-store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Upload } from 'lucide-react'

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  parentId: string | null
}

export function UploadDialog({
  open,
  onOpenChange,
  parentId,
}: UploadDialogProps) {
  const { t } = useTranslation()
  const { createFile, updateFileContent } = useFileStore()
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList) return
    Array.from(fileList).forEach((file) => {
      const reader = new FileReader()
      reader.onload = () => {
        const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
        const langMap: Record<string, string> = {
          py: 'python',
          r: 'r',
          sql: 'sql',
          sh: 'shell',
          json: 'json',
          md: 'markdown',
          rmd: 'markdown',
          qmd: 'markdown',
          ipynb: 'json',
        }
        const lang = langMap[ext] ?? 'plaintext'
        createFile(file.name, parentId, lang)
        // Update the content of the just-created file
        const state = useFileStore.getState()
        const created = state.files[state.files.length - 1]
        if (created) {
          updateFileContent(created.id, reader.result as string)
        }
      }
      reader.readAsText(file)
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('files.upload')}</DialogTitle>
          <DialogDescription>{t('files.upload_description')}</DialogDescription>
        </DialogHeader>
        <div
          className="mt-4 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/25 p-8 transition-colors hover:border-muted-foreground/50 cursor-pointer"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            handleFiles(e.dataTransfer.files)
          }}
        >
          <Upload size={32} className="text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            {t('files.upload_drop')}
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
