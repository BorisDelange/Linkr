import type { AuthorDetails, User } from '@/types'

/**
 * User identity helpers shared by the profile page and the admin user form.
 * Pure functions — the display/mapping/validation logic lives here (and is
 * unit-tested) rather than inside the React components.
 */

/** Full display name from first/last, falling back to the username. */
export function userDisplayName(u: Pick<User, 'firstName' | 'lastName' | 'username'>): string {
  const full = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim()
  return full || u.username
}

/** Project the identity fields of a User into the structured AuthorDetails
 *  used for provenance (wiki authorship, etc.), dropping empty values. */
export function userToAuthorDetails(u: Partial<User>): AuthorDetails {
  const details: AuthorDetails = {}
  if (u.firstName?.trim()) details.firstName = u.firstName.trim()
  if (u.lastName?.trim()) details.lastName = u.lastName.trim()
  if (u.affiliation?.trim()) details.affiliation = u.affiliation.trim()
  if (u.profession?.trim()) details.profession = u.profession.trim()
  if (u.orcid?.trim()) details.orcid = u.orcid.trim()
  return details
}

/**
 * Validate an ORCID iD. Canonical form is four 4-digit groups separated by
 * hyphens, last char may be an "X" checksum digit: 0000-0002-1825-0097.
 * Empty is allowed (the field is optional); non-empty must match exactly.
 */
export function isValidOrcid(orcid: string | undefined | null): boolean {
  if (!orcid || !orcid.trim()) return true
  return /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(orcid.trim())
}

/** Normalize loose ORCID input into canonical hyphenated form when it is 16
 *  digits (optionally with a trailing X), otherwise return it untouched so the
 *  validator can reject it. Accepts full-URL and space/hyphen-separated input. */
export function normalizeOrcid(orcid: string): string {
  const stripped = orcid.trim().replace(/^https?:\/\/orcid\.org\//i, '')
  const compact = stripped.replace(/[\s-]/g, '').toUpperCase()
  if (/^\d{15}[\dX]$/.test(compact)) {
    return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}`
  }
  return orcid.trim()
}
