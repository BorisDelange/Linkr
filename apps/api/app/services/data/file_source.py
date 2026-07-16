"""Server-side query of a mapping project's file source (CSV in the blob store).

Mirrors the DuckDB-WASM mount in the frontend (`mountFileSourceIntoDuckDB`):
the CSV columns are projected to normalized names (concept_id, concept_code, …)
via the project's columnMapping so the frontend's SQL — which references the
`source_concepts` view with those names — runs identically server-side.
"""


def _q(name: str) -> str:
    """Quote a CSV column name for DuckDB, escaping embedded double quotes."""
    return '"' + name.replace('"', '""') + '"'


def build_source_concepts_select(column_mapping: dict) -> str:
    """Build the SELECT projection for the `source_concepts` view from a
    columnMapping (same shape as the frontend FileColumnMapping)."""
    m = column_mapping or {}
    cols: list[str] = []

    concept_id = m.get("conceptIdColumn")
    if concept_id:
        cols.append(
            f"COALESCE(TRY_CAST({_q(concept_id)} AS INTEGER), "
            f"row_number() OVER ()) AS concept_id"
        )
    else:
        cols.append("row_number() OVER () AS concept_id")

    concept_name = m.get("conceptNameColumn")
    cols.append(
        f"CAST({_q(concept_name)} AS VARCHAR) AS concept_name" if concept_name
        else "'' AS concept_name"
    )

    concept_code = m.get("conceptCodeColumn")
    cols.append(
        f"CAST({_q(concept_code)} AS VARCHAR) AS concept_code" if concept_code
        else "'' AS concept_code"
    )

    terminology = m.get("terminologyColumn")
    if terminology:
        cols.append(f"CAST({_q(terminology)} AS VARCHAR) AS vocabulary_id")
        cols.append(f"CAST({_q(terminology)} AS VARCHAR) AS terminology_name")

    optional = [
        ("domainColumn", "CAST({c} AS VARCHAR) AS domain_id"),
        ("conceptClassColumn", "CAST({c} AS VARCHAR) AS concept_class_id"),
        ("categoryColumn", "CAST({c} AS VARCHAR) AS category"),
        ("subcategoryColumn", "CAST({c} AS VARCHAR) AS subcategory"),
        ("recordCountColumn", "COALESCE(TRY_CAST({c} AS INTEGER), 0) AS record_count"),
        ("patientCountColumn", "COALESCE(TRY_CAST({c} AS INTEGER), 0) AS patient_count"),
        ("infoJsonColumn", "CAST({c} AS VARCHAR) AS info_json"),
    ]
    for key, template in optional:
        col = m.get(key)
        if col:
            cols.append(template.format(c=_q(col)))

    return ", ".join(cols)


def source_concepts_dedup_partition(column_mapping: dict) -> str:
    """PARTITION BY clause (over the view's normalized output columns) that keys
    a source concept by ``(vocabulary_id, concept_code)`` — falling back to
    concept_code alone when no terminology column is mapped. Used to drop
    duplicate source concepts, mirroring the frontend DuckDB-WASM mount."""
    m = column_mapping or {}
    if m.get("terminologyColumn"):
        return "vocabulary_id, concept_code"
    return "concept_code"
