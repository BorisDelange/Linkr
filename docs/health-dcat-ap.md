# Health-DCAT-AP — Summary for LinkR

> Based on [Health-DCAT-AP Release 6](https://healthdataeu.pages.code.europa.eu/healthdcat-ap/releases/release-6/index.html) — the EU metadata standard for describing health datasets under the EHDS Regulation (EU 2025/327).

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

## How LinkR Uses This

In LinkR, the Health-DCAT-AP tab on a Data Catalog lets you:

1. **Describe your dataset** with standardized metadata (title, description, access rights, health categories, coding systems...)
2. **Auto-fill** numeric fields from computed catalog results (number of records, patients, age range)
3. **Generate JSON-LD** that could be:
   - Embedded in the exported HTML catalog (`<script type="application/ld+json">`)
   - Submitted to a national Health Data Access Body portal
   - Indexed by the EU Health Data Portal
4. **Document variables** (future: link to CSVW Table/Column descriptions from the catalog's concept list)

### What the existing EU portal shows

The [EU Health Data Portal](https://ehds.healthdataportal.eu/) currently lists ~20 national catalogs (Belgium, Croatia, France, Germany, etc.). Most entries describe **registries** (cancer, rare diseases) or **administrative databases** at the national level.

**None of them currently include a detailed breakdown of available variables/concepts** — they only describe the dataset at a high level (title, category, temporal coverage, population size). This is where LinkR can add value: by computing the actual catalog of concepts with counts, and attaching it as a CSVW table description or as a rich HTML distribution.

---

## Differences from Our Current Implementation

Our `schema.ts` was based on an older draft. Key changes in Release 6:

| Aspect | Our current | Release 6 |
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

- [Health-DCAT-AP Release 6 (official spec)](https://healthdataeu.pages.code.europa.eu/healthdcat-ap/releases/release-6/index.html)
- [EU Health Data Portal](https://ehds.healthdataportal.eu/)
- [EHDS Regulation (EU) 2025/327](http://data.europa.eu/eli/reg/2025/327)
- [DCAT-AP 3.0](https://semiceu.github.io/DCAT-AP/releases/3.0.0/)
- [HealthDCAT-AP GitHub (redirects to EU infra)](https://healthdcat-ap.github.io/)
