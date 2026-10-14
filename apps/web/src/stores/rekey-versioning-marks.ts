import { rekeyMarksUnder } from '@/lib/versioning-marks'
import { useAppStore } from '@/stores/app-store'

/** Move the versioning marks under `oldKey` to `newKey` (a renamed or moved
 *  file or folder), through the project config's own save path. Resolves to
 *  whether anything was re-keyed, so an undo knows whether to move them back. */
export async function rekeyVersioningMarks(projectUid: string, oldKey: string, newKey: string): Promise<boolean> {
  const { _projectsRaw, _saveVersioningConfig } = useAppStore.getState()
  const project = _projectsRaw.find((p) => p.uid === projectUid)
  if (!project) return false
  const res = rekeyMarksUnder((project.config ?? {}) as Record<string, unknown>, oldKey, newKey)
  if (!res) return false
  await _saveVersioningConfig(projectUid, res.config)
  return true
}
