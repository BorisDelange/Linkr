import { useCallback, useState } from 'react'
import { normalizeConceptFlag } from '@/lib/concept-mapping/concept-flags'
import { ATHENA_SCHEMA_MAPPING } from '@/lib/vocabulary-library/schema-mapping'
import { ConceptDetailSheet, type ConceptInfoTarget } from './ConceptDetailSheet'
import { ConceptSearchTable, type ConceptSearchRow } from './ConceptSearchTable'

interface VocabularyBrowserProps {
  /** The vocabulary database (the workspace library) to search. */
  dataSourceId: string
}

/**
 * Search and browse the concepts of an OHDSI vocabulary database — the same
 * table as the Mapping Editor's target panel — with an Info button opening the
 * concept (details, relations, hierarchy, synonyms). Used by a mapping
 * project's Target concepts tab and the workspace Vocabularies page. Fills its
 * parent's height: the table scrolls, never the page.
 */
export function VocabularyBrowser({ dataSourceId }: VocabularyBrowserProps) {
  const [infoTarget, setInfoTarget] = useState<ConceptInfoTarget | null>(null)

  const openInfo = useCallback((r: ConceptSearchRow) => setInfoTarget({
    concept_id: r.concept_id,
    concept_name: r.concept_name,
    concept_code: r.concept_code || undefined,
    vocabulary_id: r.vocabulary_id || undefined,
    domain_id: r.domain_id || undefined,
    concept_class_id: r.concept_class_id || undefined,
    standard_concept: normalizeConceptFlag(r.standard_concept) || undefined,
    invalid_reason: r.invalid_reason || undefined,
  }), [])

  return (
    <>
      <div className="h-full min-h-0 overflow-hidden rounded-lg border">
        <ConceptSearchTable dataSourceId={dataSourceId} mapping={ATHENA_SCHEMA_MAPPING} onInfo={openInfo} />
      </div>
      <ConceptDetailSheet
        target={infoTarget}
        open={infoTarget !== null}
        onOpenChange={(open) => { if (!open) setInfoTarget(null) }}
        dataSourceId={dataSourceId}
        conceptTable="concept"
      />
    </>
  )
}
