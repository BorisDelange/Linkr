# OMOP Vocabulary Data — Attribution Notice

This directory contains a subset of standardized medical vocabularies
in OMOP Common Data Model format, filtered to the concepts required by
the MIMIC-IV demo ETL pipeline.

## Included Vocabularies

| Vocabulary | Publisher | License |
|---|---|---|
| ICD-9-CM | National Center for Health Statistics (NCHS), CMS | Public domain (US government work) |
| ICD-9-Proc | Centers for Medicare & Medicaid Services (CMS) | Public domain (US government work) |
| ICD-10-CM | CDC / NCHS | Public domain (US government work) |
| ICD-10-PCS | CMS | Public domain (US government work) |
| NDC | US Food and Drug Administration (FDA) | Public domain / CC0 |
| SNOMED CT | SNOMED International | See note below |
| RxNorm | National Library of Medicine (NLM) | UMLS license |
| LOINC | Regenstrief Institute | LOINC license |
| UCUM | Regenstrief Institute | UCUM license |

## Notes

- **ICD-9-CM, ICD-9-Proc, ICD-10-CM, ICD-10-PCS**: Works of the
  United States Government and are not subject to copyright protection
  within the United States.

- **NDC (National Drug Code)**: Released by the FDA under Public Domain
  / Creative Commons Zero (CC0).

- **SNOMED CT**: Copyright © SNOMED International. Only a small subset
  of SNOMED concepts (those mapped from ICD codes used in MIMIC-IV) is
  included here. Users requiring the full SNOMED vocabulary should
  obtain a license from SNOMED International or their National Release
  Center. In the US, SNOMED CT is distributed free of charge via the
  NLM UMLS.

- **RxNorm**: Produced by the National Library of Medicine. RxNorm is
  available under the UMLS Metathesaurus License. Only the concepts
  mapped from NDC codes in MIMIC-IV are included.

- **LOINC**: Copyright © Regenstrief Institute, Inc. Only the concepts
  referenced by MIMIC-IV lab and chart items are included. The full
  LOINC vocabulary is available at https://loinc.org.

## OMOP CDM Format

The concept identifiers (concept_id), relationships, and domain
assignments follow the OHDSI OMOP Common Data Model conventions. The
original vocabulary data was obtained from ATHENA (https://athena.ohdsi.org).

## Source

ATHENA — OHDSI Vocabularies Repository: https://athena.ohdsi.org
