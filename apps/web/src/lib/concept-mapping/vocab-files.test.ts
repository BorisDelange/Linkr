import { describe, expect, it } from 'vitest'
import {
  compareVocabFiles,
  isConceptFile,
  isVocabFile,
  tableNameOf,
  VOCAB_TABLES,
} from './vocab-files'

describe('tableNameOf', () => {
  it('strips the folder and the extension', () => {
    expect(tableNameOf('INDICATE_PARQUET/CONCEPT.parquet')).toBe('concept')
    expect(tableNameOf('CONCEPT_RELATIONSHIP.csv')).toBe('concept_relationship')
    expect(tableNameOf('a\\b\\DOMAIN.tsv')).toBe('domain')
  })
})

describe('isVocabFile', () => {
  it('accepts every OMOP vocabulary table', () => {
    // The metadata tables were previously rejected, which left a complete ATHENA
    // folder importing only 4 of its files and broke the ETL vocabulary script.
    for (const t of VOCAB_TABLES) {
      expect(isVocabFile(`ATHENA/${t.toUpperCase()}.parquet`)).toBe(true)
    }
  })

  it('accepts the metadata tables an ETL pipeline needs', () => {
    for (const t of ['vocabulary', 'domain', 'concept_class', 'relationship']) {
      expect(isVocabFile(`${t}.csv`)).toBe(true)
    }
  })

  it('rejects anything that is not a vocabulary table', () => {
    expect(isVocabFile('concept_embeddings.parquet')).toBe(false)
    expect(isVocabFile('README.md')).toBe(false)
    expect(isVocabFile('patients.parquet')).toBe(false)
  })
})

describe('isConceptFile', () => {
  it('matches only CONCEPT itself', () => {
    expect(isConceptFile('CONCEPT.parquet')).toBe(true)
    expect(isConceptFile('CONCEPT_SYNONYM.parquet')).toBe(false)
    expect(isConceptFile('CONCEPT_ANCESTOR.parquet')).toBe(false)
  })
})

describe('compareVocabFiles', () => {
  it('puts the required table first, then sorts alphabetically', () => {
    const files = [
      'DOMAIN.parquet', 'CONCEPT_SYNONYM.parquet', 'CONCEPT.parquet', 'VOCABULARY.parquet',
    ]
    expect([...files].sort(compareVocabFiles).map(tableNameOf)).toEqual([
      'concept', 'concept_synonym', 'domain', 'vocabulary',
    ])
  })

  it('is stable whatever the folder order', () => {
    const a = ['VOCABULARY.parquet', 'CONCEPT.parquet', 'DOMAIN.parquet']
    const b = ['DOMAIN.parquet', 'VOCABULARY.parquet', 'CONCEPT.parquet']
    expect([...a].sort(compareVocabFiles)).toEqual([...b].sort(compareVocabFiles))
  })
})
