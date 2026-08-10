import type { StandardLicenseId } from '@/types'

export type LicenseCategory = 'permissive' | 'copyleft' | 'weak-copyleft' | 'data' | 'public-domain'

export interface LicenseTemplate {
  id: StandardLicenseId
  /** Canonical title — a proper noun, same in every language. */
  title: string
  /** i18n key of the one-line summary. */
  descriptionKey: string
  category: LicenseCategory
  spdxUrl: string
}

/**
 * Licenses offered when picking one for an entity. Their texts live as raw markdown
 * next to this file and are loaded on demand (see `loadLicenseText`) — the twelve
 * texts together weigh ~200 KB, which has no business in the main bundle.
 */
export const LICENSE_TEMPLATES: LicenseTemplate[] = [
  { id: 'MIT', title: 'MIT License', descriptionKey: 'license.desc_mit', category: 'permissive', spdxUrl: 'https://spdx.org/licenses/MIT.html' },
  { id: 'Apache-2.0', title: 'Apache License 2.0', descriptionKey: 'license.desc_apache_2_0', category: 'permissive', spdxUrl: 'https://spdx.org/licenses/Apache-2.0.html' },
  { id: 'BSD-3-Clause', title: 'BSD 3-Clause License', descriptionKey: 'license.desc_bsd_3_clause', category: 'permissive', spdxUrl: 'https://spdx.org/licenses/BSD-3-Clause.html' },
  { id: 'MPL-2.0', title: 'Mozilla Public License 2.0', descriptionKey: 'license.desc_mpl_2_0', category: 'weak-copyleft', spdxUrl: 'https://spdx.org/licenses/MPL-2.0.html' },
  { id: 'GPL-3.0', title: 'GNU General Public License v3.0', descriptionKey: 'license.desc_gpl_3_0', category: 'copyleft', spdxUrl: 'https://spdx.org/licenses/GPL-3.0-only.html' },
  { id: 'AGPL-3.0', title: 'GNU Affero General Public License v3.0', descriptionKey: 'license.desc_agpl_3_0', category: 'copyleft', spdxUrl: 'https://spdx.org/licenses/AGPL-3.0-only.html' },
  { id: 'EUPL-1.2', title: 'European Union Public License 1.2', descriptionKey: 'license.desc_eupl_1_2', category: 'copyleft', spdxUrl: 'https://spdx.org/licenses/EUPL-1.2.html' },
  { id: 'CeCILL-2.1', title: 'CeCILL Free Software License Agreement v2.1', descriptionKey: 'license.desc_cecill_2_1', category: 'copyleft', spdxUrl: 'https://spdx.org/licenses/CECILL-2.1.html' },
  { id: 'CC-BY-4.0', title: 'Creative Commons Attribution 4.0 International', descriptionKey: 'license.desc_cc_by_4_0', category: 'data', spdxUrl: 'https://spdx.org/licenses/CC-BY-4.0.html' },
  { id: 'CC-BY-SA-4.0', title: 'Creative Commons Attribution-ShareAlike 4.0 International', descriptionKey: 'license.desc_cc_by_sa_4_0', category: 'data', spdxUrl: 'https://spdx.org/licenses/CC-BY-SA-4.0.html' },
  { id: 'ODbL-1.0', title: 'Open Data Commons Open Database License v1.0', descriptionKey: 'license.desc_odbl_1_0', category: 'data', spdxUrl: 'https://spdx.org/licenses/ODbL-1.0.html' },
  { id: 'CC0-1.0', title: 'Creative Commons Zero v1.0 Universal', descriptionKey: 'license.desc_cc0_1_0', category: 'public-domain', spdxUrl: 'https://spdx.org/licenses/CC0-1.0.html' },
]

const licenseTexts = import.meta.glob<string>('./texts/*.md', { query: '?raw', import: 'default' })

export function getLicenseTemplate(id: string): LicenseTemplate | undefined {
  return LICENSE_TEMPLATES.find((t) => t.id === id)
}

/** Loads a standard license's official text. Rejects on an unknown id. */
export async function loadLicenseText(id: StandardLicenseId): Promise<string> {
  const load = licenseTexts[`./texts/${id}.md`]
  if (!load) throw new Error(`Unknown license id: ${id}`)
  return await load()
}

/** Fills the `{{year}}` / `{{holder}}` tokens MIT and BSD-3-Clause carry. */
export function fillLicensePlaceholders(text: string, opts: { year: number; holder: string }): string {
  return text.replaceAll('{{year}}', String(opts.year)).replaceAll('{{holder}}', opts.holder)
}

/**
 * Display title of an entity's license: standard licenses take their canonical
 * title from the registry, custom ones the name their author gave them.
 */
export function licenseTitle(license: { id: string; name?: string } | null | undefined): string {
  if (!license) return ''
  return getLicenseTemplate(license.id)?.title ?? license.name ?? license.id
}

/** Categories in picker display order. */
export const LICENSE_CATEGORY_KEYS: Record<LicenseCategory, string> = {
  permissive: 'license.cat_permissive',
  'weak-copyleft': 'license.cat_weak_copyleft',
  copyleft: 'license.cat_copyleft',
  data: 'license.cat_data',
  'public-domain': 'license.cat_public_domain',
}
