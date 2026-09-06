A document viewer for one patient's notes: discharge summaries, progress notes,
radiology reports — whatever your source system writes as free text and your ETL
maps into the OMOP `note` table.

This is a per-patient widget, not a cohort analysis. It reads the note table
mapped in your database schema for the patient whose chart is open, and shows
what is there. If no note table is mapped, the widget says so.

![The Clinical notes widget: the list of a patient's documents on the left, a
discharge summary open on the right, with the searched term highlighted in the
text.](attachments/output.png)

Above: one document open among 29, with a search for `pneumonia` matching 18 of
them — the counter beside the search box gives the match count, and the term is
highlighted in the body.

## Settings

None. The widget has nothing to configure; everything it offers lives in its own
toolbar, above the document list:

- **Sort** — by date or by name.
- **Filter** — over document titles and types, to narrow a long list.
- **Search** — full text over the note bodies, with matches highlighted and a
  counter showing how many documents match.
- **Word sets** — named, coloured groups of terms you save once and re-apply. A
  set highlights all of its terms wherever they appear, and can optionally filter
  the list down to the documents that contain them.

Each document shows its title, date and type. In OMOP that type usually comes
from the note's source value, so what you see is your source system's own
document category ("Discharge summary", "Nursing note", a local code), not a
standardised vocabulary. Documents are listed newest first. Where a note carries
a visit id the viewer shows it, and selecting a visit in the sidebar narrows the
list to that visit's documents.

## Word sets are a keyword match

A word set highlights literal terms. It has no notion of negation, of who the
subject is, or of a phrase copied forward from an earlier note — so a highlight
marks a place to look, not a finding. The counter tells you how many documents
contain a term, which is a search result and not a prevalence.

Sets are saved and reusable, so a set built once for a project ("bleeding",
"delirium", "device") stays available on every patient chart.

## Screenshots and exports leave the viewer

> [!WARNING]
> **Notes are the most identifying part of a record, and this widget shows them
> in full.** Free text routinely contains names, dates, places and phone numbers
> even in an extract described as de-identified, because de-identification
> pipelines work far better on structured fields than on prose. Reading a note on
> a chart is one thing; a screenshot in a slide deck, an exported figure or a
> shared dashboard is another, and takes the text outside whatever governs your
> warehouse. Check what is actually on screen before capturing it.

## What the widget reads

Only the mapped `note` table. It does not read `note_nlp`, so any annotation
your pipeline produced is not shown here. A document missing from the list is
missing from the mapping — the place to look is the ETL, not this widget.

## Further reading

- [OMOP CDM v5.4 specification](https://ohdsi.github.io/CommonDataModel/cdm54.html) — what the `note` table stores, and how note type and source value differ.
- [The Book of OHDSI, *Extract, Transform, Load*](https://ohdsi.github.io/TheBookOfOhdsi/ExtractTransformLoad.html) — where document types and visit links are decided, which is what determines this list.
- [El Emam K & Dankar FK, *Protecting privacy using k-anonymity*](https://pmc.ncbi.nlm.nih.gov/articles/PMC2528029/) — why removing names is not the same as anonymising, worked through on health data.
- [Stubbs A, Kotfila C & Uzuner Ö, *Automated systems for the de-identification of longitudinal clinical narratives*](https://pmc.ncbi.nlm.nih.gov/articles/PMC4989908/) — how well automatic de-identification performs on real notes, and where it fails.
