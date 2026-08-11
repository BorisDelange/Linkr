/**
 * The download formats a mapping project offers, shared by the per-project
 * Export tab and the cross-project Global Summary.
 *
 * They used to be declared twice, which is how they drifted: the two tabs
 * offered the same three formats with different ids, filenames and options.
 * The list lives here; each tab still owns its own filtering and filename
 * prefix.
 */

/** The OHDSI vocabulary formats, offered together behind one picker. */
export type OhdsiFormat = 'ccr' | 'stcm' | 'usagi'

export const OHDSI_FORMATS: OhdsiFormat[] = ['ccr', 'stcm', 'usagi']

/**
 * C/CR is the default: CONCEPT + CONCEPT_RELATIONSHIP is the OMOP v5 way and
 * what the OHDSI tools actually read. STCM stopped being an official vocabulary
 * table at CDM 5.3 and stays on offer for ETLs that still join it.
 */
export const DEFAULT_OHDSI_FORMAT: OhdsiFormat = 'ccr'

export interface OhdsiFormatSpec {
  /** i18n key of the label shown in the picker. */
  labelKey: string
  /** Suffix + extension of the produced file, appended to the tab's prefix. */
  file: string
  mime: string
  /** True when the format produces several files and must be zipped. */
  multiFile?: boolean
}

export const OHDSI_FORMAT_SPECS: Record<OhdsiFormat, OhdsiFormatSpec> = {
  ccr: {
    labelKey: 'concept_mapping.export_ccr',
    // Two CSVs — concept.csv + concept_relationship.csv — so it ships as a ZIP.
    file: 'concept-ccr.zip',
    mime: 'application/zip',
    multiFile: true,
  },
  stcm: {
    labelKey: 'concept_mapping.export_stcm',
    file: 'source-to-concept-map.csv',
    mime: 'text/csv',
  },
  usagi: {
    labelKey: 'concept_mapping.export_usagi',
    file: 'usagi.csv',
    mime: 'text/csv',
  },
}

/**
 * The extension badge a format's card shows (`.csv`, `.zip`), matching the
 * badge the single-format cards carry.
 */
export function ohdsiExt(format: OhdsiFormat): string {
  const file = OHDSI_FORMAT_SPECS[format].file
  return file.slice(file.lastIndexOf('.'))
}

/** The two members of a C/CR export, as they are named inside the ZIP. */
export const CCR_ZIP_FILES = {
  concept: 'concept.csv',
  conceptRelationship: 'concept_relationship.csv',
} as const

/**
 * Bundle the two C/CR CSVs into a ZIP blob.
 *
 * JSZip is already a dependency of both tabs (the Linkr project export uses it),
 * so this adds no weight.
 */
export async function zipCcrFiles(
  conceptCsv: string,
  conceptRelationshipCsv: string,
): Promise<Blob> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  zip.file(CCR_ZIP_FILES.concept, conceptCsv)
  zip.file(CCR_ZIP_FILES.conceptRelationship, conceptRelationshipCsv)
  return zip.generateAsync({ type: 'blob' })
}
