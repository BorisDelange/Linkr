"""Git-link project pointer: createdAt is omitted when absent, so the server tree
matches the TS builder byte-for-byte (JSON.stringify drops an undefined key —
emitting `"createdAt": null` here would spuriously diverge on a mixed-mode remote)."""

import json

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
        keep_credentials=False,
        sql_collections=None,
        etl_pipelines=None,
        dq_rule_sets=None,
        mapping_projects=None,
        id_ranges=None,
        catalogs=None,
        service_mappings=None,
        plugins=None,
    )
    return json.loads(tree["projects/p/project.json"].decode("utf-8"))


def test_pointer_omits_createdat_when_absent():
    ptr = _pointer_json({"uid": "u1", "projectId": "p", "name": {"en": "P"}})
    assert "createdAt" not in ptr
    # Key order preserved: uid, projectId, name, gitRemoteConfig.
    assert list(ptr.keys()) == ["uid", "projectId", "name", "gitRemoteConfig"]


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
    assert list(ptr.keys()) == ["uid", "projectId", "name", "createdAt", "gitRemoteConfig"]
