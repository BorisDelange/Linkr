import { describe, expect, it } from 'vitest'
import { analysisFileKeys } from './entity-io'

// Twin of test_analyses_sharing_a_name_or_unnamed_each_get_their_own_file
// (apps/api/tests/test_project_export.py): both writers must name the files alike.
describe('analysisFileKeys', () => {
  it('gives analyses sharing a name, or with none, a file each, suffixed in creation order', () => {
    const keys = analysisFileKeys([
      { id: 'z', name: '', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', name: 'Age', createdAt: '2026-01-03T00:00:00.000Z' },
      { id: 'a', name: '', createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'c', name: 'Age', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect(keys.map(([k, a]) => [k, a.id])).toEqual([['age', 'c'], ['analysis', 'z'], ['analysis-2', 'a'], ['age-2', 'b']])
  })
})
