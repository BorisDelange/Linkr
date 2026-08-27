"""End-to-end parity: the DB-backed assembler reproduces the golden tree.

Seeds the SHARED golden input.json into the DB + blob store, runs the server
assembler (DB rows → camelCase dicts → pure builder → file tree), and asserts each
produced file matches expected/ byte for byte — the same golden the TS and pure
Python tests use. This proves the full server path, not just the pure builder.
"""

import base64
import json
import os
from datetime import datetime
from pathlib import Path

from app.models.mapping_project import ConceptMapping, MappingProject
from app.models.source_concept_id import SourceConceptIdEntry, SourceConceptIdRange
from app.models.workspace import Workspace
from app.services import blob_store
from app.services.mapping_project_export_assemble import (
    _range_dict,
    build_mapping_project_tree_from_db,
)
from types import SimpleNamespace

_GOLDEN = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "lib"
    / "concept-mapping"
    / "__fixtures__"
    / "export-golden"
    / "mapping-project"
)
_EXPECTED = _GOLDEN / "expected"


def _expected_paths() -> list[str]:
    return sorted(
        str(p.relative_to(_EXPECTED)).replace("\\", "/")
        for p in _EXPECTED.rglob("*")
        if p.is_file()
    )


async def _seed(db) -> MappingProject:
    data = json.loads((_GOLDEN / "input.json").read_text())
    p = data["project"]
    fsd = dict(p["fileSourceData"])

    sha, _ = await blob_store.store_bytes(base64.b64decode(data["sourceCsvBase64"]))

    # Parent rows for the FKs (workspace, then project committed before mappings).
    db.add(Workspace(id=p["workspaceId"], name={"en": "W"}))
    await db.commit()

    project = MappingProject(
        id=p["id"],
        entity_id=p["entityId"],
        workspace_id=p["workspaceId"],
        name=p["name"],
        description=p["description"],
        status=p["status"],
        source_type=p["sourceType"],
        data_source_id=p["dataSourceId"],
        badges=p["badges"],
        file_source_data=fsd,
        raw_file_sha=sha,
        raw_file_name=fsd["fileName"],
        organization=data["organization"],
        created_by=p["createdBy"],
        created_by_details=p["createdByDetails"],
        readme=p.get("readme"),
        license=p.get("license"),
        # createdAt is now kept in the export (stable provenance), so the seeded
        # row must carry the fixture's value for the golden byte-parity to hold —
        # a real import preserves it the same way.
        created_at=datetime.fromisoformat(p["createdAt"]),
    )
    db.add(project)
    await db.commit()
    for m in data["mappings"]:
        db.add(
            ConceptMapping(
                **{
                    "id": m["id"],
                    "project_id": m["projectId"],
                    "source_concept_id": m["sourceConceptId"],
                    "source_concept_name": m["sourceConceptName"],
                    "source_vocabulary_id": m["sourceVocabularyId"],
                    "source_concept_code": m["sourceConceptCode"],
                    "target_concept_id": m["targetConceptId"],
                    "target_concept_name": m["targetConceptName"],
                    "target_vocabulary_id": m["targetVocabularyId"],
                    "target_concept_code": m["targetConceptCode"],
                    "equivalence": m["equivalence"],
                    "status": m["status"],
                    "mapped_by": m["mappedBy"],
                    "mapped_by_details": m["mappedByDetails"],
                    # Like the project above: createdAt is exported, so the seeded
                    # row must carry the fixture's value or server_default would
                    # stamp "now" and the golden bytes would drift every run.
                    "created_at": datetime.fromisoformat(m["createdAt"]),
                }
            )
        )
    for r in data["ranges"]:
        db.add(
            SourceConceptIdRange(
                workspace_id=r["workspaceId"],
                badge_label=r["badgeLabel"],
                range_start=r["rangeStart"],
                range_end=r["rangeEnd"],
                next_id=r["nextId"],
                total_concepts=r["totalConcepts"],
            )
        )
    for e in data["entries"]:
        db.add(
            SourceConceptIdEntry(
                id=e["id"],
                workspace_id=e["workspaceId"],
                badge_label=e["badgeLabel"],
                vocabulary_id=e["vocabularyId"],
                concept_code=e["conceptCode"],
                source_concept_id=e["sourceConceptId"],
            )
        )
    await db.commit()
    return project


def _rng(**kw):
    base = dict(badge_label="Rennes", range_start=2000000001, range_end=2001000000,
               next_id=2000000001, total_concepts=0)
    base.update(kw)
    return SimpleNamespace(**base)


def _ent(sid):
    return SimpleNamespace(badge_label="Rennes", source_concept_id=sid)


def test_range_dict_reconciles_stale_next_id_with_real_entries():
    # The RiCDC bug: stored range claims nextId below the ids actually assigned.
    r = _rng(next_id=2000177808, total_concepts=177807)
    entries = [_ent(2000000001), _ent(2000182283)]
    out = _range_dict(r, entries)
    assert out["nextId"] == 2000182284  # bumped past the highest assigned id
    assert out["totalConcepts"] == 177807  # kept (stored count higher than in-window)


def test_range_dict_is_monotone_and_window_scoped():
    r = _rng(next_id=2000500000, total_concepts=400000)
    # An id outside the window must not affect the counters; stored values win.
    out = _range_dict(r, [_ent(2099999999), _ent(2000000005)])
    assert out["nextId"] == 2000500000
    assert out["totalConcepts"] == 400000


async def test_assembler_reproduces_golden_tree(db):
    project = await _seed(db)
    tree = await build_mapping_project_tree_from_db(db, project)

    # The server export is the authoritative fullstack shape (the API emits every
    # field, None → null). GOLDEN_UPDATE=1 regenerates expected/ from it; the TS
    # golden test then asserts the front reproduces the same bytes.
    if os.environ.get("GOLDEN_UPDATE") == "1":
        for path, content in tree.items():
            dest = _EXPECTED / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(content)

    assert sorted(tree.keys()) == _expected_paths()
    for path in _expected_paths():
        expected = (_EXPECTED / path).read_bytes()
        assert tree[path] == expected, f"content mismatch for {path}"
