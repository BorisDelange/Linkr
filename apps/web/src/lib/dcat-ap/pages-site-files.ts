import type JSZip from 'jszip'
import type { Storage } from '@/lib/storage'
import type { DataCatalog, ReadmeAttachment } from '@/types'
import { isPagesTreePath, PAGES_SITE_OWNER_TYPE, type PagesTreeFile } from './pages-deployment'

async function siteAttachments(storage: Storage, catalogId: string): Promise<ReadmeAttachment[]> {
  const rows = await (storage.readmeAttachments
    ?.getByOwner(PAGES_SITE_OWNER_TYPE, catalogId)
    .catch(() => [] as ReadmeAttachment[]) ?? Promise.resolve([] as ReadmeAttachment[]))
  return rows.filter((r) => isPagesTreePath(r.fileName))
}

/** Replaces the stored site of a catalog with `files`. */
export async function savePagesSite(
  storage: Storage,
  catalog: Pick<DataCatalog, 'id' | 'workspaceId'>,
  files: PagesTreeFile[],
): Promise<void> {
  await storage.readmeAttachments.deleteByOwner(PAGES_SITE_OWNER_TYPE, catalog.id)
  const createdAt = new Date().toISOString()
  const encoder = new TextEncoder()
  for (const file of files) {
    const bytes = encoder.encode(file.content)
    await storage.readmeAttachments.create({
      id: crypto.randomUUID(),
      ownerType: PAGES_SITE_OWNER_TYPE,
      ownerId: catalog.id,
      workspaceId: catalog.workspaceId,
      fileName: file.path,
      mimeType: file.mimeType,
      fileSize: bytes.byteLength,
      data: bytes.buffer as ArrayBuffer,
      createdAt,
    })
  }
}

export async function clearPagesSite(storage: Storage, catalogId: string): Promise<void> {
  await storage.readmeAttachments.deleteByOwner(PAGES_SITE_OWNER_TYPE, catalogId)
}

/** Writes the stored site + CI file into a catalog's repo tree. Only while the
 *  deployment is enabled: turning it off must drop the files from the next push
 *  even if clearing the stored copies failed. */
export async function writePagesSiteFiles(zip: JSZip, catalog: DataCatalog, storage: Storage): Promise<void> {
  if (!catalog.pagesDeployment) return
  for (const att of await siteAttachments(storage, catalog.id)) {
    zip.file(att.fileName, att.data)
  }
}

/** Restores the site files of a cloned catalog repo, so the next push does not
 *  read them as deleted before the user regenerates the site. */
export async function restorePagesSiteFiles(
  zip: JSZip,
  catalog: Pick<DataCatalog, 'pagesDeployment'>,
  storage: Storage,
  catalogId: string,
  workspaceId: string | undefined,
): Promise<void> {
  if (!catalog.pagesDeployment) return
  const entries = Object.values(zip.files).filter((f) => !f.dir && isPagesTreePath(f.name))
  if (entries.length === 0) return
  await storage.readmeAttachments.deleteByOwner(PAGES_SITE_OWNER_TYPE, catalogId).catch(() => {})
  for (const entry of entries) {
    const data = await entry.async('arraybuffer')
    await storage.readmeAttachments
      .create({
        id: crypto.randomUUID(),
        ownerType: PAGES_SITE_OWNER_TYPE,
        ownerId: catalogId,
        workspaceId,
        fileName: entry.name,
        mimeType: '',
        fileSize: data.byteLength,
        data,
        createdAt: new Date().toISOString(),
      })
      .catch(() => {})
  }
}
