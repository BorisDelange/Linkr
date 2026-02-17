# LinkR v2 — Vision & Roadmap

This document outlines the long-term vision for LinkR, including workspace organization, the three use-case pillars (Research, Monitoring, Deployment), and a benchmark of existing platforms. It serves as a guide for architectural decisions — not a commitment to implement everything immediately.

**Core principle**: Make early design choices that preserve flexibility for future development. Avoid architectural dead-ends.

---

## Table of Contents

1. [Three Pillars](#three-pillars)
2. [Workspaces](#workspaces)
3. [Project Capabilities Model](#project-capabilities-model)
4. [Publication Model](#publication-model)
5. [Benchmark & Market Research](#benchmark--market-research)
6. [Architectural Decisions for Future-Proofing](#architectural-decisions-for-future-proofing)

---

## Three Pillars

LinkR targets three progressively broader use cases:

### 1. Research (Current Priority)

Clinical research using structured data warehouses. While OMOP CDM is the primary supported model, LinkR is **not locked to OMOP** — the schema presets system allows defining and working with any data model (OMOP, i2b2, FHIR-flattened, custom hospital schemas, etc.). Each schema preset maps generic concepts (patient, visit, condition, measurement…) to the actual table/column names of the target data model.

- Import and explore clinical databases (DuckDB, Parquet)
- Browse concepts, build cohorts (schema-aware, not OMOP-specific)
- Create analysis-ready datasets via the Pipeline (long → wide format)
- Run analyses in the Lab (IDE, dashboards, statistical tools)
- Version and share projects via git

**Status**: Actively developed. Most pages implemented. Priority is to complete this pillar before moving on.

### 2. Monitoring / Live Dashboards (Next Priority)

Operational hospital dashboards for clinical service management.

- Real-time or near-real-time dashboards (e.g., unplanned extubations, adverse events, bed occupancy, PMSI indicators, IQSS quality metrics)
- Potentially hundreds of concurrent viewers on a single published dashboard
- Dashboards authored by a small team, consumed by many users (read-only for most)
- Connects to live hospital data sources (refreshed periodically or via streaming)

**Status**: Not yet started. The existing dashboard infrastructure (GridStack widgets, DashboardPage) provides a foundation. Key additions needed: publication workflow, access control, data refresh mechanisms.

### 3. AI Deployment / CDSS (Long-term — To Be Determined)

Deploying AI models and Clinical Decision Support Systems in clinical settings.

- Model registry (versioned models with metadata)
- Shadow mode (model runs on real data, predictions not shown to clinicians)
- Prediction logging, drift detection, performance monitoring
- Alert system for model degradation
- Case review workflows
- Compliance infrastructure for Software as a Medical Device (SaMD)

**Status**: Not started. **Open question**: Is it worth building this within LinkR, or should LinkR integrate with existing MLOps platforms (MLflow, Evidently, etc.)? The regulatory complexity (EU MDR, FDA, IEC 62304) is significant. LinkR could provide the data preparation and monitoring UI, while delegating model serving and lifecycle management to specialized tools.

---

## Workspaces

### Concept

A workspace is an organizational container (similar to GitHub Organizations or GitLab Groups), not a Dataiku workspace (which is a read-only consultation portal).

Each workspace:
- Has members with roles (admin, editor, viewer)
- Shares plugins, projects, wikis, and database connections
- Connects to a git remote (private or public)
- Has its own settings and branding

### Use Case Example

A hospital like CHU de Rennes would have:
- **Private workspace**: ongoing research projects, internal dashboards, unpublished analyses (connected to a private GitLab)
- **Public workspace**: published research projects, shared methodologies, open datasets (connected to a public GitHub/GitLab)

### Architecture Considerations

- Workspaces are a server-mode feature (local/WASM mode = single implicit workspace)
- Each workspace maps to a git remote or group of remotes
- Projects belong to exactly one workspace
- Plugins can be shared across workspaces (installed at workspace level or globally)
- Database connections are scoped to a workspace (a workspace "knows" which data warehouses are available)

### Data Model Sketch

```
Workspace
├── uid, name, description, avatar
├── gitRemoteUrl
├── members: [{ userId, role }]
├── settings: { ... }
├── projects: Project[]
├── plugins: Plugin[]
├── databaseConnections: DatabaseConnection[]
└── wikis: WikiPage[]
```

---

## Project Capabilities Model

Instead of separate project types (research project, monitoring project, deployment project), each project has **activable capabilities**:

| Capability | Always On? | Adds to Project |
|-----------|-----------|-----------------|
| **Research** | Yes | Pipeline, Lab (IDE, datasets, dashboards, analyses), Cohorts, Versioning |
| **Monitoring** | Activable | Publication workflow, scheduled refresh, viewer access, alert rules |
| **Deployment** | Activable | Model registry, shadow mode, prediction logging, drift detection, compliance tools |

This avoids creating parallel project hierarchies and lets a single project evolve from research to production.

### Why Not Separate Project Types?

- A research project often evolves into a monitoring dashboard or a deployed model
- Forcing users to create a new project for deployment creates data duplication and broken lineage
- The same data warehouse, cohort definitions, and pipeline transformations are reused across all three use cases

---

## Publication Model

Instead of Dev/Staging/Prod infrastructure environments (overkill for LinkR's use case), we use **publication statuses** with atomic swap.

### Dashboards

```
Draft → Under Review → Published
```

- **Draft**: editable by authors, not visible to viewers
- **Under Review**: frozen for review, visible to reviewers
- **Published**: visible to all viewers, read-only

**Atomic swap**: when publishing a new version, the old version is instantly replaced. Viewers never see a broken intermediate state. This is critical when hundreds of users view a live dashboard.

```typescript
interface Dashboard {
  uid: string
  // ...existing fields...
  publishedVersion: number | null   // currently live version
  draftVersion: number              // working version
  versions: DashboardVersion[]
}

interface DashboardVersion {
  version: number
  status: 'draft' | 'review' | 'published' | 'archived'
  tabs: DashboardTab[]
  publishedAt?: Date
  publishedBy?: string
}
```

### AI Models (Future)

```
Draft → Shadow → Under Review → Deployed → Retired
```

- **Draft**: model being developed/trained
- **Shadow**: model runs on real data, predictions logged but not shown to clinicians (equivalent of staging)
- **Under Review**: frozen for clinical/regulatory review
- **Deployed**: predictions visible to clinicians, actively monitored
- **Retired**: model deactivated, kept for audit trail

```typescript
interface DeployedModel {
  uid: string
  name: string
  version: string
  status: 'draft' | 'shadow' | 'review' | 'deployed' | 'retired'
  shadowStartedAt?: Date
  deployedAt?: Date
  retiredAt?: Date
  monitoringConfig: {
    driftThresholds: Record<string, number>
    alertRecipients: string[]
    reviewSchedule: string  // cron expression
  }
}
```

---

## Benchmark & Market Research

### MLOps Platforms

| Platform | Key Features | Relevance to LinkR |
|----------|-------------|-------------------|
| **MLflow** | Model registry (aliases: @champion/@challenger), experiment tracking, model versioning, REST API serving | Gold standard for model registry. LinkR could integrate rather than rebuild. |
| **Evidently AI** | Data/model drift detection (PSI, KS, Wasserstein tests), monitoring dashboards, report generation | Excellent monitoring library. Could be used as a Python dependency within LinkR's backend. |
| **Weights & Biases** | Experiment tracking, hyperparameter sweeps, artifact versioning, collaborative dashboards | Strong experiment tracking. Overlaps with LinkR's Lab. Integration possible via API. |
| **Seldon Core** | Kubernetes-based model serving, Alibi Explain (SHAP, LIME), canary deployments, A/B testing | Heavy infrastructure. Relevant only for large-scale hospital deployments. |
| **BentoML** | Model packaging (Bento format), REST/gRPC serving, adaptive batching | Simplifies model serving. Good candidate if LinkR needs to serve models. |
| **Dataiku** | Unified platform (data prep → training → deployment → monitoring), scenarios for automation, visual ML | Closest competitor in concept. Heavy, expensive, enterprise-focused. LinkR differentiates by being open-source and clinical-data-model-aware (OMOP, i2b2, custom schemas). |

**Key takeaway**: MLflow for model registry + Evidently for drift detection is a common open-source stack. LinkR could integrate with these rather than rebuilding them.

### SaMD Regulatory Landscape

#### EU MDR (Medical Device Regulation 2017/745)
- Software as a Medical Device: typically Class IIa or higher
- Requires QMS (Quality Management System), clinical evaluation, post-market surveillance
- IEC 62304 (software lifecycle): risk-based classification of software units (Class A/B/C)
- EU AI Act (2024): medical AI classified as "high-risk" — requires conformity assessment, risk management, human oversight

#### FDA (US)
- PCCP (Predetermined Change Control Plans): describe anticipated model updates in advance
- FDA has **not** approved fully autonomous continuous learning — all model changes require predetermined protocols
- 521 AI/ML-enabled medical devices approved as of 2024 (mostly radiology)
- Total Product Lifecycle (TPLC) approach for AI/ML SaMD

#### Implications for LinkR
- LinkR as a platform does **not** need MDR certification itself (similar to how GitHub doesn't need MDR certification)
- LinkR should provide **infrastructure for compliance**: audit trails, version control, change documentation, validation reports
- Each deployed model/CDSS built on LinkR would need its own certification process
- Key features to support compliance: immutable prediction logs, model versioning with full provenance, automated test suites, drift detection with alerts

### Hospital Dashboard / BI Platforms

| Platform | Context | Notes |
|----------|---------|-------|
| **Power BI** | Most common in French hospitals for PMSI/pilotage dashboards | Microsoft ecosystem, limited clinical data integration |
| **Tableau** | Used in some academic hospitals | Strong visualization, expensive |
| **SAP Business Objects** | Legacy, being phased out | Still present in older hospital IT stacks |
| **Superset** | Open-source BI, used by some research institutions | Good SQL-based dashboards, no clinical data model awareness |
| **Metabase** | Open-source, simpler BI tool | Easy to deploy, limited for complex clinical analyses |

**Key takeaway**: Hospital dashboards today are mostly generic BI tools (Power BI, Tableau) that know nothing about clinical data models. LinkR's advantage is being **clinical-data-model-aware** (OMOP, i2b2, custom schemas via presets): concept browsing, cohort definitions, and clinical context are built into the dashboard experience.

### CDSS Platforms

| Platform | Type | Notes |
|----------|------|-------|
| **Epic BPA (Best Practice Alerts)** | EHR-integrated | Tightly coupled to Epic EHR. Rule-based, limited ML support. |
| **Cerner (Oracle Health) Alerts** | EHR-integrated | Similar to Epic. Vendor lock-in. |
| **OpenCDS** | Open-source | CDS Hooks standard. Rule engine, not ML-focused. |
| **CDS Hooks (HL7)** | Standard | REST-based CDSS integration standard. LinkR could expose CDS Hooks endpoints for deployed models. |
| **Custom ML pipelines** | Hospital-specific | Most hospitals deploying ML do it custom (Python + Docker + monitoring). No dominant open-source platform exists for clinical ML deployment. |

**Key takeaway**: There is no dominant open-source platform for clinical ML deployment and monitoring. This is both an opportunity and a risk — building it is valuable but complex. CDS Hooks is the right integration standard if LinkR eventually serves predictions to EHRs.

---

## Architectural Decisions for Future-Proofing

These decisions should be made now (or soon) to avoid blocking future development:

### 1. Multi-tenancy from the start
- Even if workspaces are not implemented immediately, design the data model with a `workspaceId` foreign key on projects, plugins, and database connections
- In local mode, use a default implicit workspace
- This avoids a painful migration later

### 2. User identity layer
- Authentication/authorization is needed for monitoring (who can publish?) and deployment (who approved this model?)
- In local mode: single implicit user
- In server mode: proper auth (OAuth2 / OIDC)
- Add `createdBy`, `updatedBy`, `publishedBy` fields to key entities now

### 3. Dashboard versioning from the start
- Store dashboards with version numbers even if publication workflow comes later
- Current dashboard saves = new version (append, don't overwrite)
- This enables the atomic swap pattern without retrofitting

### 4. Audit trail on write operations
- Log who changed what and when on critical entities (dashboards, cohorts, pipeline configs)
- Essential for both monitoring (change tracking) and deployment (regulatory compliance)
- Can start as simple append-only JSON logs in IndexedDB

### 5. API-first design for the backend
- When the FastAPI backend is built, design REST APIs that external tools can consume
- This enables: MLflow integration, CDS Hooks endpoints, programmatic dashboard updates
- Use OpenAPI schema generation (FastAPI does this automatically)

### 6. Plugin system as extension point
- The existing plugin system (plugin.json, ui.tsx, server.py) is the right abstraction for adding monitoring widgets, model registry UI, drift dashboards, etc.
- Keep plugins self-contained and independently versionable
- Monitoring and deployment features could initially be implemented as "core plugins" before being promoted to first-class features
