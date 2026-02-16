import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Upload, FileArchive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useVersioningStore } from '@/stores/versioning-store'

export function ExportTab() {
  const { t } = useTranslation()
  const { exportZip, importZip, loading } = useVersioningStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)

  const handleFileSelect = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    setSelectedFile(fileList[0])
  }

  const handleImport = async () => {
    if (!selectedFile) return
    await importZip(selectedFile)
    setSelectedFile(null)
  }

  return (
    <>
      {/* Export */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('versioning.export_title')}</CardTitle>
          <CardDescription>{t('versioning.export_description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" onClick={exportZip} className="gap-1.5">
            <Download size={14} />
            {t('versioning.export_download')}
          </Button>
        </CardContent>
      </Card>

      {/* Import */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('versioning.import_title')}</CardTitle>
          <CardDescription>{t('versioning.import_description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t('versioning.import_warning')}
            </p>
          </div>

          {selectedFile ? (
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-4">
              <div className="flex items-center gap-3">
                <FileArchive size={20} className="text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">{selectedFile.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(selectedFile.size / 1024).toFixed(1)} KB
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedFile(null)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  size="sm"
                  onClick={handleImport}
                  disabled={loading}
                  className="gap-1.5"
                >
                  <Upload size={14} />
                  {t('versioning.import_button')}
                </Button>
              </div>
            </div>
          ) : (
            <div
              className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/25 p-8 transition-colors hover:border-muted-foreground/50"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                handleFileSelect(e.dataTransfer.files)
              }}
            >
              <Upload size={32} className="text-muted-foreground/50" />
              <p className="mt-3 text-sm text-muted-foreground">
                {t('versioning.import_drop')}
              </p>
              <input
                ref={inputRef}
                type="file"
                accept=".zip"
                className="hidden"
                onChange={(e) => handleFileSelect(e.target.files)}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </>
  )
}
