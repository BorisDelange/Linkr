"""Server-side builder for the mapping-project export tree — a byte-faithful
Python port of the frontend git-variant builder
(apps/web/src/lib/concept-mapping/export.ts ``buildMappingProjectZip``).

Returns the extracted ``{path: bytes}`` tree (NOT a zip container): git versions
the extracted files, and the container isn't byte-reproducible across JSZip and
Python ``zipfile``. A thin caller zips this tree for commit/push or download.

Parity matters: this MUST match the TS builder byte for byte, or a front-only
client and a server client versioning the same repo produce false git diffs. The
shared golden fixture + twin tests
(apps/web/src/lib/concept-mapping/__fixtures__/export-golden/mapping-project/,
apps/web/src/lib/concept-mapping/export-golden.test.ts, and
apps/api/tests/test_mapping_project_export.py) guard this. See
docs/architecture.md ("Fullstack Storage & Compute") for the byte-level contract.

This is a PURE module: it takes already-loaded data (project dict, mappings,
ranges, entries, org, raw source-concepts.csv bytes) — the DB/blob reads live in
the caller.
"""

from typing import Any

from app.core.json_export import export_json as _json
from app.export_version import EXPORT_APP_VERSION as APP_VERSION
from app.services.entity_docs import entity_doc_files
from app.services.entity_docs import license_meta as _license_meta
from app.services.export_layout import (
    ENTITY_MANIFEST,
    TYPE_MAPPING_PROJECT,
    with_entity_type,
)
from app.services.org_snapshot import org_snapshot

# Fields dropped from project.json so the exported metadata is portable — mirrors
# INSTANCE_FIELDS in apps/web/src/lib/entity-io.ts. ``createdAt`` is deliberately
# NOT dropped (stable creation-date provenance, kept like createdBy); only
# ``updatedAt`` is (it moves on every edit and is re-stamped on import).
# ``dataSourceId`` is not here either: TS resets it to '' in place rather than
# removing it (required by type).
_INSTANCE_FIELDS = (
    "ownerId",
    "createdById",
    "origin",
    "workspaceId",
    "gitRemoteConfig",
    "gitUrl",
    "catalogVisibility",
    "organization",
    "organizationId",
    "updatedAt",
)


# _json is the shared export serializer (app/core/json_export.export_json):
# whole-valued floats (a mapping's ``matchScore`` of 1.0/0.0) are emitted as ints
# to match ``JSON.stringify`` — else the same mapping churns the diff on a shared
# remote. ``None`` values are omitted upstream (TS omits ``undefined``).


def _mapping_key(m: dict) -> str:
    """Total-order tiebreak key — mirrors ``mappingKey`` in
    apps/web/src/lib/concept-mapping/merge.ts. ``sourceConceptId`` is excluded on
    both sides: it is per-instance, per-badge registry state, not row identity."""

    def s(v: Any) -> str:
        return "" if v is None else str(v)

    src = f"{s(m.get('sourceVocabularyId'))}|{s(m.get('sourceConceptCode'))}"
    tgt = f"{s(m.get('targetConceptId'))}|{s(m.get('targetVocabularyId'))}|{s(m.get('targetConceptCode'))}"
    return f"{src}»→»{tgt}"


def _serialize_mappings(mappings: list[dict]) -> bytes:
    """Port of ``serializeMappingsForVersioning`` (export.ts): drop the
    instance-bookkeeping fields, sort by sourceConceptCode then the full merge
    identity, serialize like ``JSON.stringify(...,null,2)``. ``createdAt`` is
    kept — it is provenance, and dropping it re-stamped every row on reimport."""
    cleaned = [
        {
            k: v
            for k, v in m.items()
            if k not in ("id", "projectId", "updatedAt", "sourceConceptId")
        }
        for m in mappings
    ]
    cleaned.sort(key=lambda m: (m.get("sourceConceptCode") or "", _mapping_key(m)))
    return _json(cleaned)


def _portable_ranges(ranges: list[dict]) -> list[dict]:
    """Port of ``toPortableRanges`` (source-concept-ids-io.ts:97-101)."""
    out = [
        {
            "badgeLabel": r["badgeLabel"],
            "rangeStart": r["rangeStart"],
            "rangeEnd": r["rangeEnd"],
            "nextId": r["nextId"],
            "totalConcepts": r["totalConcepts"],
        }
        for r in ranges
    ]
    out.sort(key=lambda r: r["badgeLabel"])
    return out


def _compact_entries(entries: list[dict]) -> dict:
    """Port of ``toCompactEntries`` (source-concept-ids-io.ts:37-43): 4-column
    compact form (createdAt dropped), rows sorted by (badge, vocab, code)."""
    rows = [
        [e["badgeLabel"], e["vocabularyId"], e["conceptCode"], e["sourceConceptId"]]
        for e in entries
    ]
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    return {
        "columns": ["badgeLabel", "vocabularyId", "conceptCode", "sourceConceptId"],
        "entries": rows,
    }


