"""Git-link project pointer: createdAt is omitted when absent, so the server tree
matches the TS builder byte-for-byte (JSON.stringify drops an undefined key —
emitting `"createdAt": null` here would spuriously diverge on a mixed-mode remote)."""

import json

from app.services.export_layout import ENTITY_MANIFEST
from app.services.workspace_export import build_workspace_tree

_GIT = {"url": "https://example.test/repo.git", "branch": "main"}


def _pointer_json(project_meta: dict) -> dict:
    tree = build_workspace_tree(
        workspace={"id": "ws-1", "name": {"en": "WS"}},
        organization=None,
        projects=[{"meta": project_meta, "git": _GIT, "folder": "p", "readme": None}],
        wiki_pages=None,
        wiki_attachments=None,
        wiki_attachment_blobs=None,
        schemas=None,
        data_sources=None,
        sql_collections=None,
        etl_pipelines=None,
        dq_rule_sets=None,
        mapping_projects=None,
        concept_sets=None,
        id_ranges=None,
        catalogs=None,
        service_mappings=None,
        plugins=None,
    )
    return json.loads(tree[f"projects/p/{ENTITY_MANIFEST}"].decode("utf-8"))


def test_pointer_omits_createdat_when_absent():
    ptr = _pointer_json({"uid": "u1", "projectId": "p", "name": {"en": "P"}})
    assert "createdAt" not in ptr
    # Key order preserved: uid, entityId, projectId, name, gitRemoteConfig.
    assert list(ptr.keys()) == ["uid", "entityId", "projectId", "name", "gitRemoteConfig"]


def test_pointer_keeps_createdat_when_present():
    ptr = _pointer_json(
        {
            "uid": "u1",
            "projectId": "p",
            "name": {"en": "P"},
            "createdAt": "2026-01-01T00:00:00.000Z",
        }
    )
    assert ptr["createdAt"] == "2026-01-01T00:00:00.000Z"
    assert list(ptr.keys()) == ["uid", "entityId", "projectId", "name", "createdAt", "gitRemoteConfig"]


def test_path_sort_matches_javascript_for_astral_characters():
    """JS `<`/`>` compares UTF-16 code units, Python compares code points; they
    diverge above the BMP. A file named with an emoji next to a U+E000..U+FFFF
    sibling must still sort identically in both builders, or the exported
    `_tree.json` bytes differ between a front-only and a server export."""
    from app.services.workspace_export_assemble import _utf16_key

    nodes = [{"path": "�.sql"}, {"path": "\U0001F600.sql"}, {"path": "a.sql"}]
    ours = [n["path"] for n in sorted(nodes, key=_utf16_key)]
    # What JS produces (verified against Node): the surrogate 0xD83D < 0xFFFD.
    assert ours == ["a.sql", "\U0001F600.sql", "�.sql"]
    # Plain code-point sort would put U+FFFD before U+1F600 — the bug this guards.
    assert ours != [n["path"] for n in sorted(nodes, key=lambda n: n["path"])]
