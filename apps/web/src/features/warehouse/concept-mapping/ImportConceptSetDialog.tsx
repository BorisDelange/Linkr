import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { MappingProject, ConceptSetItem } from '@/types'

interface ImportConceptSetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: MappingProject
}

/** Validate an OHDSI concept set JSON structure. */
function parseConceptSetJson(json: unknown): { name: string; description?: string; items: ConceptSetItem[] } | null {
  if (!json || typeof json !== 'object') return null
  const obj = json as Record<string, unknown>

  // Support OHDSI format: { name, expression: { items: [...] } }
  if (obj.expression && typeof obj.expression === 'object') {
    const expr = obj.expression as Record<string, unknown>
    if (Array.isArray(expr.items)) {
      return {
        name: String(obj.name ?? 'Unnamed Concept Set'),
        description: obj.description ? String(obj.description) : undefined,
        items: expr.items as ConceptSetItem[],
      }
    }
  }

  // Support direct items array: { name, items: [...] }
  if (Array.isArray(obj.items)) {
    return {
      name: String(obj.name ?? 'Unnamed Concept Set'),
      description: obj.description ? String(obj.description) : undefined,
      items: obj.items as ConceptSetItem[],
    }
  }

  return null
}

export function ImportConceptSetDialog({ open, onOpenChange, project }: ImportConceptSetDialogProps) {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { createConceptSet, updateMappingProject } = useConceptMappingStore()

  const [fileContent, setFileContent] = useState<string>('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

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

      const parsed = parseConceptSetJson(JSON.parse(jsonStr))
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
        createdAt: now,
        updatedAt: now,
      })

      // Link to project
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('concept_mapping.cs_import_title')}</DialogTitle>
          <DialogDescription>{t('concept_mapping.cs_import_description')}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="file">
          <TabsList className="w-fit">
            <TabsTrigger value="file">{t('concept_mapping.cs_import_file')}</TabsTrigger>
            <TabsTrigger value="url">{t('concept_mapping.cs_import_url')}</TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="space-y-3">
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

          <TabsContent value="url" className="space-y-3">
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
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
