# Health-DCAT-AP — Summary for Linkr

> Based on [Health-DCAT-AP **Release 7**](https://healthdataeu.pages.code.europa.eu/healthdcat-ap/releases/latest/) (May 2026) — the EU metadata
> standard for describing health datasets under the EHDS Regulation (EU 2025/327).
> Reviewed 2026-08-30; Release 7 is the current one (there is no Release 8 yet).
>
> **Where the spec lives.** It moved off GitHub: the normative home is the
> Commission's [code.europa.eu/healthdataeu/healthdcat-ap](https://code.europa.eu/healthdataeu/healthdcat-ap).
> `healthdcat-ap.github.io` is now only a migration notice and `SEMICeu/HealthDCAT-AP`
> does not exist — do not cite either. Link `/releases/latest/` rather than a
> numbered release: the cadence is roughly four-monthly (R6 Nov 2025, R7 May 2026)
> and will keep moving until the platform goes live in 2029.

## What is Health-DCAT-AP?

Health-DCAT-AP is a **metadata profile** (not a data format) built on top of DCAT-AP 3.0.
It tells other systems **what data you have** — not the data itself.

Think of it like a library card catalog: it describes each book (dataset) so people can find and request it, without giving them the book.

### The stack

```
Health-DCAT-AP    ← Health-specific extensions (EHDS Art. 51 categories, HDAB, coding systems...)
    ↑
DCAT-AP 3.0       ← EU Application Profile for data portals (data.europa.eu)
    ↑
DCAT 3             ← W3C standard for describing datasets on the web
    ↑
RDF / JSON-LD      ← Linked Data format (machine-readable, interoperable)
```

### Why does it exist?

The **European Health Data Space (EHDS)** regulation requires that health datasets (EHR, registries, claims, genomics, etc.) be **discoverable** across EU member states. Health-DCAT-AP standardizes how you describe your dataset so it can be:
- Indexed by the [EU Health Data Portal](https://ehds.healthdataportal.eu/)
- Found by researchers, health data access bodies (HDABs), and other institutions
- Compared across countries (same vocabulary for access rights, categories, coding systems)

### What it does NOT do

- It does **not** contain patient data
- It does **not** define a data format (CSV, Parquet, FHIR...)
- It does **not** grant access — it describes **how to request** access

---

## Core Classes

### 1. Catalog (`dcat:Catalog`)
The top-level container — represents your institution's data offering.

| Property | URI | Obligation | Notes |
|----------|-----|-----------|-------|
| **title** | `dct:title` | **Mandatory** | Multilingual name |
| **description** | `dct:description` | **Mandatory** | What the catalog contains |
| **applicable legislation** | `dcatap:applicableLegislation` | **Mandatory** | Must reference EHDS Regulation |
| publisher | `dct:publisher` | Optional | Organization managing the catalog |
| language | `dct:language` | Optional | Catalog language(s) |
| homepage | `foaf:homepage` | Optional | URL |
| release date | `dct:issued` | Optional | |
| modification date | `dct:modified` | Optional | |
| dataset | `dcat:dataset` | Optional | Links to Dataset(s) |

### 2. Dataset (`dcat:Dataset`)
Describes one dataset (e.g., "MIMIC-IV", "French National Cancer Registry").

**Mandatory properties:**

| Property | URI | Notes |
|----------|-----|-------|
| **title** | `dct:title` | Dataset name |
| **description** | `dct:description` | Multilingual |
| **identifier** | `dct:identifier` | Unique ID (UUID, DOI...) |
| **access rights** | `dct:accessRights` | `PUBLIC`, `RESTRICTED`, or `NON_PUBLIC` |
| **applicable legislation** | `dcatap:applicableLegislation` | EHDS Regulation |
| **health category** | EHDS Art. 51 | See categories below |
| **HDAB** | Health Data Access Body | Required for non-public data — the body that handles access requests |

**Health-specific optional properties (recommended to fill):**

| Property | URI | Notes |
|----------|-----|-------|
| coding system | `dct:conformsTo` | ICD-10, SNOMED CT, LOINC, OMOP, ATC, RxNorm... |
| number of records | `healthdcatap:numberOfRecords` | `xsd:nonNegativeInteger` |
| number of unique individuals | `healthdcatap:numberOfUniqueIndividuals` | `xsd:nonNegativeInteger` |
| min typical age | `healthdcatap:minTypicalAge` | `xsd:nonNegativeInteger` |
| max typical age | `healthdcatap:maxTypicalAge` | `xsd:nonNegativeInteger` |
| population coverage | Free text | Who is in the dataset |
| personal data | `healthdcatap:hasPersonalData` | GDPR indicator |
| retention period | `dct:temporal` | How long data is kept |
| temporal coverage | `dct:temporal` | Time period covered (e.g., 2010–2024) |
| geographical coverage | `dct:spatial` | Country, region |
| keywords | `dcat:keyword` | Free-text tags |
| language | `dct:language` | Data language(s) |
| frequency | `dct:accrualPeriodicity` | Update frequency |
| publisher | `dct:publisher` | Organization |
| custodian | `geodcatap:custodian` | Data holder |

### 3. Distribution (`dcat:Distribution`)
How the data can actually be accessed.

| Property | URI | Obligation | Notes |
|----------|-----|-----------|-------|
| **access URL** | `dcat:accessURL` | **Mandatory** | Where to go to get the data |
| **applicable legislation** | `dcatap:applicableLegislation` | **Mandatory** | |
| format | `dct:format` | Optional | CSV, Parquet, JSON, HTML... |
| license | `dct:license` | Optional | License URL |
| description | `dct:description` | Optional | |
| download URL | `dcat:downloadURL` | Optional | Direct download link |

### 4. Agent / Publisher (`foaf:Agent`)
The organization behind the data.

| Property | URI | Obligation | Notes |
|----------|-----|-----------|-------|
| **name** | `foaf:name` | **Mandatory** | Organization name |
| contact point | `cv:contactPoint` | **Mandatory** for Publisher/HDAB | Email, phone, URL |
| type | `dct:type` | Recommended for Publisher | |

### 5. CSVW Table/Column (new in Release 6)
Describes the **variables** (columns) in your dataset — this is the link to catalog content!

| Class | Property | Obligation | Notes |
|-------|----------|-----------|-------|
| **TableGroup** | table | **Mandatory** | Contains tables |
| **Table** | title | **Mandatory** | Table name |
| **Table** | column | **Mandatory** | Variable definitions |
| **Column** | name | **Mandatory** | Column/variable name |
| **Column** | title | **Mandatory** | Human-readable label |
| **Column** | description | **Mandatory** | What this variable means |
| **Column** | datatype | **Mandatory** | Data type (string, integer, date...) |
| **Column** | propertyUrl | Optional | Link to standard concept (SNOMED, LOINC...) |

---

## EHDS Article 51 — Health Categories

These are the categories of electronic health data for secondary use:

| Value | Description |
|-------|-------------|
| `EHR` | Electronic health records |
| `CLAIMS` | Claims and reimbursement data |
| `PHDR` | Population-based health data registries (cancer, rare diseases...) |
| `GENOMIC` | Genomic data |
| `COHORT` | Research cohorts |
| `CLINICAL_TRIAL` | Clinical trial data |
| `MEDICAL_DEVICE` | Medical devices and wellness apps |
| `SURVEY` | Health surveys and questionnaires |
| `BIOBANK` | Biobank sample data |
| `IMAGING` | Medical imaging data |
| `ADMINISTRATIVE` | Administrative health data |
| `OTHER` | Other health data |

---

## Access Rights

Three levels, with different requirements:

| Level | Meaning | HDAB required? |
|-------|---------|---------------|
| **PUBLIC** | Open data, no access restrictions | No |
| **RESTRICTED** | Available under conditions (e.g., research agreement) | Yes |
| **NON_PUBLIC** | Not publicly accessible, requires formal data access request | Yes (mandatory) |

For **non-public** health data (most hospital data), you must specify:
- A **Health Data Access Body (HDAB)** — the entity handling data access requests
- A **Distribution** pointing to the HDAB's access URL

---

## JSON-LD Output

Health-DCAT-AP metadata is serialized as **JSON-LD** — a JSON format with semantic annotations.

```json
{
  "@context": {
    "dcat": "http://www.w3.org/ns/dcat#",
    "dct": "http://purl.org/dc/terms/",
    "foaf": "http://xmlns.com/foaf/0.1/",
    "healthdcatap": "http://healthdataportal.eu/ns/health#",
    "xsd": "http://www.w3.org/2001/XMLSchema#"
  },
  "@type": "dcat:Catalog",
  "dct:title": "CHU Rennes — MIMIC-IV Demo",
  "dct:description": "Catalog of clinical concepts available in the MIMIC-IV demo database",
  "dcatap:applicableLegislation": { "@id": "http://data.europa.eu/eli/reg/2025/327" },
  "dcat:dataset": {
    "@type": "dcat:Dataset",
    "dct:title": "MIMIC-IV Demo Clinical Data",
    "dct:description": "De-identified clinical data from Beth Israel Deaconess Medical Center ICU",
    "dct:identifier": "mimic-iv-demo-2024",
    "dct:accessRights": { "@id": "http://publications.europa.eu/resource/authority/access-right/PUBLIC" },
    "healthdcatap:healthCategory": ["EHR"],
    "dct:conformsTo": [
      { "@id": "https://ohdsi.org/omop" },
      { "@id": "http://snomed.info/sct" },
      { "@id": "http://loinc.org" }
    ],
    "healthdcatap:numberOfRecords": { "@value": "28432", "@type": "xsd:nonNegativeInteger" },
    "healthdcatap:numberOfUniqueIndividuals": { "@value": "100", "@type": "xsd:nonNegativeInteger" },
    "healthdcatap:minTypicalAge": { "@value": "18", "@type": "xsd:nonNegativeInteger" },
    "healthdcatap:maxTypicalAge": { "@value": "95", "@type": "xsd:nonNegativeInteger" },
    "dcat:distribution": {
      "@type": "dcat:Distribution",
      "dcat:accessURL": { "@id": "https://linkr.example.com/catalog/mimic-iv" },
      "dct:format": { "@id": "http://publications.europa.eu/resource/authority/file-type/HTML" }
    }
  }
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
   - Indexed by the EU Health Data Portal
4. **Document variables** (future: link to CSVW Table/Column descriptions from the catalog's concept list)

### What the existing EU portal shows

The [EU Health Data Portal](https://ehds.healthdataportal.eu/) currently lists ~20 national catalogs (Belgium, Croatia, France, Germany, etc.). Most entries describe **registries** (cancer, rare diseases) or **administrative databases** at the national level.

**None of them currently include a detailed breakdown of available variables/concepts** — they only describe the dataset at a high level (title, category, temporal coverage, population size). This is where Linkr can add value: by computing the actual catalog of concepts with counts, and attaching it as a CSVW table description or as a rich HTML distribution.

---

## Differences from Our Current Implementation

Audited 2026-08-30 against `lib/dcat-ap/jsonld.ts`. The Release 6 alignment
landed; what is open is the delta introduced by **Release 7**.

### Already aligned

The namespace is right (`jsonld.ts:27` emits `http://healthdataportal.eu/ns/health#`),
`applicableLegislation`, the HDAB (as `healthdcatap:hdab` — the spec's token, not
`healthDataAccessBody`), the custodian, CSVW table/column descriptions, the CPSV
contact point, and the Art. 51 category values are all in place.

### Open against Release 7

| Gap | Where | Why it matters |
|---|---|---|
| `healthdcatap:hasStructuredData` not emitted | `jsonld.ts` | **Mandatory 1..1** on Dataset in R7 — a conformance failure, not a nicety |
| Variables hang off the Distribution | `jsonld.ts:251, 273, 426, 470` (`csvw:tableGroup`) | R7 moved them to the Dataset via `healthdcatap:hasVariables` (0..\*), mandatory once `hasStructuredData` is true. Mostly a re-parenting — the CSVW itself is already built |
| Coding systems mapped onto `dct:conformsTo` | `jsonld.ts:174` | R7 splits the two: `dct:conformsTo` = the **data model** (OMOP CDM), `healthdcatap:hasCodingSystem` = the **terminologies** (SNOMED CT, LOINC, ICD-10). Both are catalogue filters, so this one mis-mapping costs discoverability |

Two vocabularies were added in R7 and now resolve, so these can be bound to real
URIs instead of free text: `…/resource/authority/standard` and
`…/resource/authority/coding-system` (same host as `healthcategories`).

### Validating the output

The EU publishes a **public SHACL validator** — no login, accepts JSON-LD, three
profiles (PUBLIC / NON-PUBLIC / RESTRICTED):
[health-data-itb-rdf-validator.acceptance.data.health.europa.eu/shacl/ehds/upload](https://health-data-itb-rdf-validator.acceptance.data.health.europa.eu/shacl/ehds/upload).
NON-PUBLIC is the realistic profile for a hospital warehouse. This is the cheapest
way to check the three gaps above once they are closed.

---

## Is this still the right approach? (reviewed 2026-08-30)

**Yes — and the EU catalogue is moving toward what Linkr already computes.**

The TEHDAS2 guideline for data users navigating the catalogue (21 April 2026)
names **"Variable-Level Insight"** a core discovery pillar: *data dictionaries and
proxy datasets, to assess the feasibility of a research hypothesis without access
to primary health data*. Its documented filters are the Art. 51 categories, coding
systems **and data models** (it names "OMOP Common Data Model" explicitly),
population size and age range — i.e. concepts, counts, age range, temporal
coverage. That is this feature's output.

Worth knowing about the neighbours:

- **OHDSI has no metadata standard for describing a CDM instance.** `CDM_SOURCE`
  is ~11 fields; the `METADATA` table's "phase 2 — concept-level standardization"
  never shipped. EHDEN's catalogue records only coarse per-source metadata and
  mentions neither DCAT nor EHDS. Bridging OMOP's concept-level richness to the
  EU's discovery standard is the differentiator here, not a duplicated effort.
- **FHIR is not a competitor for this.** EHDS splits the layers deliberately —
  FHIR/DICOM for *exchange*, OMOP for *semantics*, DCAT-AP for *discovery*. No
  FHIR resource is an analogue of `dcat:Dataset`. Do not pivot the catalog to it.
- **DCAT-AP 3.0 / DCAT 3 are stable.** DCAT 3 has been a W3C Recommendation since
  August 2024; there is no DCAT 4 and no DCAT-AP 4. Nothing to chase.
- Optional reach, if it is ever wanted: a **schema.org `Dataset`** block alongside
  the JSON-LD (a standard crosswalk) buys Google Dataset Search visibility.

**Nothing is legally binding yet.** The obligation to describe datasets is EHDS
**Article 77** (not Art. 51, which defines the data *categories*), and it bites at
**26 March 2029**; the implementing act that makes the metadata model binding is
due **26 March 2027**. HealthDCAT-AP is still formally a draft. So: fix the three
R7 gaps, but there is no need to track every release.

### For reference — what Release 6 had changed

| Aspect | Older draft | Release 6 |
|--------|------------|-----------|
| Namespace | `http://healthdcat-ap.eu/ns#` | `http://healthdataportal.eu/ns/health#` |
| `applicableLegislation` | Missing | **Mandatory** on Catalog, Dataset, Distribution |
| HDAB (Health Data Access Body) | Missing | **Mandatory** on Dataset for non-public data |
| Custodian (data holder) | Missing | Optional on Dataset |
| CSVW (variable descriptions) | Missing | New classes: TableGroup, Table, Column |
| Contact Point | vCard `vcard:Kind` | CPSV `cv:ContactPoint` (EU Core Vocabulary) |
| Health category values | Custom | EHDS Art. 51 controlled vocabulary |
| Many Dataset fields | Mandatory/Recommended | Now **Optional** (obligation simplified) |
| Publisher on Catalog | Mandatory | Optional |
| Publisher on Dataset | Mandatory | Optional |

---

## Sources

- [Health-DCAT-AP — latest release](https://healthdataeu.pages.code.europa.eu/healthdcat-ap/releases/latest/) (R7, May 2026) · [R7 changelog](https://healthdataeu.pages.code.europa.eu/healthdcat-ap/releases/release-7/changelog/)
- [Spec repository (normative home)](https://code.europa.eu/healthdataeu/healthdcat-ap)
- [EU SHACL validator](https://health-data-itb-rdf-validator.acceptance.data.health.europa.eu/shacl/ehds/upload) — validate our JSON-LD, no login
- [EU Health Data Portal](https://ehds.healthdataportal.eu/)
- [EHDS Regulation (EU) 2025/327](http://data.europa.eu/eli/reg/2025/327) · [EC timeline](https://health.ec.europa.eu/ehealth-digital-health-and-care/european-health-data-space-regulation-ehds_en)
- [TEHDAS2 — guideline for data users navigating the catalogue](https://tehdas.eu/wp-content/uploads/2026/05/draft-guideline-for-data-users-navigating-the-catalogue.pdf) (21 Apr 2026)
- [W3C DCAT 3](https://www.w3.org/TR/vocab-dcat-3/) · [DCAT-AP 3.0](https://semiceu.github.io/DCAT-AP/releases/3.0.0/)
