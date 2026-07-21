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
docs/planning/server-export-plan.md §4bis for the byte-level contract.

This is a PURE module: it takes already-loaded data (project dict, mappings,
ranges, entries, org, raw source-concepts.csv bytes) — the DB/blob reads live in
the caller.
"""

import json
from typing import Any

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


def _js_numbers(value: Any) -> Any:
    """Normalize whole-valued floats to int so serialization matches JS.
    ``JSON.stringify(1.0)`` → ``"1"`` but Python ``json.dumps(1.0)`` → ``"1.0"``;
    a mapping's ``matchScore`` of 1.0/0.0 (exact/zero match) would otherwise emit
    different bytes server- vs client-side → a spurious git diff on a shared remote.
    Fractions (0.85) are left untouched (JS keeps them too)."""
    if isinstance(value, bool):
        return value  # bool is an int subclass — never coerce
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: _js_numbers(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_js_numbers(v) for v in value]
    return value


def _json(value: Any) -> bytes:
    """Serialize like TS ``JSON.stringify(x, null, 2)``: 2-space indent, ``": "``
    and ``",\\n"`` separators, insertion-order keys (never sorted), UTF-8, no
    trailing newline, JS number formatting (whole floats as ints). ``None`` values
    are omitted upstream (TS omits ``undefined``)."""
    return json.dumps(
        _js_numbers(value), indent=2, ensure_ascii=False, separators=(",", ": ")
    ).encode("utf-8")


def _mapping_key(m: dict) -> str:
    """Total-order tiebreak key — mirrors ``mappingKey`` in
    apps/web/src/lib/concept-mapping/merge.ts (:25-29)."""

    def s(v: Any) -> str:
        return "" if v is None else str(v)

    src = f"{s(m.get('sourceConceptId'))}|{s(m.get('sourceVocabularyId'))}|{s(m.get('sourceConceptCode'))}"
    tgt = f"{s(m.get('targetConceptId'))}|{s(m.get('targetVocabularyId'))}|{s(m.get('targetConceptCode'))}"
    return f"{src}»→»{tgt}"


def _serialize_mappings(mappings: list[dict]) -> bytes:
    """Port of ``serializeMappingsForVersioning`` (export.ts:571-587): drop the
    instance-bookkeeping fields, sort by sourceConceptCode then the full merge
    identity, serialize like ``JSON.stringify(...,null,2)``."""
    cleaned = [
        {
            k: v
            for k, v in m.items()
            if k not in ("id", "projectId", "createdAt", "updatedAt")
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
        ):
            continue
        # Reset in place: reassigning an existing key keeps its position (JS + py3.7+).
        out[k] = "" if k == "dataSourceId" else v

    fsd = project.get("fileSourceData")
    if fsd is not None:
        out["fileSourceData"] = {
            **{k: v for k, v in fsd.items() if k != "rawFileBuffer"},
            "rows": [],
        }

    if organization:
        out["organization"] = org_snapshot(organization)

    return _json(out)


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

    tree["project.json"] = _build_project_json(project, organization)
    tree["mappings.json"] = _serialize_mappings(mappings)

    if project.get("sourceType") == "file" and source_csv:
        tree["source-concepts.csv"] = source_csv

    # source-concept-ids/: written only when the project has assigned ids. The
    # whole folder is skipped when both are empty (matches the TS no-op).
    if ranges:
        tree["source-concept-ids/ranges.json"] = _json(_portable_ranges(ranges))
    if entries:
        tree["source-concept-ids/entries.json"] = _json(_compact_entries(entries))

    tree[".gitignore"] = b"similarity-scores.parquet\n"

    return tree
