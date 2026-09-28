import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Loader2, BookText, Upload, FileSpreadsheet, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { MappingProject } from '@/types'
import { parseConceptSetJson } from '@/lib/data-dictionary/parse'

interface ImportConceptSetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Fired only after sets have actually been written. "Replace dictionary"
   * hangs the removal of the old sets off this, so cancelling the import
   * cannot leave the workspace with neither the old nor the new dictionary.
   */
  onImported?: () => void
  /**
   * Mapping project to link the imported sets to. Optional: the warehouse
   * Concepts page imports dictionaries workspace-wide, with no mapping project
   * to attach them to — the sets themselves are workspace-scoped either way.
   */
  project?: MappingProject
  /** Opened from the warehouse Concepts page, where the unit is a whole data
   *  dictionary rather than a single OHDSI concept set — only the wording
   *  changes, the import paths are the same. */
  dictionaryMode?: boolean
}

/** Known catalogs that can be imported in bulk. */
interface ReferencedCatalog {
  id: string
  name: string
  description: string
  apiUrl: string
  rawBase: string
}

const REFERENCED_CATALOGS: ReferencedCatalog[] = [
  {
    id: 'indicate',
    name: 'INDICATE Data Dictionary',
    description: 'concept_mapping.cs_ref_indicate_desc',
    apiUrl: 'https://api.github.com/repos/indicate-eu/data-dictionary-content/contents/concept_sets',
    rawBase: 'https://raw.githubusercontent.com/indicate-eu/data-dictionary-content/main/concept_sets',
  },
]

