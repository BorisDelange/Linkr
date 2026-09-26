# Health-DCAT-AP — Summary for Linkr

> Based on [Health-DCAT-AP **Release 8**](https://data.health.europa.eu/healthdcat-ap/releases/release-8/) (September 2026) — the EU metadata
> standard for describing health datasets under the EHDS Regulation (EU 2025/327) — and on
> **Commission Implementing Regulation (EU) 2026/2098**, which makes it the legal basis for dataset
> descriptions. Reviewed 2026-09-26.
>
> **Where the spec lives.** Since Release 8 the normative home is the HealthData@EU production site:
> [data.health.europa.eu/healthdcat-ap/releases/latest/](https://data.health.europa.eu/healthdcat-ap/releases/latest/)
> — the URL the regulation itself cites. The source repository stays on
> [code.europa.eu/healthdataeu/healthdcat-ap](https://code.europa.eu/healthdataeu/healthdcat-ap)
> (as of 2026-09-26 it had not yet received the R8 commits; the published site had, dated 22 Sep 2026).
> The old `healthdataeu.pages.code.europa.eu/…/latest/` still redirects to Release 7 — do not link it.
> `healthdcat-ap.github.io` is only a migration notice and `SEMICeu/HealthDCAT-AP` does not exist.
> The cadence is roughly four-monthly (R6 Nov 2025, R7 May 2026, R8 Sep 2026).

## What is Health-DCAT-AP?

Health-DCAT-AP is a **metadata profile** (not a data format) built on top of DCAT-AP 3.0.
It tells other systems **what data you have** — not the data itself.

Think of it like a library card catalog: it describes each book (dataset) so people can find and request it, without giving them the book.

### The stack

```
Health-DCAT-AP    ← Health-specific extensions (EHDS Art. 51 categories, HDAB, coding systems...)
    ↑
DCAT-AP 3.0.x     ← EU Application Profile for data portals (data.europa.eu)
    ↑
DCAT 3             ← W3C standard for describing datasets on the web
    ↑
RDF / JSON-LD      ← Linked Data format (machine-readable, interoperable)
```

### Why does it exist?

The **European Health Data Space (EHDS)** regulation requires that health datasets (EHR, registries, claims, genomics, etc.) be **discoverable** across EU member states. Health-DCAT-AP standardizes how you describe your dataset so it can be:
- Indexed by the EU dataset catalogue of the HealthData@EU central platform
- Found by researchers, health data access bodies (HDABs), and other institutions
- Compared across countries (same vocabulary for access rights, categories, coding systems)

### What it does NOT do

- It does **not** contain patient data
- It does **not** define a data format (CSV, Parquet, FHIR...)
- It does **not** grant access — it describes **how to request** access

---

## What's new — September 2026 (reviewed 2026-09-26)

### 1. The implementing act is adopted: Regulation (EU) 2026/2098

**Verified** (EUR-Lex, [CELEX 32026R2098](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32026R2098)):

- **Title:** *Commission Implementing Regulation (EU) 2026/2098 of 18 September 2026 laying down
  the minimum metadata elements and their characteristics to be provided by health data holders
  for dataset descriptions for the secondary use of electronic health data under Article 77(4) of
  Regulation (EU) 2025/327 establishing the European Health Data Space.*
- **Published:** OJ L, 2026/2098, 21.9.2026. **In force** 20 days later (11 Oct 2026).
  **Applies from 26 March 2029** — same date as the EHDS secondary-use obligations.
- **Who:** health data holders, when they give dataset descriptions to their HDAB (Art. 60(3) EHDS),
  and authorised participants in HealthData@EU. Extra metadata beyond the minimum is allowed (Art. 1(3)).
- **How (Art. 3):** the minimum elements must be expressed *"by using the definitions, structure,
  cardinalities and controlled vocabularies set out in the HealthDCAT-AP"*. Annex Part A points to
  `https://data.health.europa.eu/healthdcat-ap/releases/latest/` — a moving target: **the
  regulation binds to whatever release is current**, not to a frozen version.
- **Annex Part B** lists **27 elements** in a two-column table (Property / Description). There is no
  mandatory/recommended column: every element is to be provided, some qualified by
  *"where applicable"* / *"where … exists"* in their description (marked *cond.* below).
- **Annex Part C:** health data category = Art. 51(1)(a)–(q) EHDS; other vocabularies = those of HealthDCAT-AP.

This replaces what this doc said before ("nothing is legally binding yet; the implementing act is due
March 2027"): the act came early, and it is now binding law with a 2029 application date.

### 2. Health-DCAT-AP Release 8 (published ~22 Sep 2026)

From the [R8 changelog](https://data.health.europa.eu/healthdcat-ap/releases/release-8/changelog.html):

| Change | Detail | Impact on Linkr |
|---|---|---|
| New `healthdcatap:hdabCoordinator` | Dataset, 0..1, `foaf:Agent` with exactly one `cv:contactPoint` | Optional; add when cross-border |
| New `dct:title` on `csvw:TableGroup` | 1..n, **mandatory** | We emit no TableGroup title |
| `csvw:title` replaces `csvw:titles` on Column (SHACL + examples) | Column also gets `csvw:name` **exactly 1** (not multilingual) | We emit `csvw:titles` → fails R8 SHACL |
| Controlled vocabularies moved to production | Base URL `https://hdeu-dcat.data.health.europa.eu/resource/authority/…` (was `…acceptance…`) for health categories, health theme, publisher type, health activity, standard, coding system | Bind to these URIs |
| Coding-system vocabulary extended | adds EMDN, DICOM-CT, EMA-SPOR, NCIT, HPO, ORDO, **OHDSI-VOCAB**, NPU, WHODRUG, + placeholders ICD-10-NAT, PROC-CODES-NAT | `OHDSI-VOCAB` is the exact value for an OMOP vocabulary |
| Standard vocabulary gets a "type of standard" tree | includes **`OMOP-CDM`**, FHIR, openEHR, CDISC-SDTM… | Use `…/standard/OMOP-CDM` for `dct:conformsTo` |
| Dataset property table now alphabetical | Cosmetic; no obligation changes | — |
| Spec moved to `data.health.europa.eu`, licence added | | Update links in code |

Obligations did not change between R7 and R8 apart from the two new properties above; the R7
delta (hasStructuredData, hasVariables, hasCodingSystem vs conformsTo) is still the big one for us.
DCAT-AP / DCAT are unchanged (R8 imports DCAT-AP 3.0.1; there is no DCAT-AP 4 or DCAT 4).

### 3. Regulation 2026/2098 elements → Health-DCAT-AP property → Linkr

Mapping of each Annex B element to its R8 property is **ours** (the regulation names elements, not
URIs); it is unambiguous for all but "Is structured" (→ `healthdcatap:hasStructuredData`). The
"R8 NON-PUBLIC" column is the SHACL severity in the official validator shapes for the non-public
profile (the realistic one for a hospital warehouse): **V** = violation (mandatory), **W** = warning
(recommended), — = no minimum.

| # | Regulation element | R8 property | R8 NON-PUBLIC | Linkr `schema.ts` today | Verdict |
|---|---|---|---|---|---|
| 1 | Access rights | `dct:accessRights` | V (1..1) | `dataset.accessRights`, mandatory | OK |
| 2 | Applicable legislation *(cond.)* | `dcatap:applicableLegislation` | V | hard-coded EHDS in `jsonld.ts` | OK (URI lacks `/oj`, cosmetic) |
| 3 | Code values *(cond.)* | `healthdcatap:hasCodeValues` | W | — | **Missing** |
| 4 | Coding system *(cond.)* | `healthdcatap:hasCodingSystem` | W | `dataset.codingSystem` but emitted as `dct:conformsTo` | **Wrong property + vocabulary** |
| 5 | Contact point | `dcat:contactPoint` (vcard:Kind) | V | only `cv:contactPoint` on the publisher agent | **Missing on Dataset** |
| 6 | Conforms to | `dct:conformsTo` (Standard NAL) | W | used for coding systems instead | **Wrong** (should be `OMOP-CDM`) |
| 7 | Custodian | `geodcatap:custodian` | W | `dataset.custodian`, optional, name only | Obligation too low; agent lacks contact point |
| 8 | Description | `dct:description` | V | mandatory | OK |
| 9 | Distribution | `dcat:distribution` | V (1..*) | user distribution + auto ones | Partly — auto ones lack `dcat:accessURL` (see §CDW) |
| 10 | Geographical coverage *(cond.)* | `dct:spatial` (Location IRI) | — | `dataset.spatial`, free text | **Wrong type** (needs country NAL IRI) |
| 11 | Has personal data | `dpv:hasPersonalData` | W | `dataset.personalData` emitted as `healthdcatap:hasPersonalData` | **Wrong URI** (term does not exist) |
| 12 | Health data access body *(cond.: restricted/non-public)* | `healthdcatap:hdab` | V (1..1, agent with contact point) | `dataset.hdab`, optional, name only | **Obligation too low**; agent lacks contact point |
| 13 | Health data category | `healthdcatap:healthCategory` | V (1..*) | mandatory, but custom codes (`EHR`, `IMAGING`…) emitted as strings | **Wrong vocabulary** (17 NAL IRIs) |
| 14 | Health theme | `healthdcatap:healthTheme` | W | — (`dataset.theme` is `dcat:theme`, free text) | **Missing** |
| 15 | Identifier | `dct:identifier` | V | mandatory | OK |
| 16 | Is structured | `healthdcatap:hasStructuredData` | V (1..1) | — | **Missing** (mandatory since R7) |
| 17 | Keyword | `dcat:keyword` | V (1..*) | optional | Obligation too low |
| 18 | Language | `dct:language` | W | optional | Obligation too low |
| 19 | Number of records *(cond.)* | `healthdcatap:numberOfRecords` | W | optional, auto-filled | OK (raise to recommended) |
| 20 | Number of unique individuals *(cond.)* | `healthdcatap:numberOfUniqueIndividuals` | W | optional, auto-filled | OK (raise to recommended) |
| 21 | Provenance | `dct:provenance` (ProvenanceStatement) | V (1..*) | — | **Missing** |
| 22 | Publisher | `dct:publisher` | 0..1, agent with contact point | `dataset.publisher`, optional, name only | Obligation too low; agent lacks contact point |
| 23 | Temporal coverage *(cond.)* | `dct:temporal` (PeriodOfTime start/end) | W | `dataset.temporal`, free text; **overwritten by `retentionPeriod`** | **Wrong type + bug** |
| 24 | Title | `dct:title` | V | mandatory | OK |
| 25 | Type | `dct:type` (dataset-type NAL) | V (1..*) | — (`agent.type` exists, not dataset) | **Missing** |
| 26 | Variables | `healthdcatap:hasVariables` → `csvw:TableGroup` | V when structured | CSVW built, but hung on Distributions via `csvw:tableGroup` | **Wrong place** (re-parent to Dataset) |
| 27 | Was generated by | `prov:wasGeneratedBy` (Activity, health-activity NAL) | — | — | **Missing** |

Also R8-mandatory for NON-PUBLIC but not in the regulation: `dcat:theme` ≥1 IRI (EU data-theme,
e.g. `…/data-theme/HEAL`) — we emit free text. Retention period is `healthdcatap:retentionPeriod`
(a PeriodOfTime), not `dct:temporal`.

Summary: **8 OK or nearly**, **10 missing or mapped to the wrong term**, the rest need a higher
obligation level or a typed value (IRI / period) instead of free text.

---

## Core Classes

Obligations below follow R8 (and its NON-PUBLIC SHACL shapes). "Reg." marks elements the
2026/2098 regulation requires data holders to provide.

### 1. Catalog (`dcat:Catalog`)
The top-level container — represents your institution's data offering.

| Property | URI | Obligation | Notes |
|----------|-----|-----------|-------|
| **title** | `dct:title` | **Mandatory** | Multilingual name |
| **description** | `dct:description` | **Mandatory** | What the catalog contains |
| **applicable legislation** | `dcatap:applicableLegislation` | **Mandatory** | Must reference EHDS Regulation |
| **publisher** | `dct:publisher` | **Mandatory** (1..1) | Organization managing the catalog |
| language | `dct:language` | Recommended | Catalog language(s) |
| homepage | `foaf:homepage` | Recommended | URL |
| release date | `dct:issued` | Recommended | |
| modification date | `dct:modified` | Recommended | |
| dataset | `dcat:dataset` | Recommended | Links to Dataset(s) |

### 2. Dataset (`dcat:Dataset`)
Describes one dataset (e.g., "MIMIC-IV", "French National Cancer Registry").

**Mandatory (NON-PUBLIC profile):**

| Property | URI | Notes |
|----------|-----|-------|
| **title** / **description** | `dct:title` / `dct:description` | Multilingual, language-tagged. Reg. |
| **identifier** | `dct:identifier` | UUID, DOI, catalogue ID. Reg. |
| **access rights** | `dct:accessRights` | EU access-right NAL. Reg. |
| **applicable legislation** | `dcatap:applicableLegislation` | EHDS Regulation. Reg. (cond.) |
| **health category** | `healthdcatap:healthCategory` | 17 NAL IRIs (below). Reg. |
| **HDAB** | `healthdcatap:hdab` | 1..1, `foaf:Agent` with `cv:contactPoint`. Reg. for restricted/non-public |
| **structured data** | `healthdcatap:hasStructuredData` | `xsd:boolean`, 1..1. Reg. ("Is structured") |
| **variables** | `healthdcatap:hasVariables` | → `csvw:TableGroup`; mandatory when structured. Reg. |
| **contact point** | `dcat:contactPoint` | `vcard:Kind` with email or URL. Reg. |
| **keyword** | `dcat:keyword` | ≥1. Reg. |
| **type** | `dct:type` | dataset-type NAL. Reg. |
| **provenance** | `dct:provenance` | `dct:ProvenanceStatement` (free text label). Reg. |
| **theme** | `dcat:theme` | ≥1 EU data-theme IRI (`HEAL`) |
| **distribution** | `dcat:distribution` | ≥1; for non-public, one pointing to the HDAB access. Reg. |

**Recommended / optional that matter for a warehouse:**

| Property | URI | Notes |
|----------|-----|-------|
| coding system | `healthdcatap:hasCodingSystem` | Coding-system NAL (SNOMED-CT, LOINC, ICD-10, OHDSI-VOCAB…). Reg. (cond.) |
| code values | `healthdcatap:hasCodeValues` | Literal codes present in the data. Reg. (cond.) |
| conforms to | `dct:conformsTo` | Standard NAL — the **data model** (`OMOP-CDM`). Reg. |
| health theme | `healthdcatap:healthTheme` | health-theme NAL. Reg. |
| was generated by | `prov:wasGeneratedBy` | `prov:Activity` typed with health-activity NAL (`HOSPITAL_RECORDS`, `ROUTINE_RECORDS`…). Reg. |
| custodian | `geodcatap:custodian` | Agent with contact point. Reg. |
| publisher | `dct:publisher` | Agent with contact point. Reg. |
| language | `dct:language` | Reg. |
| personal data | `dpv:hasPersonalData` | DPV personal-data concepts (`dpv-pd:Age`, `dpv-pd:HealthRecord`…). Reg. |
| number of records / unique individuals | `healthdcatap:numberOfRecords` / `numberOfUniqueIndividuals` | `xsd:nonNegativeInteger`. Reg. (cond.) |
| min / max typical age | `healthdcatap:minTypicalAge` / `maxTypicalAge` | `xsd:nonNegativeInteger` |
| population coverage | `healthdcatap:populationCoverage` | Literal |
| temporal coverage | `dct:temporal` | `dct:PeriodOfTime` with `dcat:startDate`/`dcat:endDate`. Reg. (cond.) |
| geographical coverage | `dct:spatial` | Country/place NAL IRI. Reg. (cond.) |
| retention period | `healthdcatap:retentionPeriod` | `dct:PeriodOfTime` |
| analytics | `healthdcatap:analytics` | Distribution(s) with aggregate statistics — see §CDW |
| sample | `adms:sample` | Distribution with a synthetic sample |
| purpose / legal basis | `dpv:hasPurpose` / `dpv:hasLegalBasis` | |
| frequency | `dct:accrualPeriodicity` | EU frequency NAL |
| HDAB coordinator | `healthdcatap:hdabCoordinator` | **New in R8**, 0..1 |

### 3. Distribution (`dcat:Distribution`)
How the data can actually be accessed.

| Property | URI | Obligation | Notes |
|----------|-----|-----------|-------|
| **access URL** | `dcat:accessURL` | **Mandatory** | Where to go to get / request the data |
| **applicable legislation** | `dcatap:applicableLegislation` | **Mandatory** (HealthDCAT-AP) | |
| format | `dct:format` | Recommended | EU file-type NAL (CSV, HTML…) |
| licence | `dct:license` | Recommended | |
| description | `dct:description` | Recommended | |
| title | `dct:title` | Optional | |
| download URL | `dcat:downloadURL` | Optional | Direct file link |
| media type | `dcat:mediaType` | Optional | IANA type (`text/csv`) |
| linked schemas | `dct:conformsTo` | Optional | Schema the file follows |

### 4. Agent (`foaf:Agent`) — publisher, HDAB, custodian, coordinator

| Property | URI | Obligation | Notes |
|----------|-----|-----------|-------|
| **name** | `foaf:name` | **Mandatory** | |
| **contact point** | `cv:contactPoint` | **Mandatory, exactly 1** for publisher, HDAB, HDAB coordinator | `cv:ContactPoint` with `cv:email` / `cv:contactPage` |
| type | `dct:type` | Recommended | publisher-type NAL |

### 5. CSVW variables (`healthdcatap:hasVariables`)
Describes the **variables** (columns) in your dataset. Since R7 it hangs **directly off the Dataset**.

| Class | Property | Obligation | Notes |
|-------|----------|-----------|-------|
| **TableGroup** | `dct:title` | **Mandatory** (new in R8) | |
| **TableGroup** | `csvw:table` | **Mandatory** | |
| **Table** | `dct:title` | **Mandatory** | |
| **Table** | `csvw:column` | **Mandatory** | |
| Table | `csvw:url` | Optional | Should point to a **synthetic/anonymised** CSV |
| **Column** | `csvw:name` | **Mandatory, exactly 1** (R8) | Technical name, not multilingual |
| **Column** | `csvw:title` | **Mandatory** (R8 — was `csvw:titles`) | Human label, may be multilingual |
| **Column** | `dct:description` | **Mandatory** | |
| **Column** | `csvw:datatype` | **Mandatory** | CSVW built-in names — case-sensitive (`dateTime`, not `datetime`) |
| Column | `csvw:propertyUrl` | Optional | Link to a standard concept |

---

## EHDS Article 51 — Health Categories

Values are IRIs of the DG SANTE NAL
`https://hdeu-dcat.data.health.europa.eu/resource/authority/healthcategories/<CODE>`
(one per Art. 51(1)(a)–(q)). Labels below are the NAL's English labels, shortened.

| Code | Category |
|------|----------|
| `EHRS` | Electronic health data from EHRs — **the one for a hospital warehouse** |
| `DIOH` | Factors impacting on health (socio-economic, environmental, behavioural) |
| `NRPE` | Aggregated data on healthcare needs, resources, provision, expenditure |
| `PGEH` | Personal health data automatically generated through medical devices |
| `IDHP` | Professional status / specialisation of health professionals |
| `PHDR` | Population-based health data registries (public health registries) |
| `MRMR` | Medical registries and mortality registries |
| `EHCT` | Clinical trials, studies, investigations and performance studies |
| `EMRD` | Other health data from medical devices |
| `RMMD` | Registries for medicinal products and medical devices |
| `RQSH` | Research cohorts, questionnaires and surveys (after first publication) |
| `EINS` | Biobanks and associated databases |
| `HRAD` | Healthcare-related administrative data (dispensations, claims, reimbursements) |
| `HGPD` | Human genetic, epigenomic and genomic data |
| `HPML` | Other human molecular data (proteomic, transcriptomic, metabolomic…) |
| `RPDG` | Data on pathogens that impact human health |
| `WELA` | Data from wellness applications |

The list Linkr currently offers (`EHR`, `CLAIMS`, `COHORT`, `IMAGING`, `SURVEY`…) is a home-made
approximation: it is not the NAL, and `IMAGING` / `ADMINISTRATIVE`-as-such are not Art. 51 categories.

---

## Access Rights

Three levels, with different requirements:

| Level | Meaning | HDAB required? |
|-------|---------|---------------|
| **PUBLIC** | Open data, no access restrictions | No |
| **RESTRICTED** | Available under conditions (e.g., research agreement) | Yes |
| **NON_PUBLIC** | Not publicly accessible, requires formal data access request | Yes (mandatory) |

For **non-public** health data (most hospital data), you must specify:
- A **Health Data Access Body (HDAB)** — the entity handling data access requests, with a contact point
- A **Distribution** pointing to the HDAB's access URL

---

## Describing a clinical data warehouse (OMOP CDM) — is our approach right?

*Plain-language section. Reviewed 2026-09-26 against R8, the R8 SHACL shapes and example, the
Sciensano design paper and the HealthDCAT-AP literacy site.*

**The short version.** Health-DCAT-AP wants three different things kept apart:

1. **What the data looks like** — the *model* (OMOP CDM), the *vocabularies* (SNOMED, LOINC…) and
   the *variables* (tables and columns). These are metadata properties of the Dataset.
2. **How to get the data** — *distributions*. For hospital data that is almost always "ask the HDAB".
3. **What you can learn without getting the data** — *analytics*: dashboards, reports, aggregate
   counts. HealthDCAT-AP has a dedicated slot for this: `healthdcatap:analytics`.

Linkr currently puts almost everything in bucket 2. The content is right; the slots are not.

### (1) Describing the data model and the schema

| What | Standard way (R8) | What `jsonld.ts` does | Verdict |
|---|---|---|---|
| "This warehouse is OMOP CDM" | `dct:conformsTo <…/standard/OMOP-CDM>` on the Dataset | nothing; `conformsTo` holds the coding systems | **Wrong** — the data model is the main filter a researcher uses |
| "It uses SNOMED CT, LOINC, RxNorm, OMOP vocabularies" | `healthdcatap:hasCodingSystem <…/coding-system/SNOMED-CT>`, `…/LOINC`, `…/RXNORM`, `…/OHDSI-VOCAB` | `dct:conformsTo <http://snomed.info/sct>` … | **Wrong property and wrong IRIs** |
| "Here are the tables and columns" | `healthdcatap:hasStructuredData true` + `healthdcatap:hasVariables` → one `csvw:TableGroup` (with a `dct:title`) on the **Dataset** | `csvw:TableGroup` nested inside a CSV `dcat:Distribution` via `csvw:tableGroup` | **Right content, wrong place** — a non-standard predicate the validator ignores; and `csvw:titles` must become `csvw:title` |
| "These codes appear in the data" | `healthdcatap:hasCodeValues "U07.1"` (literals) | nothing | Optional; could list top concept codes |

For an OMOP warehouse, the natural variables description is the **CDM tables and columns** (what
`buildCsvwFromFullSchema` already produces). The concept list is *not* a variables description:
concepts are values of `*_concept_id` columns, not columns.

### (2) Describing the concepts with their counts

**There is no Health-DCAT-AP property for "concept X occurs in N patients".** No DQV, SDMX or
StatDCAT construct has been adopted into the profile for this either. What the profile offers is:

- dataset-level numbers: `numberOfRecords`, `numberOfUniqueIndividuals`, `minTypicalAge`,
  `maxTypicalAge`, `populationCoverage` — we fill these;
- `healthdcatap:analytics` — *"visualisations, analytics services (e.g. dashboards), technical reports
  (e.g. dataset metrics), quality and usability indicators, querying services (e.g. Beacon API)"*,
  which *"facilitate data discoverability and understanding without directly accessing the underlying
  data"* (HealthDCAT-AP literacy site). The R8 example uses it for an *"Aggregate analytics report"*
  CSV of *"aggregate indicators"*. It is **recommended** (warning) in the non-public profile.

So a per-concept count table is exactly an **analytics distribution**. Publishing it is a Linkr
*value-add* on top of the standard (the TEHDAS2 user guideline calls it "variable-level insight"),
not something the standard defines column by column — so the CSVW that documents `concepts.csv`'s
own columns is fine as documentation, but no catalogue will interpret it semantically.

### (3) Are the CSV files and the HTML page correct distributions?

| Our output | Today | Should be |
|---|---|---|
| User distribution (access URL, format, licence) | `dcat:distribution` | Keep. For non-public data, make it the **HDAB request page**. |
| CSVW data dictionary (schema) | `dcat:distribution` with no access URL, CSVW nested | Move the CSVW to `healthdcatap:hasVariables`. If the dictionary is also published as a file, it is an `adms:sample` or a plain distribution **with** `dcat:accessURL` |
| HTML concept catalog | `dcat:distribution` (HTML) | `healthdcatap:analytics`, with `dcat:accessURL` = the page |
| `concepts.csv`, `dimensions.csv` | `dcat:distribution` (CSV), no access URL | `healthdcatap:analytics`, with `dcat:accessURL` (+ `dcat:downloadURL` if the file itself is online) |

Why it matters: `dcat:distribution` means "a way to obtain *this dataset*". A CSV of aggregate counts
is not the dataset; listing it there tells a catalogue the data is downloadable, which is false for
non-public data. And every `dcat:Distribution` — analytics ones included — needs `dcat:accessURL`
(DCAT-AP mandatory); three of ours have none, which the validator rejects. `dcat:mediaType`
(`text/csv`, `text/html`) and `dct:title` are optional but cheap.

### (4) Publishing anonymised aggregate counts next to the metadata

- The EHDS itself foresees answering requests in an *"anonymised statistical format"* (recital 72;
  Art. 69 data requests), and the literacy site presents `analytics` as the metadata hook for that.
- **There is no EU-wide threshold for small counts.** The TEHDAS2 draft guideline on anonymisation
  (Sept 2025) reports that HDABs chose k-anonymity values *"between 3 and 100"* and says fixed values
  are unlikely; parameter ranges per context are recommended instead. National HDAB / DPO rules decide.
- Practical consequence for Linkr: before a concepts/dimensions table is attached as a **public**
  analytics distribution, apply small-cell suppression (configurable threshold, default ≥ 10 is a
  common hospital choice — our assumption, not an EU rule) and say so in the distribution's
  `dct:description`. Exact `COUNT(DISTINCT)` wording in our descriptions should not be published
  unsuppressed for a non-public warehouse.

### Verdict

The architecture holds — computing a concept-level catalog and attaching it is aligned with where
the EU catalogue is going. What needs fixing is the mapping: data model → `conformsTo`,
vocabularies → `hasCodingSystem`, schema → `hasVariables`, counts/HTML → `analytics`, and every
distribution gets an access URL.

---

## JSON-LD Output

Health-DCAT-AP metadata is serialized as **JSON-LD**. Target shape for a Linkr OMOP warehouse
(R8, abridged — not what `jsonld.ts` emits today, see the gap table):

```json
{
  "@context": {
    "dcat": "http://www.w3.org/ns/dcat#",
    "dcatap": "http://data.europa.eu/r5r/",
    "dct": "http://purl.org/dc/terms/",
    "foaf": "http://xmlns.com/foaf/0.1/",
    "cv": "http://data.europa.eu/m8g/",
    "csvw": "http://www.w3.org/ns/csvw#",
    "dpv": "https://w3id.org/dpv#",
    "prov": "http://www.w3.org/ns/prov#",
    "vcard": "http://www.w3.org/2006/vcard/ns#",
    "healthdcatap": "http://healthdataportal.eu/ns/health#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
    "xsd": "http://www.w3.org/2001/XMLSchema#"
  },
  "@type": "dcat:Dataset",
  "dct:title": { "@value": "MIMIC-IV Demo — OMOP CDM", "@language": "en" },
  "dct:identifier": "mimic-iv-demo-omop",
  "dct:accessRights": { "@id": "http://publications.europa.eu/resource/authority/access-right/NON_PUBLIC" },
  "dcatap:applicableLegislation": { "@id": "http://data.europa.eu/eli/reg/2025/327/oj" },
  "healthdcatap:healthCategory": { "@id": "https://hdeu-dcat.data.health.europa.eu/resource/authority/healthcategories/EHRS" },
  "dcat:theme": { "@id": "http://publications.europa.eu/resource/authority/data-theme/HEAL" },
  "dct:conformsTo": { "@id": "https://hdeu-dcat.data.health.europa.eu/resource/authority/standard/OMOP-CDM" },
  "healthdcatap:hasCodingSystem": [
    { "@id": "https://hdeu-dcat.data.health.europa.eu/resource/authority/coding-system/OHDSI-VOCAB" },
    { "@id": "https://hdeu-dcat.data.health.europa.eu/resource/authority/coding-system/SNOMED-CT" },
    { "@id": "https://hdeu-dcat.data.health.europa.eu/resource/authority/coding-system/LOINC" }
  ],
  "prov:wasGeneratedBy": { "@type": "prov:Activity",
    "dct:type": { "@id": "https://hdeu-dcat.data.health.europa.eu/resource/authority/health-activity/HOSPITAL_RECORDS" } },
  "dct:provenance": { "@type": "dct:ProvenanceStatement", "rdfs:label": "ETL from the hospital EHR to OMOP CDM 5.4" },
  "dcat:contactPoint": { "@type": "vcard:Kind", "vcard:hasEmail": { "@id": "mailto:cdw@example.org" } },
  "healthdcatap:hdab": { "@type": "foaf:Agent", "foaf:name": "…",
    "cv:contactPoint": { "@type": "cv:ContactPoint", "cv:email": "hdab@example.org" } },
  "healthdcatap:numberOfUniqueIndividuals": { "@value": "100", "@type": "xsd:nonNegativeInteger" },
  "healthdcatap:hasStructuredData": { "@value": "true", "@type": "xsd:boolean" },
  "healthdcatap:hasVariables": { "@type": "csvw:TableGroup", "dct:title": "OMOP CDM tables",
    "csvw:table": [ { "@type": "csvw:Table", "dct:title": "person", "csvw:column": [
      { "csvw:name": "person_id", "csvw:title": "Person ID", "dct:description": "…", "csvw:datatype": "integer" } ] } ] },
  "dcat:distribution": { "@type": "dcat:Distribution",
    "dcat:accessURL": { "@id": "https://hdab.example.org/request" },
    "dcatap:applicableLegislation": { "@id": "http://data.europa.eu/eli/reg/2025/327/oj" } },
  "healthdcatap:analytics": [
    { "@type": "dcat:Distribution", "dct:title": "Concept catalog",
      "dcat:accessURL": { "@id": "https://linkr.example.org/catalog/mimic-iv" },
      "dct:format": { "@id": "http://publications.europa.eu/resource/authority/file-type/HTML" },
      "dcatap:applicableLegislation": { "@id": "http://data.europa.eu/eli/reg/2025/327/oj" } },
    { "@type": "dcat:Distribution", "dct:title": "Concept counts (small cells suppressed)",
      "dcat:accessURL": { "@id": "https://linkr.example.org/catalog/mimic-iv" },
      "dcat:downloadURL": { "@id": "https://linkr.example.org/catalog/mimic-iv/concepts.csv" },
      "dcat:mediaType": { "@id": "http://www.iana.org/assignments/media-types/text/csv" },
      "dcatap:applicableLegislation": { "@id": "http://data.europa.eu/eli/reg/2025/327/oj" } }
  ]
}
```

---

## How Linkr Uses This

In Linkr, the Health-DCAT-AP tab on a Data Catalog lets you:

1. **Describe your dataset** with standardized metadata (title, description, access rights, health categories, coding systems...)
2. **Auto-fill** numeric fields from computed catalog results (number of records, patients, age range)
3. **Generate JSON-LD** that could be:
   - Embedded in the exported HTML catalog (`<script type="application/ld+json">`)
   - Submitted to a national Health Data Access Body portal
   - Indexed by the EU dataset catalogue
4. **Document variables** as CSVW from the warehouse schema

### What the existing EU portal shows

The [EU Health Data Portal](https://ehds.healthdataportal.eu/) currently lists ~20 national catalogs (Belgium, Croatia, France, Germany, etc.). Most entries describe **registries** (cancer, rare diseases) or **administrative databases** at the national level.

**None of them currently include a detailed breakdown of available variables/concepts** — they only describe the dataset at a high level (title, category, temporal coverage, population size). This is where Linkr can add value: by computing the actual catalog of concepts with counts, and attaching it as a CSVW variables description and an analytics distribution.

---

## Differences from Our Current Implementation

**Resolved 2026-09-26** — `schema.ts`, `jsonld.ts` and the Health-DCAT-AP tab now follow R8
(NON-PUBLIC profile). Every gap of the audit below is closed:

- Fields: `dct:type`, `dct:provenance`, `dcat:contactPoint`, `hasStructuredData`, `healthTheme`,
  `hasCodeValues`, `prov:wasGeneratedBy`, `hdabCoordinator` added; obligations raised to the SHACL
  severities (HDAB mandatory unless access is PUBLIC); agents are grouped fields
  (`publisher.*`, `hdab.*`, `custodian.*`, `coordinator.*`) each emitted with a `cv:contactPoint`.
- Vocabularies: the production NALs (health categories, health themes, standard, coding system,
  health activity, publisher type) plus the EU dataset-type, data-theme, country and DPV-PD lists.
- JSON-LD: data model → `dct:conformsTo`, terminologies → `hasCodingSystem`, schema →
  `hasVariables` (TableGroup with `dct:title`, `csvw:title`, `dateTime`), the published page and
  CSVs → `healthdcatap:analytics` with `dcat:accessURL` (from the *Published catalog URL* field,
  relative file names otherwise), temporal coverage and retention as separate `dct:PeriodOfTime`,
  personal data as `dpv:hasPersonalData`, ELI `…/2025/327/oj`.
- Metadata saved before R8 is read through `normalizeDcatMetadata` (keys renamed, codes mapped,
  untyped free text dropped); tests in `lib/dcat-ap/jsonld.test.ts` and `schema.test.ts`.

Still open: running the official R8 SHACL shapes in a test (see *Validating the output*).

### Validating the output

The EU publishes a **public SHACL validator** — no login, accepts JSON-LD, three
profiles (PUBLIC / NON-PUBLIC / RESTRICTED):
[health-data-itb-rdf-validator.acceptance.data.health.europa.eu/shacl/ehds/upload](https://health-data-itb-rdf-validator.acceptance.data.health.europa.eu/shacl/ehds/upload).
The R8 shapes are also downloadable from the spec page (`html/shacl/…/ehds/shapes/*.ttl`) and could
be run locally in a test. NON-PUBLIC is the realistic profile for a hospital warehouse.

---

## Is this still the right approach? (reviewed 2026-09-26)

**Yes — and the EU catalogue is moving toward what Linkr already computes.**

The TEHDAS2 guideline for data users navigating the catalogue (21 April 2026)
names **"Variable-Level Insight"** a core discovery pillar: *data dictionaries and
proxy datasets, to assess the feasibility of a research hypothesis without access
to primary health data*. Its documented filters are the Art. 51 categories, coding
systems **and data models** (it names "OMOP Common Data Model" explicitly),
population size and age range — i.e. concepts, counts, age range, temporal
coverage. That is this feature's output. R8 now has exact vocabulary values for it
(`standard/OMOP-CDM`, `coding-system/OHDSI-VOCAB`).

Worth knowing about the neighbours:

- **OHDSI has no metadata standard for describing a CDM instance.** `CDM_SOURCE`
  is ~11 fields; the `METADATA` table's "phase 2 — concept-level standardization"
  never shipped. Achilles produces the descriptive statistics but no DCAT output.
  EHDEN's catalogue records only coarse per-source metadata. Bridging OMOP's
  concept-level richness to the EU's discovery standard is the differentiator here.
- **FHIR is not a competitor for this.** EHDS splits the layers deliberately —
  FHIR/DICOM for *exchange*, OMOP for *semantics*, DCAT-AP for *discovery*. No
  FHIR resource is an analogue of `dcat:Dataset`. Do not pivot the catalog to it.
- **DCAT-AP 3.0.x / DCAT 3 are stable.** No DCAT 4 and no DCAT-AP 4.
- Optional reach, if it is ever wanted: a **schema.org `Dataset`** block alongside
  the JSON-LD buys Google Dataset Search visibility.

**It is now law, with a 2029 date.** The obligation to describe datasets is EHDS **Article 77**
(Art. 51 defines the data *categories*); its implementing act, **Regulation (EU) 2026/2098**, was
adopted 18 Sep 2026 and applies from **26 March 2029**. Because it binds to "latest" HealthDCAT-AP,
Linkr should track releases — but the spec is still labelled *Draft Specification*, so a light
re-check at each release (≈ every four months) is enough.

### For reference — what Release 7 had changed

| Aspect | Release 6 | Release 7 |
|--------|-----------|-----------|
| Structured data flag | — | `healthdcatap:hasStructuredData` **mandatory 1..1** |
| Variables | CSVW on Distribution | `healthdcatap:hasVariables` on Dataset |
| Model vs terminologies | mixed | `dct:conformsTo` = data model (Standard NAL), `hasCodingSystem` = terminologies (Coding-system NAL) |
| Catalog publisher | 0..1 | 1..1 |

### For reference — what Release 6 had changed

| Aspect | Older draft | Release 6 |
|--------|------------|-----------|
| Namespace | `http://healthdcat-ap.eu/ns#` | `http://healthdataportal.eu/ns/health#` |
| `applicableLegislation` | Missing | **Mandatory** on Catalog, Dataset, Distribution |
| HDAB (Health Data Access Body) | Missing | **Mandatory** on Dataset for non-public data |
| Custodian (data holder) | Missing | Optional on Dataset |
| CSVW (variable descriptions) | Missing | New classes: TableGroup, Table, Column |
| Contact Point | vCard `vcard:Kind` | CPSV `cv:ContactPoint` (EU Core Vocabulary) on agents |
| Health category values | Custom | EHDS Art. 51 controlled vocabulary |

---

## Sources

Verified 2026-09-26.

- [Commission Implementing Regulation (EU) 2026/2098](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32026R2098) — OJ L 2026/2098, 21.9.2026 (EUR-Lex); secondary summary: [Produktkanzlei, 23 Sep 2026](https://www.produktkanzlei.com/en/2026/09/23/myhealtheu-and-healthdcat-ap/)
- [Health-DCAT-AP — latest](https://data.health.europa.eu/healthdcat-ap/releases/latest/) (→ R8) · [R8 changelog](https://data.health.europa.eu/healthdcat-ap/releases/release-8/changelog.html) · [R8 example (Turtle)](https://data.health.europa.eu/healthdcat-ap/releases/release-8/html/examples/example-healthdcat-dataset.ttl) · [R8 NON-PUBLIC SHACL shapes](https://data.health.europa.eu/healthdcat-ap/releases/release-8/html/shacl/HealthDCAT-AP_validator/config/rdf-validator/ehds/shapes/non-public-shapes.ttl)
- Controlled vocabularies (production): [health categories](https://hdeu-dcat.data.health.europa.eu/resource/authority/healthcategories) · [coding systems](https://hdeu-dcat.data.health.europa.eu/resource/authority/coding-system) · [standards](https://hdeu-dcat.data.health.europa.eu/resource/authority/standard) · [health activities](https://hdeu-dcat.data.health.europa.eu/resource/authority/health-activity)
- [Spec repository](https://code.europa.eu/healthdataeu/healthdcat-ap) · [R7 (previous)](https://healthdataeu.pages.code.europa.eu/healthdcat-ap/releases/release-7/)
- [HealthDCAT-AP literacy site — Analytics](https://metadata.healthdataportal.eu/dev.py?N=65&O=2475&titre_chap=HealthDCAT-AP+Model&titre_page=Analytics) (Sciensano)
- Derycke et al., [*Designing DCAT-AP Extensions for Common European Data Spaces: The EHDS HealthDCAT-AP Case Study*](https://ceur-ws.org/Vol-4064/NXDG25-paper5.pdf), NXDG@SEMANTiCS 2025
- [TEHDAS2 — guideline for data users navigating the catalogue](https://tehdas.eu/wp-content/uploads/2026/05/draft-guideline-for-data-users-navigating-the-catalogue.pdf) (21 Apr 2026) · [TEHDAS2 M7.2 draft guideline on minimisation, pseudonymisation, anonymisation and synthetic data](https://tehdas.eu/wp-content/uploads/2025/09/draft-guideline-on-data-minimisation-pseudonymisation-anonymisation-and-synthetic-data.pdf) (5 Sep 2025)
- [EU SHACL validator](https://health-data-itb-rdf-validator.acceptance.data.health.europa.eu/shacl/ehds/upload)
- [EHDS Regulation (EU) 2025/327](http://data.europa.eu/eli/reg/2025/327/oj) · [EC timeline](https://health.ec.europa.eu/ehealth-digital-health-and-care/european-health-data-space-regulation-ehds_en)
- [W3C DCAT 3](https://www.w3.org/TR/vocab-dcat-3/) · [DCAT-AP 3.0.1](https://semiceu.github.io/DCAT-AP/releases/3.0.1/)
