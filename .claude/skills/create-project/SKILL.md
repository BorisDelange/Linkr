---
name: create-project
description: Generate a ready-to-import Linkr demo project — synthetic dataset(s), a wired dashboard (KPIs + charts + filters), IDE analysis scripts, README — assembled as a validated project tree or ZIP. Use when the user wants a demo project, sample data, a dashboard, or analysis scripts built from scratch.
argument-hint: [theme] [n-rows]
---

# Create a demo Linkr project

You author the **content**; the `linkr` MCP server assembles and validates the tree.
Everything about the format — ids, keys, layout, `_tree.json` — belongs to
`linkr-authoring`, which you should read alongside this: **`.claude/skills/linkr-authoring/SKILL.md`**
and its `references/`.

This skill is the *demo project* entry point. It adds one thing the format tools cannot:
judgement about what makes a clinically believable project.

## Steps

1. **Ask** — clinical domain, which indicators matter, whether they want IDE scripts,
   row count (~200 by default), and the output shape (folder or ZIP).
2. **Read the schema** — `describe_entity_schema("project")`, then `"dashboard"` /
   `"widget"` as you go. Prefer it over anything remembered.
3. **Author the CSV** — the part that matters most; see below.
4. **Choose the widgets** — `linkr-authoring/references/dashboard.md` lists the nine
   built-in plugins and the config keys each takes.
5. **Write** — `write_project(path, spec)`, or `format: "zip"` for the import dialog.
6. **Fix** whatever it reports, and hand over with the validation result stated plainly.

## Making a demo believable

A demo is judged on whether a clinician reading it nods. Data that type-checks but makes
no sense is the usual failure:

- ranges that occur in life — an ICU stay of 400 days does not;
- correlations that hold: a high SOFA with no organ support reads as broken, as does
  100 % mortality in a general ward;
- mortality, readmission and ventilation rates in the band the unit you are portraying
  would actually see;
- missingness where things are genuinely missing in practice, not everywhere or nowhere;
- ordered dates: admission < discharge < death.

Say in the README that the data is synthetic. Never imply a real cohort.

Pick indicators a department would actually steer on — occupancy, length of stay,
mortality, readmission at 48 h, ventilation rate — rather than whatever the columns make
easy.

## Shape of a good demo dashboard

A KPI strip (`w: 12`, `h: 8` each — four across), then charts below at `w: 24`, and two
or three filters (a period, a unit, an age range). One tab per question, not one tab per
table.

## Not seedable

**Patient Data** pages are computed live by SQL against a connected OMOP database;
nothing in a tree populates them. Say so and offer an OMOP-shaped dataset instead.
