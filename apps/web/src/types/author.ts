import type { LocalizedString } from './index'

/** Structured author identity captured alongside the plain display-name string.
 *  All fields optional so old data (name-only) and old exports stay valid.
 *  `affiliation` and `profession` are multilingual (an institution/role often
 *  has an official name per language); name/email/orcid are single-value facts.
 *  Legacy plain strings are read transparently via `localized()`. */
export interface AuthorDetails {
  firstName?: string
  lastName?: string
  email?: string
  affiliation?: LocalizedString | string
  profession?: LocalizedString | string
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

/** Mixin giving a standalone-exportable entity a stable cross-instance identity,
 *  separate from its local primary key (id/uid). The PK may be regenerated on
 *  import/duplicate to keep local uniqueness; `lineageId` is preserved verbatim
 *  so the *same work* stays recognizable across instances (catalog dedup, "same
 *  element" detection). A duplicate/fork mints a fresh `lineageId` and records
 *  the original in `parentLineageId` — a weak reference (the parent may not be
 *  present locally or in a catalog; the link resolves if it later appears).
 *  Optional → old data and old exports stay valid. */
export interface Lineaged {
  lineageId?: string
  parentLineageId?: string
}