def _build_project_json(project: dict, organization: dict | None) -> bytes:
    """Port of the project.json transform (export.ts:613-625) + inline org
    (attachEntityOrganization, entity-io.ts:1234-1250).

    Strip instance + non-portable fields, reset ``dataSourceId`` to '' IN PLACE
    (keeps its original key position), re-add ``fileSourceData`` with the raw
    buffer omitted and ``rows`` emptied, then append ``organization`` at the end
    when one resolves."""
    out: dict = {}
    for k, v in project.items():
        if k in _INSTANCE_FIELDS:
            continue
        if k in (
            "conceptSetIds",
            "importBatches",
            "vocabularyDataSourceId",
            "fileSourceData",
            # Documentation travels as files (README.md / LICENSE.md), not in the
            # metadata; only the licence identity is re-appended below.
            "readme",
            "license",
        ):
            continue
        # Reset in place: reassigning an existing key keeps its position (JS + py3.7+).
        out[k] = "" if k == "dataSourceId" else v

    licence = _license_meta(project.get("license"))
    if licence is not None:
        out["license"] = licence

    fsd = project.get("fileSourceData")
    if fsd is not None:
        out["fileSourceData"] = {
            **{k: v for k, v in fsd.items() if k != "rawFileBuffer"},
            "rows": [],
        }

    # The export-format version stamp, as every other kind carries it. The org is
    # appended after it (attachEntityOrganization re-opens the file on the client),
    # so this is last only until that runs.
    if organization:
        out["organization"] = org_snapshot(organization)
    # appVersion last, after the provenance block with_entity_type orders.
    out.pop("appVersion", None)
    return _json(with_entity_type(out, TYPE_MAPPING_PROJECT, APP_VERSION))


_PARQUET_MAGIC = b"PAR1"


def _csv_escape(value: Any) -> str:
    """Twin of ``csvEscape`` (export.ts): quote only when the value carries a
    comma, a quote or a newline, and double any embedded quote."""
    if value is None:
        return ""
    s = str(value)
    if "," in s or '"' in s or "\n" in s:
        return '"' + s.replace('"', '""') + '"'
    return s


def _as_csv_bytes(source: bytes) -> bytes:
    """Return the source concepts as CSV text.

    A project imported from a .parquet file used to have its raw bytes written
    verbatim under the ``source-concepts.csv`` name, so the name said CSV and the
    content was binary: re-importing decoded it as text and yielded a project
    with no source concepts, and the pull preview's CSV diff raised on it.

    The file's own column names are kept rather than normalized to the canonical
    role headers — the re-import preserves an existing columnMapping when all its
    columns are still present, so renaming here would churn projects that already
    round-trip. Twin of ``parquetBufferToCsv`` (export.ts); both must emit the
    same bytes or a front-only and a server client would fight over the file.
    """
    if not source.startswith(_PARQUET_MAGIC):
        return source
    try:
        import tempfile

        import duckdb

        # read_parquet needs a path: the bytes come from the blob store, not disk.
        with tempfile.NamedTemporaryFile(suffix=".parquet") as tmp:
            tmp.write(source)
            tmp.flush()
            con = duckdb.connect()
            try:
                rel = con.execute("SELECT * FROM read_parquet(?)", [tmp.name])
                columns = [d[0] for d in rel.description]
                rows = rel.fetchall()
            finally:
                con.close()
    except Exception:
        # Unreadable parquet: keep the original bytes rather than losing the file.
        return source
    if not columns:
        return source
    lines = [",".join(_csv_escape(c) for c in columns)]
    lines.extend(",".join(_csv_escape(v) for v in row) for row in rows)
    return "\n".join(lines).encode("utf-8")


def build_mapping_project_tree(
    project: dict,
    mappings: list[dict],
    ranges: list[dict],
    entries: list[dict],
    organization: dict | None,
    source_csv: bytes | None,
) -> dict[str, bytes]:
    """Build the git-variant mapping-project export tree as ``{path: bytes}``.

    Byte-faithful to ``buildMappingProjectZip`` (git variant: no scores, no
    ``.gitattributes`` unless LFS overrides — which this signature doesn't take).
    ``source_csv`` is written verbatim (the raw source buffer), matching the git
    variant which never re-serializes it. ``ranges``/``entries`` are already
    scoped to the project's badges by the caller.
    """
    tree: dict[str, bytes] = {}

    tree[ENTITY_MANIFEST] = _build_project_json(project, organization)
    tree.update(entity_doc_files("", project))
    tree["mappings.json"] = _serialize_mappings(mappings)

    if project.get("sourceType") == "file" and source_csv:
        tree["source-concepts.csv"] = _as_csv_bytes(source_csv)

    # source-concept-ids/: written only when the project has assigned ids. The
    # whole folder is skipped when both are empty (matches the TS no-op).
    if ranges:
        tree["source-concept-ids/ranges.json"] = _json(_portable_ranges(ranges))
    if entries:
        tree["source-concept-ids/entries.json"] = _json(_compact_entries(entries))

    tree[".gitignore"] = b"*.parquet\nreview/\nstate.json\n"

    return tree
