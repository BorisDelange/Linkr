"""End-to-end parity: the DB-backed project assembler reproduces the golden tree.

Seeds the SHARED golden input.json into the DB + disk + blob store, runs the
server assembler (DB/disk rows → camelCase dicts → pure builder → file tree), and
asserts each produced file matches expected/ byte for byte — the same golden the
TS and pure Python tests use. This proves the full server path, not just the pure
builder. Mirrors test_mapping_project_export_assemble.py.
"""

import base64
import json
import os
import re
from datetime import datetime
from pathlib import Path

from app.config import settings
from app.models.cohort import Cohort
from app.models.dashboard import Dashboard, DashboardTab, DashboardWidget
from app.models.dataset import DatasetAnalysis
from app.models.ide_connection import IdeConnection
from app.models.pipeline import Pipeline
from app.models.attachment import ReadmeAttachment
from app.models.project import Project
from app.models.user import User
from app.models.workspace import Workspace
from app.services import blob_store, project_fs
from app.services.data import dataset_fs
from app.services.project_export_assemble import build_project_tree_from_db

_GOLDEN = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "lib"
    / "__fixtures__"
    / "export-golden"
    / "project"
)
_EXPECTED = _GOLDEN / "expected"


def _expected_paths() -> list[str]:
    return sorted(
        str(p.relative_to(_EXPECTED)).replace("\\", "/")
        for p in _EXPECTED.rglob("*")
        if p.is_file()
    )


def _dt(v: str) -> datetime:
    return datetime.fromisoformat(v.replace("Z", "+00:00"))


async def _seed(db) -> Project:
    data = json.loads((_GOLDEN / "input.json").read_text())
    p = data["project"]
    uid = p["uid"]

    db.add(User(id=3, username="ada"))
    db.add(Workspace(id=p["workspaceId"], name={"en": "W"}, organization_id="org-1"))
    await db.commit()

    # organization inlined via the project's own frozen snapshot (with updatedAt,
    # to exercise orgSnapshot dropping it), matching what the export writes.
    project = Project(
        uid=uid,
        project_id=p["projectId"],
        workspace_id=p["workspaceId"],
        name=p["name"],
        description=p["description"],
        short_description=p["shortDescription"],
        config=p["config"],
        git_remote_config=p["gitRemoteConfig"],
        status=p["status"],
        badges=p["badges"],
        todos=p["todos"],
        notes=p["notes"],
        readme=p["readme"],
        # Seeded so the DB-backed path actually emits LICENSE.md: without it the
        # project/workspace licence export had no end-to-end coverage at all.
        license=p.get("license"),
        linked_data_source_ids=p["linkedDataSourceIds"],
        organization=data["organization"],
        lineage_id=p["lineageId"],
        parent_lineage_id=p["parentLineageId"],
        catalog_visibility=p["catalogVisibility"],
        origin=p["origin"],
        owner_id=p["ownerId"],
        created_by_id=p["createdById"],
        created_by=p["createdBy"],
        created_by_details=p["createdByDetails"],
        version=p["version"],
        created_at=_dt(p["createdAt"]),
        updated_at=_dt(p["updatedAt"]),
    )
    db.add(project)
    await db.commit()

    for pl in data["pipelines"]:
        db.add(Pipeline(
            id=pl["id"], project_uid=uid, name=pl["name"], nodes=pl["nodes"],
            edges=pl["edges"], created_at=_dt(pl["createdAt"]),
            updated_at=_dt(pl["updatedAt"]),
        ))
    for c in data["cohorts"]:
        db.add(Cohort(
            id=c["id"], project_uid=uid, name=c["name"], description=c["description"],
            level=c["level"], criteria_tree=c["criteriaTree"], custom_sql=c["customSql"],
            result_count=c["resultCount"], attrition=c["attrition"],
            materialization=c["materialization"], schema_version=c["schemaVersion"],
            version=c["version"], created_at=_dt(c["createdAt"]),
            updated_at=_dt(c["updatedAt"]),
        ))
    for cx in data["connections"]:
        db.add(IdeConnection(
            id=cx["id"], project_uid=uid, name=cx["name"], source=cx["source"],
            data_source_id=cx["dataSourceId"], connection_config=cx["connectionConfig"],
            status=cx["status"], error_message=cx["errorMessage"],
            created_at=cx["createdAt"],
        ))
    for group in data["dashboards"]:
        d = group["dashboard"]
        db.add(Dashboard(
            id=d["id"], project_uid=uid, name=d["name"], description=d["description"],
            filter_config=d["filterConfig"], show_widget_titles=d["showWidgetTitles"],
            default_dataset_file_id=d["defaultDatasetFileId"],
            widget_spacing=d["widgetSpacing"],
            reload_widgets_on_tab_switch=d["reloadWidgetsOnTabSwitch"],
            fit_to_height=d["fitToHeight"], grid_v=d["gridV"], origin=d["origin"],
            created_by_id=d["createdById"], created_by=d["createdBy"],
            created_by_details=d["createdByDetails"], version=d["version"],
            created_at=_dt(d["createdAt"]), updated_at=_dt(d["updatedAt"]),
        ))
        for t in group["tabs"]:
            db.add(DashboardTab(
                id=t["id"], dashboard_id=d["id"], name=t["name"],
                description=t["description"], display_order=t["displayOrder"],
                parent_tab_id=t["parentTabId"],
            ))
        for w in group["widgets"]:
            db.add(DashboardWidget(
                id=w["id"], tab_id=w["tabId"], name=w["name"],
                description=w["description"], dataset_file_id=w["datasetFileId"],
                layout=w["layout"], source=w["source"],
            ))
    for _path, analyses in data["datasetAnalyses"].items():
        for a in analyses:
            db.add(DatasetAnalysis(
                id=a["id"], project_uid=uid, dataset_path=a["datasetPath"],
                name=a["name"], type=a["type"], config=a["config"],
                created_at=_dt(a["createdAt"]), updated_at=_dt(a["updatedAt"]),
            ))
    for att in data["attachments"]:
        sha, _ = await blob_store.store_bytes(base64.b64decode(att["dataBase64"]))
        db.add(ReadmeAttachment(
            id=att["id"], owner_type="project", owner_id=uid,
            workspace_id=att["workspaceId"],
            file_name=att["fileName"], mime_type=att["mimeType"],
            file_size=att["fileSize"], blob_sha=sha, created_at=att["createdAt"],
        ))
    await db.commit()

    # Disk-backed content: IDE scripts + dataset CSVs. The CSVs must parse to the
    # fixture's columns (deterministic col_<name> ids + inferred number/string).
    project_fs.write_script(uid, "main.py", "print('hello')\n")
    project_fs.write_script(uid, "utils/helpers.py", "def f():\n    return 1\n")
    ds_dir = project_fs.datasets_dir(uid)
    (ds_dir / "cohort.csv").write_text("age,sex\n30,M\n41,F\n52,M\n")
    (ds_dir / "sub").mkdir(parents=True, exist_ok=True)
    (ds_dir / "sub" / "labs.csv").write_text("val\n1.5\n2.5\n")
    # Editorial column metadata + parse options live in a disk sidecar, NOT the DB, so
    # the assembler only reproduces the golden's inline `columns`/`parseOptions` when
    # they are seeded through the same production writers the app uses.
    dataset_fs.write_column_meta(uid, "cohort.csv", {
        "col_age": {"label": "Age", "description": "Age in years at inclusion"},
        "col_sex": {"valueLabels": {"m": "Male", "f": "Female"}},
    })
    dataset_fs.write_parse_options(uid, "cohort.csv", {
        "columnTypes": {"col_age": "number"},
        "columnFilterMode": {"col_sex": "list"},
    })

    return project


