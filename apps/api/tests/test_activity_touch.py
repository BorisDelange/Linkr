"""A child write bumps its owning element's updated_at (before_flush listener)."""
from datetime import datetime, timezone

from app.models.cohort import Cohort
from app.models.dashboard import Dashboard, DashboardTab, DashboardWidget
from app.models.etl_pipeline import EtlFile, EtlPipeline
from app.models.mapping_project import ConceptMapping, MappingProject
from app.models.project import Project
from app.models.workspace import Workspace

_OLD = datetime(2020, 1, 1, tzinfo=timezone.utc)


async def _ws(db) -> str:
    ws = Workspace(id="ws1", name={"en": "W"})
    db.add(ws)
    await db.commit()
    return ws.id


async def _stamp_old(db, obj) -> None:
    """Force updated_at back so a later bump is unambiguous, without tripping the
    listener (this touches the parent row directly, no child write)."""
    obj.updated_at = _OLD
    await db.commit()
    await db.refresh(obj)
    assert obj.updated_at.replace(tzinfo=timezone.utc) == _OLD


async def test_adding_a_mapping_bumps_the_mapping_project(db):
    ws = await _ws(db)
    mp = MappingProject(id="mp1", workspace_id=ws, name={"en": "M"}, source_type="file")
    db.add(mp)
    await db.commit()
    await _stamp_old(db, mp)

    db.add(ConceptMapping(id="m1", project_id="mp1", source_concept_code="X"))
    await db.commit()

    db.expire_all()  # the listener's UPDATE bypassed the identity map; re-read from DB
    refreshed = await db.get(MappingProject, "mp1")
    assert refreshed.updated_at.replace(tzinfo=timezone.utc) > _OLD


async def test_editing_an_etl_file_bumps_the_pipeline(db):
    ws = await _ws(db)
    p = EtlPipeline(id="p1", workspace_id=ws, name={"en": "P"}, source_data_source_id="ds")
    db.add(p)
    await db.commit()
    f = EtlFile(id="f1", pipeline_id="p1", name="a.sql", type="file", content="")
    db.add(f)
    await db.commit()
    await _stamp_old(db, p)

    f.content = "SELECT 1"
    await db.commit()

    db.expire_all()
    refreshed = await db.get(EtlPipeline, "p1")
    assert refreshed.updated_at.replace(tzinfo=timezone.utc) > _OLD


async def test_adding_a_cohort_bumps_the_project(db):
    ws = await _ws(db)
    proj = Project(uid="pr1", workspace_id=ws, name={"en": "P"})
    db.add(proj)
    await db.commit()
    await _stamp_old(db, proj)

    db.add(Cohort(id="c1", project_uid="pr1", level="visit"))
    await db.commit()

    db.expire_all()
    refreshed = await db.get(Project, "pr1")
    assert refreshed.updated_at.replace(tzinfo=timezone.utc) > _OLD


async def test_editing_a_widget_bumps_the_dashboard(db):
    ws = await _ws(db)
    # Commit parents before children — these models carry raw FK columns (no ORM
    # relationship), so the unit-of-work won't order inserts parent-first for us.
    db.add(Project(uid="pr1", workspace_id=ws, name={"en": "P"}))
    await db.commit()
    dash = Dashboard(id="d1", project_uid="pr1", name={"en": "D"})
    db.add(dash)
    await db.commit()
    db.add(DashboardTab(id="t1", dashboard_id="d1", name={"en": "T"}, display_order=0))
    await db.commit()
    db.add(DashboardWidget(id="w1", tab_id="t1", name={"en": "W"}, layout={"x": 0, "y": 0, "w": 4, "h": 2}))
    await db.commit()
    await _stamp_old(db, dash)

    # The tab must be in the identity map for the two-hop resolve; loading it (and
    # the widget) here puts both in the session before the edit.
    await db.get(DashboardTab, "t1")
    w = await db.get(DashboardWidget, "w1")
    w.name = {"en": "W2"}
    await db.commit()

    db.expire_all()
    refreshed = await db.get(Dashboard, "d1")
    assert refreshed.updated_at.replace(tzinfo=timezone.utc) > _OLD


async def test_editing_a_widget_bumps_dashboard_via_db_fallback(db):
    """Same as above but the tab is NOT session-resident — the listener must fall
    back to the indexed DB lookup (the two-hop branch tests didn't cover)."""
    ws = await _ws(db)
    db.add(Project(uid="pr2", workspace_id=ws, name={"en": "P"}))
    await db.commit()
    dash = Dashboard(id="d2", project_uid="pr2", name={"en": "D"})
    db.add(dash)
    await db.commit()
    db.add(DashboardTab(id="t2", dashboard_id="d2", name={"en": "T"}, display_order=0))
    await db.commit()
    db.add(DashboardWidget(id="w2", tab_id="t2", name={"en": "W"}, layout={"x": 0, "y": 0, "w": 4, "h": 2}))
    await db.commit()
    await _stamp_old(db, dash)

    # Drop everything from the session, then load ONLY the widget — the tab is
    # absent from the identity map, so the listener must query for dashboard_id.
    db.expire_all()
    w = await db.get(DashboardWidget, "w2")
    w.name = {"en": "W2"}
    await db.commit()

    db.expire_all()
    refreshed = await db.get(Dashboard, "d2")
    assert refreshed.updated_at.replace(tzinfo=timezone.utc) > _OLD


async def test_no_child_write_leaves_parent_untouched(db):
    """A read (or an unrelated write) must NOT bump the element."""
    ws = await _ws(db)
    mp = MappingProject(id="mp1", workspace_id=ws, name={"en": "M"}, source_type="file")
    db.add(mp)
    await db.commit()
    await _stamp_old(db, mp)

    # Unrelated write (another workspace) — no child of mp1 touched.
    db.add(Workspace(id="ws2", name={"en": "W2"}))
    await db.commit()

    db.expire_all()
    refreshed = await db.get(MappingProject, "mp1")
    assert refreshed.updated_at.replace(tzinfo=timezone.utc) == _OLD
