import type { SchemaMapping, SchemaOverrides } from '@/types/schema-mapping'

// Plan step 10: the same drug administrations described twice — pivoted out of
// an entity-attribute-value warehouse (one row per recorded attribute, the
// attribute codes varying by site) and read from OMOP `drug_exposure`. Both
// must honour the drug contract, so every consumer reads them alike.

/** An EAV warehouse: `facts` holds one row per attribute of an entry; the drug
 *  entry names the drug, sibling rows of the same entry carry dose, unit, rate
 *  and route, each under its attribute code. */
export const eavMapping: SchemaMapping = {
  formatVersion: 2,
  presetId: 'eav-demo',
  presetLabel: { en: 'EAV warehouse' },
  patient: { from: { schema: 'eav', table: 'patients', alias: 'p' }, fields: { patient_id: 'p.patient_id' } },
  concepts: [{
    key: 'drugs',
    from: { schema: 'eav', table: 'drug_codes', alias: 'd' },
    fields: { concept_id: 'd.code', concept_name: 'd.label', concept_code: 'd.code' },
  }],
  drugs: [{
    label: 'Administrations',
    drugKind: 'administration',
    customSql: `SELECT d.patient_id, d.stay_id AS visit_id, d.text_value AS concept_id, d.recorded_at AS start_datetime,
  MAX(CASE WHEN f.attribute = 'DOSE' THEN f.num_value END) AS amount_value,
  MAX(CASE WHEN f.attribute = 'DOSE_UNIT' THEN f.text_value END) AS amount_unit,
  MAX(CASE WHEN f.attribute = 'RATE' THEN f.num_value END) AS rate_value,
  MAX(CASE WHEN f.attribute = 'ROUTE' THEN f.text_value END) AS route
FROM eav.facts d
LEFT JOIN eav.facts f ON f.entry_id = d.entry_id AND f.attribute <> d.attribute
WHERE d.attribute = 'DRUG'
GROUP BY ALL`,
    sqlColumns: ['patient_id', 'visit_id', 'concept_id', 'start_datetime', 'amount_value', 'amount_unit', 'rate_value', 'route'],
  }],
}

/** A second site of the same warehouse, which records the rate under another
 *  code: it overrides the relation's SQL in its own database. */
export const siteOverrides: SchemaOverrides = {
  relations: {
    'drugs.Administrations': { ...eavMapping.drugs![0], customSql: eavMapping.drugs![0].customSql!.replace("'RATE'", "'RATE_ML_H'") },
  },
}

/** The OMOP twin: the same administrations in `drug_exposure`, built visually. */
export const omopMapping: SchemaMapping = {
  formatVersion: 2,
  presetId: 'omop-demo',
  presetLabel: { en: 'OMOP' },
  patient: { from: { table: 'person', alias: 'p' }, fields: { patient_id: 'p.person_id' } },
  concepts: [{
    key: 'concept',
    from: { table: 'concept', alias: 'c' },
    fields: { concept_id: 'c.concept_id', concept_name: 'c.concept_name', concept_code: 'c.concept_code' },
  }],
  drugs: [{
    label: 'Drug exposures',
    drugKind: 'administration',
    from: { table: 'drug_exposure', alias: 'de' },
    fields: {
      patient_id: 'de.person_id',
      visit_id: 'de.visit_occurrence_id',
      concept_id: 'de.drug_concept_id',
      start_datetime: 'de.drug_exposure_start_datetime',
      end_datetime: 'de.drug_exposure_end_datetime',
      quantity: 'de.quantity',
      route_concept_id: 'de.route_concept_id',
      route: 'de.route_source_value',
      dose_source_value: 'de.dose_unit_source_value',
    },
  }],
}
