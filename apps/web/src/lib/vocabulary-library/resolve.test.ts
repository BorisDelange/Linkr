import { describe, it, expect } from 'vitest'
import { vocabularyDataSourceIdFor } from './resolve'

const library = (vocabularies: unknown[]) => ({
  id: 'lib', workspaceId: 'ws', isVocabularyReference: true, connectionConfig: { vocabularyLibrary: true, vocabularies },
})
const legacy = { id: 'old', workspaceId: 'ws', isVocabularyReference: true, connectionConfig: {} }

describe('vocabularyDataSourceIdFor', () => {
  it('reads the workspace library once it holds vocabularies', () => {
    expect(vocabularyDataSourceIdFor({ workspaceId: 'ws', vocabularyDataSourceId: 'old' }, [legacy, library([{}])])).toBe('lib')
  })

  // Until the older databases are added to it, an empty library must not hide them.
  it('falls back to the project\'s own older vocabulary database', () => {
    expect(vocabularyDataSourceIdFor({ workspaceId: 'ws', vocabularyDataSourceId: 'old' }, [legacy, library([])])).toBe('old')
    expect(vocabularyDataSourceIdFor({ workspaceId: 'ws', vocabularyDataSourceId: 'gone' }, [library([])])).toBeUndefined()
  })

  it('never reads another workspace\'s library', () => {
    expect(vocabularyDataSourceIdFor({ workspaceId: 'other' }, [library([{}])])).toBeUndefined()
  })
})
