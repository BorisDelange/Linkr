/**
 * Packing for the data-dictionary cell.
 *
 * A concept can belong to several dictionaries at once, so the Concepts table
 * carries their names in one cell value and splits them back into one button
 * per set. The separator therefore has to be something a set name cannot
 * contain — ", " could, and a set called "Labs, chemistry" split into two
 * phantom buttons that resolved to no set at all.
 */

/** Separator between the set names packed into one cell value. */
export const SET_SEP = '\u0000'

/** Pack the set names a concept belongs to into one cell value. */
export function packSetNames(names: string[]): string {
  return [...new Set(names.filter(Boolean))].join(SET_SEP)
}

/** Unpack a packed cell value back into the individual set names. */
export function unpackSetNames(value: string): string[] {
  return value ? value.split(SET_SEP) : []
}