export function ImportConceptSetDialog({ open, onOpenChange, onImported, project, dictionaryMode }: ImportConceptSetDialogProps) {
  const { t, i18n } = useTranslation()
  const { activeWorkspaceId } = useWorkspaceStore()
  const lang = i18n.language?.substring(0, 2) ?? 'en'
  const { createConceptSet, updateMappingProject } = useConceptMappingStore()

  const [fileContent, setFileContent] = useState<string>('')
  const [fileName, setFileName] = useState<string>('')
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Referenced tab state
  const [importingCatalogId, setImportingCatalogId] = useState<string | null>(null)
  const [catalogProgress, setCatalogProgress] = useState<{ done: number; total: number } | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)

  const readFile = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      setFileContent(reader.result as string)
      setFileName(file.name)
      setError(null)
    }
    reader.readAsText(file)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer.files[0]
    if (file) readFile(file)
  }, [readFile])

  const clearFile = useCallback(() => {
    setFileContent('')
    setFileName('')
    setError(null)
  }, [])

  const handleImport = async (source: 'file' | 'url') => {
    if (!activeWorkspaceId) return
    setError(null)
    setLoading(true)

    try {
      let jsonStr: string
      if (source === 'url') {
        const resp = await fetch(url)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        jsonStr = await resp.text()
      } else {
        jsonStr = fileContent
      }

      const parsed = parseConceptSetJson(JSON.parse(jsonStr), lang)
      if (!parsed) {
        setError(t('concept_mapping.cs_import_invalid'))
        setLoading(false)
        return
      }

      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      await createConceptSet({
        id,
        workspaceId: activeWorkspaceId,
        name: parsed.name,
        description: parsed.description ?? '',
        expression: { items: parsed.items },
        resolvedConceptIds: null,
        sourceUrl: source === 'url' ? url : undefined,
        uniqueId: parsed.uniqueId,
        sourceRepo: parsed.sourceRepo,
        category: parsed.category,
        subcategory: parsed.subcategory,
        provenance: parsed.provenance,
        version: parsed.version,
        translations: parsed.translations,
        createdAt: now,
        updatedAt: now,
      })

      if (project) {
        await updateMappingProject(project.id, {
          conceptSetIds: [...(project.conceptSetIds ?? []), id],
        })
      }

      onImported?.()
      onOpenChange(false)
      setFileContent('')
      setFileName('')
      setUrl('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const handleImportCatalog = async (catalog: ReferencedCatalog) => {
    if (!activeWorkspaceId) return
    setImportingCatalogId(catalog.id)
    setCatalogError(null)
    setCatalogProgress(null)

    try {
      // 1. List files from GitHub API
      const resp = await fetch(catalog.apiUrl)
      if (!resp.ok) throw new Error(`GitHub API: HTTP ${resp.status}`)
      const files = (await resp.json()) as { name: string }[]
      const jsonFiles = files.filter((f) => f.name.endsWith('.json'))

      setCatalogProgress({ done: 0, total: jsonFiles.length })

      // 2. Fetch and import each concept set in batches
      const batchId = crypto.randomUUID()
      const newIds: string[] = []
      const batchSize = 20

      for (let i = 0; i < jsonFiles.length; i += batchSize) {
        const batch = jsonFiles.slice(i, i + batchSize)
        const results = await Promise.allSettled(
          batch.map(async (f) => {
            const rawUrl = `${catalog.rawBase}/${f.name}`
            const r = await fetch(rawUrl)
            if (!r.ok) return null
            return { json: await r.json(), url: rawUrl }
          }),
        )

        for (const r of results) {
          if (r.status !== 'fulfilled' || !r.value) continue
          const parsed = parseConceptSetJson(r.value.json, lang)
          if (!parsed) continue

          const id = crypto.randomUUID()
          const now = new Date().toISOString()
          await createConceptSet({
            id,
            workspaceId: activeWorkspaceId,
            name: parsed.name,
            description: parsed.description ?? '',
            expression: { items: parsed.items },
            resolvedConceptIds: null,
            sourceUrl: r.value.url,
            uniqueId: parsed.uniqueId,
            sourceRepo: parsed.sourceRepo,
            category: parsed.category,
            subcategory: parsed.subcategory,
            provenance: parsed.provenance,
            version: parsed.version,
            translations: parsed.translations,
            importBatchId: batchId,
            createdAt: now,
            updatedAt: now,
          })
          newIds.push(id)
        }

        setCatalogProgress({ done: Math.min(i + batchSize, jsonFiles.length), total: jsonFiles.length })
      }

      if (newIds.length > 0) {
        const importBatch = {
          id: batchId,
          sourceName: catalog.name,
          sourceUrl: catalog.rawBase,
          count: newIds.length,
          importedAt: new Date().toISOString(),
        }
        if (project) {
          await updateMappingProject(project.id, {
            conceptSetIds: [...(project.conceptSetIds ?? []), ...newIds],
            importBatches: [...(project.importBatches ?? []), importBatch],
          })
        }
      }

      if (newIds.length > 0) onImported?.()
      onOpenChange(false)
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : String(err))
    } finally {
      setImportingCatalogId(null)
      setCatalogProgress(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t(dictionaryMode ? 'concepts.settings_import_dictionary' : 'concept_mapping.cs_import_title')}
          </DialogTitle>
          <DialogDescription>
            {t(dictionaryMode ? 'concepts.dictionary_import_description' : 'concept_mapping.cs_import_description')}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="referenced">
          <TabsList className="mx-auto w-fit">
            <TabsTrigger value="referenced">{t('concept_mapping.cs_import_referenced')}</TabsTrigger>
            <TabsTrigger value="url">{t('concept_mapping.cs_import_url')}</TabsTrigger>
            <TabsTrigger value="file">{t('concept_mapping.cs_import_file')}</TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="mt-4 space-y-3">
            <div className="grid gap-2">
              <Label>{t('concept_mapping.cs_import_json_file')}</Label>
              {!fileName ? (
                <div
                  className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors cursor-pointer ${
                    dragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/50'
                  }`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                >
                  <Upload size={28} className="text-muted-foreground/50" />
                  <p className="mt-2 text-sm text-muted-foreground">{t('concept_mapping.file_drop_hint')}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">JSON</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) readFile(f)
                      e.target.value = ''
                    }}
                  />
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-md border p-2">
                  <FileSpreadsheet size={16} className="shrink-0 text-emerald-500" />
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">{fileName}</p>
                  <Button variant="ghost" size="icon-xs" onClick={clearFile}>
                    <X size={14} />
                  </Button>
                </div>
              )}
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => handleImport('file')} disabled={!fileContent || loading}>
                {loading ? t('common.loading') : t('common.import')}
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="url" className="mt-4 space-y-3">
            <div className="grid gap-2">
              <Label>{t('concept_mapping.cs_import_url_label')}</Label>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://raw.githubusercontent.com/indicate-eu/data-dictionary-content/main/concept_sets/1.json"
              />
              <p className="text-[10px] text-muted-foreground">
                {t('concept_mapping.cs_import_url_hint')}
              </p>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => handleImport('url')} disabled={!url || loading}>
                {loading ? t('common.loading') : t('common.import')}
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="referenced" className="mt-4 space-y-3">
            <div className="space-y-3">
              {REFERENCED_CATALOGS.map((catalog) => {
                const isImporting = importingCatalogId === catalog.id
                return (
                  <Card key={catalog.id} className="flex flex-row items-center gap-4 p-4">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                      <BookText size={20} className="text-teal-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{catalog.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{t(catalog.description)}</p>
                      {isImporting && catalogProgress && (
                        <div className="mt-2 space-y-1">
                          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary transition-all"
                              style={{ width: `${(catalogProgress.done / catalogProgress.total) * 100}%` }}
                            />
                          </div>
                          <p className="text-[10px] text-muted-foreground">
                            {catalogProgress.done} / {catalogProgress.total}
                          </p>
                        </div>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleImportCatalog(catalog)}
                      disabled={importingCatalogId !== null}
                    >
                      {isImporting ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Download size={14} />
                      )}
                      {t('common.import')}
                    </Button>
                  </Card>
                )
              })}
            </div>

            {catalogError && <p className="text-xs text-destructive">{catalogError}</p>}

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
