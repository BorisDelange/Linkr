import i18n from '@/lib/i18n'
import { isServerMode } from '@/lib/api-client'
import { fetchIdeFileDataUrl } from '@/lib/api/ide-files'
import { useFileStore } from '@/stores/file-store'
import type { IdeFile } from '@/types'

/** Shows an image file of the IDE tree as a figure in the output panel. An SVG
 *  is text, so the tree already holds it; a raster image is fetched raw from the
 *  server, and re-fetched on every open so a regenerated plot shows its new state. */
export async function openImageInOutput(file: Pick<IdeFile, 'id' | 'name' | 'content'>): Promise<void> {
  const { addOutputTab, setOutputVisible, files, activeProjectUid } = useFileStore.getState()
  const id = `image-${file.id}`
  const show = (type: 'figure' | 'text', content: string) => addOutputTab({ id, label: file.name, type, content })
  setOutputVisible(true)

  const inline = /\.svg$/i.test(file.name) || file.content?.startsWith('data:image') ? file.content : undefined
  if (inline) return show('figure', inline)

  const path = treePath(files, file.id)
  if (!isServerMode() || !activeProjectUid || !path) return show('text', i18n.t('files.image_unavailable'))
  show('text', i18n.t('files.image_loading'))
  const src = await fetchIdeFileDataUrl(activeProjectUid, path)
  show(src ? 'figure' : 'text', src ?? i18n.t('files.image_unavailable'))
}

/** Path relative to the IDE root: in server mode the top-level nodes ARE the
 *  working dir's entries, so the walk keeps every ancestor. */
function treePath(files: IdeFile[], id: string): string {
  const parts: string[] = []
  let node = files.find((f) => f.id === id)
  while (node) {
    parts.unshift(node.name)
    const parentId = node.parentId
    node = parentId ? files.find((f) => f.id === parentId) : undefined
  }
  return parts.join('/')
}
