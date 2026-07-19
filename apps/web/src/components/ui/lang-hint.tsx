/** A small badge showing which language a multilingual field currently edits —
 *  switching the app language edits the matching translation. Placed next to the
 *  label of a LocalizedString field so the user can tell it apart from a plain
 *  single-value field. */
export function LangHint({ lang }: { lang: string }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
      {lang}
    </span>
  )
}