def _normalize_utc(content: bytes) -> bytes:
    """Collapse the tz spelling AND optional fractional seconds of UTC timestamps
    so the SQLite-backed test can assert against a Postgres-shaped golden. SQLite's
    DateTime(timezone=True) drops tzinfo, so a datetime round-trips NAIVE and Pydantic
    emits ``...T00:00:00`` (and may carry microseconds ``...T00:00:00.123456``);
    Postgres keeps it tz-aware and Pydantic emits ``...T00:00:00Z``. Both denote the
    same instant. The golden is frozen in the production ``Z`` form (see the pure
    builder test, which pins the exact bytes); here we only neutralize these
    environment artifacts — every other byte must still match exactly."""
    return re.sub(rb"(\d{2}:\d{2}:\d{2})(\.\d+)?Z?", rb"\1", content)


async def test_assembler_reproduces_golden_tree(db):
    project = await _seed(db)
    tree = await build_project_tree_from_db(db, project)

    if os.environ.get("GOLDEN_UPDATE") == "1":
        for path, content in tree.items():
            dest = _EXPECTED / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(content)

    assert sorted(tree.keys()) == _expected_paths()
    for path in _expected_paths():
        expected = (_EXPECTED / path).read_bytes()
        assert _normalize_utc(tree[path]) == _normalize_utc(expected), (
            f"content mismatch for {path}"
        )


async def test_assembler_includes_marked_raw_files(db):
    project = await _seed(db)
    # Mark the data file for versioning (project.config.versionedDataFiles) — only
    # then does the assembler write it into the tree and except it in .gitignore.
    project.config = {**(project.config or {}), "versionedDataFiles": ["datasets/cohort.csv"]}
    tree = await build_project_tree_from_db(db, project)
    # Raw dataset files land verbatim under their folder; no _data.json sidecar in
    # server mode (rows are never bulk-shipped).
    assert tree["datasets/cohort/cohort.csv"] == b"age,sex\n30,M\n41,F\n52,M\n"
    assert "datasets/cohort/_data.json" not in tree
    # The .gitignore ignores data everywhere but re-includes the marked file via a
    # !path exception.
    gitignore = tree[".gitignore"].decode()
    assert gitignore.startswith("**/*.csv")
    assert "!datasets/cohort/cohort.csv" in gitignore


def test_data_dir_is_isolated():
    # Guard: the autouse fixture points data_dir at a tmp path, so these tests never
    # touch a real ~/.linkr project tree.
    assert "/private/" in str(settings.data_path) or "tmp" in str(settings.data_path)


async def test_assembler_includes_environment_specs(db):
    project = await _seed(db)
    # A managed Python env: its committed spec lives under environments/python/.
    spec = project_fs.env_spec_dir(project.uid, "python")
    (spec / "pyproject.toml").write_bytes(b"[project]\nname='x'\n")
    (spec / "uv.lock").write_bytes(b"version = 1\n")
    tree = await build_project_tree_from_db(db, project)
    # The spec is versioned; the materialised venv (.cache/) is never in the tree.
    assert tree["environments/python/pyproject.toml"] == b"[project]\nname='x'\n"
    assert tree["environments/python/uv.lock"] == b"version = 1\n"
    assert not any(p.startswith(".cache") for p in tree)
