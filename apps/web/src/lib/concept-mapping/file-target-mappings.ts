/**
 * Alignments that come with an imported source file.
 *
 * A file whose rows already carry a target concept id (someone started the
 * mapping elsewhere) gives, besides its source concepts, one mapping per
 * (source concept, target id). They are credited to the user who imports the
 * file and enter the review flow like any other mapping.
 */
import type { AuthorDetails, ConceptMapping, FileColumnMapping, MappingProject } from '@/types'

/** A row of the source view joined to the target id(s) its raw file row holds. */
export interface AlignedSourceRow {
  concept_id: number
  concept_name?: string | null
  concept_code?: string | null
  vocabulary_id?: string | null
  domain_id?: string | null
  concept_class_id?: string | null
  category?: string | null
  subcategory?: string | null
  record_count?: number | null
  aligned_target: string | null
}

/** Target concept details, as the vocabulary library holds them. */
export interface TargetConceptDetails {
  conceptId: number
  conceptName: string
  vocabularyId: string
  domainId: string
  conceptCode: string
  conceptClassId?: string
  standardConcept?: string
}

/** The concept ids of a cell: one or several, separated by `;`, `,`, `|` or spaces. */
export function parseTargetIds(cell: string | number | null | undefined): number[] {
  if (cell == null) return []
  const ids = String(cell)
    .split(/[;,|\s]+/)
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
  return [...new Set(ids)]
}

/**
 * SQL over a file source's views: every deduplicated source concept with the
 * target cell of each raw row it came from (a concept listed twice with two
 * targets keeps both).
 */
export function alignedSourceRowsSql(columnMapping: FileColumnMapping): string {
  const on = columnMapping.terminologyColumn
    ? 's.vocabulary_id IS NOT DISTINCT FROM r.vocabulary_id AND s.concept_code IS NOT DISTINCT FROM r.concept_code'
    : 's.concept_code IS NOT DISTINCT FROM r.concept_code'
  return 'SELECT s.*, r.target_concept_id AS aligned_target '
    + `FROM source_concepts s JOIN source_concepts_raw r ON ${on} `
    + "WHERE r.target_concept_id IS NOT NULL AND TRIM(r.target_concept_id) <> ''"
}

/** The distinct target ids of the rows, to look their details up. */
export function alignedTargetIds(rows: readonly AlignedSourceRow[]): number[] {
  return [...new Set(rows.flatMap((r) => parseTargetIds(r.aligned_target)))]
}

/**
 * The mappings the rows describe, minus those the project already has (same
 * source concept and target). A target missing from the vocabulary library is
 * kept with its id alone: the alignment is what the file states.
 */
export function buildFileTargetMappings(
  project: Pick<MappingProject, 'id'>,
  rows: readonly AlignedSourceRow[],
  targets: ReadonlyMap<number, TargetConceptDetails>,
  existing: readonly Pick<ConceptMapping, 'sourceVocabularyId' | 'sourceConceptCode' | 'targetConceptId'>[],
  author: { name: string; details?: AuthorDetails },
  now: string,
  newId: () => string = () => crypto.randomUUID(),
): ConceptMapping[] {
  const key = (vocab: string, code: string, target: number) => `${vocab}\0${code}\0${target}`
  const seen = new Set(existing.map((m) => key(m.sourceVocabularyId ?? '', m.sourceConceptCode ?? '', m.targetConceptId)))
  const out: ConceptMapping[] = []
  for (const row of rows) {
    const vocab = row.vocabulary_id ?? ''
    const code = row.concept_code ?? ''
    for (const targetId of parseTargetIds(row.aligned_target)) {
      const k = key(vocab, code, targetId)
      if (seen.has(k)) continue
      seen.add(k)
      const t = targets.get(targetId)
      out.push({
        id: newId(),
        projectId: project.id,
        sourceConceptId: Number(row.concept_id),
        sourceConceptName: row.concept_name ?? '',
        sourceVocabularyId: vocab,
        sourceDomainId: row.domain_id ?? '',
        sourceConceptCode: code,
        sourceFrequency: row.record_count ?? undefined,
        sourceCategoryId: row.category ?? undefined,
        sourceSubcategoryId: row.subcategory ?? undefined,
        sourceConceptClassId: row.concept_class_id ?? undefined,
        targetConceptId: targetId,
        targetConceptName: t?.conceptName ?? '',
        targetVocabularyId: t?.vocabularyId ?? '',
        targetDomainId: t?.domainId ?? '',
        targetConceptCode: t?.conceptCode ?? '',
        targetConceptClassId: t?.conceptClassId,
        targetStandardConcept: t?.standardConcept,
        mappingType: 'maps_to',
        equivalence: 'skos:exactMatch',
        status: 'unchecked',
        mappedBy: author.name,
        mappedByDetails: author.details,
        mappedOn: now,
        createdAt: now,
        updatedAt: now,
      })
    }
  }
  return out
}
