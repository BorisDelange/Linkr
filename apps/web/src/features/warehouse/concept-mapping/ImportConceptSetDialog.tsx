import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Loader2 } from 'lucide-react'
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
import type { MappingProject, ConceptSetItem } from '@/types'

interface ImportConceptSetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: MappingProject
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

interface ParsedConceptSet {
  name: string
  description?: string
  items: ConceptSetItem[]
  category?: string
  subcategory?: string
  provenance?: string
}

/** Extract metadata (category, subcategory, provenance) from INDICATE-style JSON. */
function extractMetadata(obj: Record<string, unknown>, lang: string): { category?: string; subcategory?: string; provenance?: string } {
  const meta = obj.metadata as Record<string, unknown> | undefined
  if (!meta) return {}

  const translations = meta.translations as Record<string, Record<string, string>> | undefined
  const tr = translations?.[lang] ?? translations?.en ?? {}

  const createdBy = meta.createdByDetails as Record<string, string> | undefined

  return {
    category: tr.category || undefined,
    subcategory: tr.subcategory || undefined,
    provenance: createdBy?.affiliation || undefined,
  }
}

/** Validate an OHDSI concept set JSON structure. */
function parseConceptSetJson(json: unknown, lang = 'en'): ParsedConceptSet | null {
  if (!json || typeof json !== 'object') return null
  const obj = json as Record<string, unknown>

  let base: { name: string; description?: string; items: ConceptSetItem[] } | null = null

  // Support OHDSI format: { name, expression: { items: [...] } }
  if (obj.expression && typeof obj.expression === 'object') {
    const expr = obj.expression as Record<string, unknown>
    if (Array.isArray(expr.items)) {
      // Use translated name if available
      const meta = obj.metadata as Record<string, unknown> | undefined
      const translations = meta?.translations as Record<string, Record<string, string>> | undefined
      const tr = translations?.[lang] ?? translations?.en

      base = {
        name: tr?.name ?? String(obj.name ?? 'Unnamed Concept Set'),
        description: obj.description ? String(obj.description) : undefined,
        items: expr.items as ConceptSetItem[],
      }
    }
  }

  // Support direct items array: { name, items: [...] }
  if (!base && Array.isArray(obj.items)) {
    base = {
      name: String(obj.name ?? 'Unnamed Concept Set'),
      description: obj.description ? String(obj.description) : undefined,
      items: obj.items as ConceptSetItem[],
    }
  }

  if (!base) return null

  const metadata = extractMetadata(obj, lang)
  return { ...base, ...metadata }
}

export function ImportConceptSetDialog({ open, onOpenChange, project }: ImportConceptSetDialogProps) {
  const { t, i18n } = useTranslation()
  const { activeWorkspaceId } = useWorkspaceStore()
  const lang = i18n.language?.substring(0, 2) ?? 'en'
  const { createConceptSet, updateMappingProject } = useConceptMappingStore()

  const [fileContent, setFileContent] = useState<string>('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Referenced tab state
  const [importingCatalogId, setImportingCatalogId] = useState<string | null>(null)
  const [catalogProgress, setCatalogProgress] = useState<{ done: number; total: number } | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setFileContent(reader.result as string)
      setError(null)
    }
    reader.readAsText(file)
  }

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
        category: parsed.category,
        subcategory: parsed.subcategory,
        provenance: parsed.provenance,
        createdAt: now,
        updatedAt: now,
      })

      await updateMappingProject(project.id, {
        conceptSetIds: [...project.conceptSetIds, id],
      })

      onOpenChange(false)
      setFileContent('')
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
            category: parsed.category,
            subcategory: parsed.subcategory,
            provenance: parsed.provenance,
            createdAt: now,
            updatedAt: now,
          })
          newIds.push(id)
        }

        setCatalogProgress({ done: Math.min(i + batchSize, jsonFiles.length), total: jsonFiles.length })
      }

      if (newIds.length > 0) {
        await updateMappingProject(project.id, {
          conceptSetIds: [...project.conceptSetIds, ...newIds],
        })
      }

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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('concept_mapping.cs_import_title')}</DialogTitle>
          <DialogDescription>{t('concept_mapping.cs_import_description')}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="file">
          <TabsList className="w-fit">
            <TabsTrigger value="file">{t('concept_mapping.cs_import_file')}</TabsTrigger>
            <TabsTrigger value="url">{t('concept_mapping.cs_import_url')}</TabsTrigger>
            <TabsTrigger value="referenced">{t('concept_mapping.cs_import_referenced')}</TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="mt-4 space-y-3">
            <div className="grid gap-2">
              <Label>{t('concept_mapping.cs_import_json_file')}</Label>
              <Input type="file" accept=".json" onChange={handleFileUpload} />
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
                  <Card key={catalog.id} className="flex items-center gap-4 p-4">
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
