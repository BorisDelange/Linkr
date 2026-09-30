# Deployment context — where Linkr sits in a clinical data warehouse

The frame every security and compliance decision is taken against. User-facing version:
`linkr-website/src/pages/docs/concepts/health-data-warehouse.mdx` (FR + EN) — keep the two
consistent. Open security work derived from this frame:
[planning/security-compliance-plan.md](planning/security-compliance-plan.md).

## The layers

| # | Layer | Owner | Linkr? |
|---|-------|-------|--------|
| 1 | Hospital information system (EHR, lab, pharmacy, billing) | care | no |
| 2 | Loading + warehouse — **bronze** (raw copy, pseudonymised on entry) and **silver** (cleaned, deduplicated, one model — sometimes already OMOP) | CDW engineering (ETL) | no |
| 3 | Project **datamart** — the subset an approved study may use, extracted and re-pseudonymised by the CDW platform | CDW management platform | no |
| 4 | **SPE** (*Secure Processing Environment*) — one per project, cut off from the internet, two-factor access, exports only through a controlled checkpoint. Hosts RStudio, Jupyter, Linkr | the SPE | **yes** |

Linkr runs **inside the SPE** and takes the datamart from **silver to gold**. In this repo,
*gold* means the datamart **quality-checked and standardised for one project, still in
the warehouse's long format** (event tables, OMOP when possible) — not the wide analysis
tables. Going long → wide comes after gold (pipeline → datasets → dashboards). Many
medallion write-ups put aggregates / wide tables in gold; we deliberately don't.

What Linkr does there: data-quality rule sets, ETL pipelines (local format → OMOP when the
datamart is not OMOP), concept mapping, SQL script collections, cohorts, derived
sub-databases, datasets, analyses, dashboards, reports.

A **global instance**, outside any SPE and any research project, centralises the
institution's know-how: concept mappings, SQL collections, DQ rule sets, ETL pipelines,
wiki. It holds **no patient data**. Content flows global → SPE by import or git; an
improvement made in a project flows back SPE → global only through the SPE's export
checkpoint, and must carry no patient-level data.

## What Linkr does not do — and must not be relied on for

| Need | Handled by |
|------|------------|
| Load the warehouse, pseudonymise it | CDW loading pipeline |
| Accounts and authorisations on the CDW | CDW management platform |
| Extract a project's regulatory datamart, per-project pseudonyms | CDW management platform |
| Two-factor authentication, network isolation, disk encryption | SPE |
| Approve / check exports leaving the SPE | SPE export checkpoint |

Consequences for design:

- **A cohort or a derived sub-database built inside an SPE keeps the datamart's
  identifiers.** Per-project re-pseudonymisation already happened upstream.
- **Linkr's roles organise a team's work; they are not a regulatory partition.** The
  recommended deployment is **one Linkr instance per SPE**, never one instance shared by
  several research projects.

## What Linkr must still guarantee

Inheriting the SPE's security only holds if Linkr does not undo it from the inside:

1. **No privilege escalation inside an instance.** A member with a low role must not
   become admin, read another member's database password, rewrite the access log, or
   reach files outside what the deployment mounted. (Today it can — see the plan, item
   A1.)
2. **Traceability of what happens inside Linkr.** The SPE logs who entered; only Linkr
   knows which queries ran and which files were produced. Every row-level read and every
   download must reach the access log, which is also written to stdout for the
   institution's collector (SIEM).
3. **Nothing patient-level in what travels to the global instance.** Mapping projects,
   DQ rule sets, SQL collections, wiki pages exported from an SPE must carry no
   patient-level values and no small counts.
4. **Aggregate-only restitution when asked.** A dashboard shown to people who may only
   see aggregates must be computed server-side with small-cell suppression, including
   under filtering.
5. **Works offline.** No runtime dependency on the internet in server mode:
   - package installs go through institution mirrors (`pip_index_url`, `r_repos`);
   - the community catalog and git remotes are optional;
   - the MCP ships its docs index (`packages/linkr-mcp/data/docs-index.json.gz`);
   - AI agents use a model hosted inside the SPE.

## Deployment modes in this frame

- **Server mode** is the SPE deployment. Every guarantee above assumes it.
- **Client-only (WASM)** keeps data in the browser, has no login, no server audit, and
  loads Pyodide/webR from a CDN on first use. It is for demos, portals, open or synthetic
  data — **never an SPE deployment for real patient data**.
