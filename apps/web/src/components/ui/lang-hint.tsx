/** A small badge showing which language a multilingual field currently edits —
 *  switching the app language edits the matching translation. Placed next to the
 *  label of a LocalizedString field so the user can tell it apart from a plain
 *  single-value field. */
export function LangHint({ lang }: { lang: string }) {
  return (
    // `leading-none` + no vertical padding: the badge must not be taller than the
    // label text it sits next to, or the whole field drops a few pixels below a
    // neighbouring field whose label carries no hint (Name vs Type in the org form).
    // Horizontal padding alone still reads as a badge.
    <span className="rounded bg-muted px-1.5 text-[10px] font-medium uppercase leading-none text-muted-foreground">
      {lang}
    </span>
  )
}
