# User documentation — what is missing

The end-user docs live in `../linkr-website` (`src/pages/docs/`, FR + `src/pages/en/docs/`
EN). This file is the single list of gaps between the app and those pages; the other
planning files do not carry doc items. Use the `update-website-docs` skill to write them.

*Checked against the site on 2026-09-29: 81 pages in each language, no `<DraftPage>`
stub left, `<PlannedFeature>` pages for web apps, the Pipeline, reports and skills.*

## Out of date

| Page | Gap | Effort |
|------|-----|--------|
| `workspace/settings` | Lists four tabs (members, badges, environments, deletion); the *Vocabularies* and *Data dictionaries* tabs are missing | S |
| `project/concepts` | Says a data dictionary is imported from the project's *Concept settings*; it is now installed in Workspace settings and only picked by the project | S |
| `concept-mapping/target-concepts`, `concept-mapping/mapping-projects` | Concept sets now come from the workspace dictionaries (portable refs on export, detach instead of delete, missing sets listed on import); OHDSI vocabularies from the workspace library | S |
| `administration/server-files` | Table still places the vocabulary folder under *Concept mapping › Vocabulary* (now Workspace settings); the concept-mapping source file can now come from the server | S |
| `warehouse/databases` | Describes one stored password per database. Now: a personal account per user and database (prompt on first use, *Database accounts* tab, session-only option), credentials dropped when the target changes | S |

## Missing

| Topic | Where | Effort |
|-------|-------|--------|
| Threat model of database credentials (per-user-db-credentials plan §11): what an admin, a server root and a script can see | `administration/` | S |

## When the feature ships

Update the page in the same change as the feature.

| Feature | Page |
|---------|------|
| REDCap / XLSForm import wired | `dashboards/survey-widgets` (drop the "not wired yet" callout), `project/datasets` |
| Server file picker, category B (datasets, scores, IDE, ETL) | `administration/server-files` |
| Web apps, Pipeline execution, reports, skills | Flip their `<PlannedFeature>` pages to real content |
| Workspace export of dictionary pointers | `sharing/import-export` |
