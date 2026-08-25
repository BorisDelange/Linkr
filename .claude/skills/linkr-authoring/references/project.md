# Project

The container: metadata, README, and the datasets / dashboards / scripts under it.

Fields: `describe_entity_schema("project")`.

## What matters

- **`projectId`** is the stable identity across instances — a slug like `icu-activity`.
  Keep it stable across rewrites of the same project; the import matches on it.
- **`appVersion`** records which format version wrote the tree. Use the repo-root
  `VERSION` file. Absent, the validator warns — nothing stamps it for a hand-written
  tree.
- **Names are `{en, fr}`** — fill both. A missing translation shows the other language,
  never a blank, but a half-translated project reads as unfinished.
- **README** — say what the project is, where the data comes from, and (for synthetic
  data) that it is synthetic. It is the first thing a reader opens.

## What never goes in a tree

`uid` and `ownerId` are the exporting instance's local keys. The app strips them on
export precisely so a re-import stays stable; writing them yourself churns the git diff
and the validator warns about both.

## Folder or ZIP

A **folder** by default: it diffs in git, and it is the shape the portal and the
`linkr-public-content` repos consume. A **ZIP** (`format: "zip"`) is what the app's
*Import a project* dialog takes — hand one over when the user will drag it in.

## Not seedable

**Patient Data** pages are computed live by SQL against a connected OMOP database. No
tree can populate them. Offer an OMOP-shaped dataset instead and say why.
