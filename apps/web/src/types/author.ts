/** Structured author identity captured alongside the plain display-name string.
 *  All fields optional so old data (name-only) and old exports stay valid. */
export interface AuthorDetails {
  firstName?: string
  lastName?: string
  affiliation?: string
  profession?: string
  orcid?: string
}

/** Mixin adding creator provenance to any entity. `createdBy` is the display
 *  name (kept for compatibility); `createdByDetails` holds the structured
 *  identity (affiliation, profession, ORCID). Both optional → back-compatible. */
export interface Authored {
  /** Stable id of the creating user. Preferred for display: the name is resolved
   *  live from the user directory, so a profile rename shows everywhere. */
  createdById?: number
  /** Display-name snapshot at creation time. Fallback when the id can't be
   *  resolved (author left, or cross-instance import). */
  createdBy?: string
  createdByDetails?: AuthorDetails
}
