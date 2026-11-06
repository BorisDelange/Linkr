# User documentation — what is missing

The end-user docs live in `../linkr-website` (`src/pages/docs/`, FR + `src/pages/en/docs/`
EN). This file is the single list of gaps between the app and those pages; the other
planning files do not carry doc items. Use the `update-website-docs` skill to write them.

*Checked against the site on 2026-11-06, committed pages only: `linkr-website` also holds
uncommitted edits to `project/concepts` and `warehouse/databases` (the database Concepts tab);
commit them or they stay gaps. `<PlannedFeature>` pages remain for the Pipeline, reports
and skills.*

## Out of date

| Page | Gap | Effort |
|------|-----|--------|
| `administration/database-connectors`, `getting-started/install-manual` | Tell users to install the `doris` extra, removed from the API (Arrow Flight now comes with core `pyarrow`), and quote an old banner | S |
| `warehouse/databases` | Describes one stored password per database. Now: a personal account per user and database (prompt on first use, *Database accounts* tab, session-only option), credentials dropped when the target changes | S |
| `concept-mapping/target-concepts`, `concept-mapping/mapping-projects` | Concept sets now come from the workspace dictionaries (portable refs on export, detach instead of delete, missing sets listed on import); OHDSI vocabularies from the workspace library. `target-concepts` still points to the workspace settings | S |
| `administration/server-files` | Table still places the vocabulary folder under *Concept mapping › Vocabulary* (now the workspace *Vocabularies* page). The concept-mapping source file, dataset import and IDE upload can now come from the server | S |
| `ai-automation/skills` | Still documents the skills zip; rewrite when the MCP serves skills | S |

## Missing

| Topic | Where | Effort |
|-------|-------|--------|
| **Priority** — threat model of database credentials (`design/per-user-db-credentials-plan.md` §11): what another user, an admin, a backup, the server root and a script or agent can see | `administration/` | S |
| *Warehouse › Vocabularies*: landing with two widgets; OHDSI vocabularies and Data dictionaries pages, each with a browse tab and a manage tab | `warehouse/` | M |
| The unsorted-Parquet warning on the Statistics tab, and how to sort | `warehouse/databases` | S |

## When the feature ships

Update the page in the same change as the feature.

| Feature | Page |
|---------|------|
| REDCap / XLSForm import wired | `dashboards/survey-widgets` (drop the "not wired yet" callout), `project/datasets` |
| Server file picker on scores and ETL | `administration/server-files` |
| Pipeline execution, reports, skills | Flip their `<PlannedFeature>` pages to real content |
