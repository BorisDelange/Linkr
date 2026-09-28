import type { SchemaMapping, SchemaPresetId } from '@/types'
import { VOCAB_TABLES } from '@/lib/concept-mapping/vocab-files'

export const ATHENA_KNOWN_TABLES = [...VOCAB_TABLES]

/**
 * How to read the ATHENA vocabulary files, written out here rather than taken
 * from a schema preset.
 *
 * This is deliberately **independent of the installed schemas**: an ATHENA
 * download always has the same shape, and the concept search must work whether
 * or not any OMOP schema is installed. `presetId` names this mapping — it is
 * never resolved against a preset (it once read `omop-cdm-5.4`, which suggested
 * a dependency that does not exist and never did).
 */
export const ATHENA_SCHEMA_MAPPING: SchemaMapping = {
  formatVersion: 2,
  presetId: 'athena-vocabulary' as SchemaPresetId,
  presetLabel: { en: 'ATHENA Vocabulary', fr: 'Vocabulaire ATHENA' },
  concepts: [{
    key: 'concept',
    from: { table: 'concept', alias: 'd' },
    fields: {
      concept_id: 'd.concept_id',
      concept_name: 'd.concept_name',
      concept_code: 'd.concept_code',
      concept_terminology: 'd.vocabulary_id',
      terminology_id: 'd.vocabulary_id',
      extra_domain_id: 'd.domain_id',
      extra_concept_class_id: 'd.concept_class_id',
      extra_standard_concept: 'd.standard_concept',
      extra_invalid_reason: 'd.invalid_reason',
    },
  }],
  knownTables: ATHENA_KNOWN_TABLES,
}
