"""Bubble child-write activity up to the owning element's ``updated_at``.

A top-level element's ``updated_at`` should reflect ANY activity on it, not just
edits to its own row. Adding a concept mapping, editing an ETL script, moving a
dashboard widget — each writes a CHILD row, which SQLAlchemy's ``onupdate`` bumps
on the child but never on the parent. This ``before_flush`` listener closes that
gap: for every inserted/updated/deleted child of a known type it stamps the parent
element's ``updated_at`` in the same flush.

Only DIRECT foreign keys are followed (the parent id is already on the child, so no
query is issued mid-flush). Widgets/tabs bump their Dashboard (itself a top-level
element with its own ``updated_at``), not the further-removed project. Workspace-
scoped rows that aren't owned by a single element (service mappings, concept sets,
source-concept-id ranges) are deliberately absent — they have no single parent.
"""
from datetime import datetime, timezone

from sqlalchemy import event, select, update
from sqlalchemy.orm import Session

from app.models.cohort import Cohort
from app.models.dashboard import Dashboard, DashboardTab, DashboardWidget
from app.models.dq_rule_set import DqCustomCheck, DqRuleSet
from app.models.etl_pipeline import EtlFile, EtlPipeline
from app.models.mapping_project import ConceptMapping, MappingProject
from app.models.sql_script import SqlScriptCollection, SqlScriptFile

# child class -> (parent class, attribute on the child holding the parent's id).
# Only DIRECT foreign keys — the id is already on the child, so no query is needed.
# The parent class must carry updated_at (all of these use TimestampMixin).
# Cohort (→Project) and DashboardWidget (→Dashboard via tab) are handled inline
# in the loop below: one to avoid a Project import cycle, the other because it's a
# two-hop resolve through the identity map.
_CHILD_TO_PARENT: dict[type, tuple[type, str]] = {
    ConceptMapping: (MappingProject, "project_id"),
    EtlFile: (EtlPipeline, "pipeline_id"),
    SqlScriptFile: (SqlScriptCollection, "collection_id"),
    DqCustomCheck: (DqRuleSet, "rule_set_id"),
    DashboardTab: (Dashboard, "dashboard_id"),
}


def _register() -> None:
    # Import here to avoid a module import cycle (project imports nothing from here).
    from app.models.project import Project

    def _dashboard_id_for_tab(session: Session, tab_id: str | None) -> str | None:
        if not tab_id:
            return None
        # Prefer objects already attached to the session (no query). The identity map
        # holds weak refs, so a tab the caller didn't keep alive may be absent — fall
        # back to a single indexed lookup on the flush's own connection (a read; safe
        # inside before_flush, unlike a nested flush).
        for obj in [*session.new, *session.identity_map.values()]:
            if isinstance(obj, DashboardTab) and obj.id == tab_id:
                return obj.dashboard_id
        row = session.execute(
            select(DashboardTab.dashboard_id).where(DashboardTab.id == tab_id)
        ).first()
        return row[0] if row else None

    def _parent_touches(session: Session) -> dict[type, set[str]]:
        """Collect {ParentClass: {parent_id, ...}} to bump from this flush's changes."""
        touches: dict[type, set[str]] = {}

        def add(parent_cls: type, parent_id) -> None:
            if parent_id:
                touches.setdefault(parent_cls, set()).add(parent_id)

        for obj in [*session.new, *session.dirty, *session.deleted]:
            cls = type(obj)
            if cls is Cohort:
                add(Project, getattr(obj, "project_uid", None))
            elif cls is DashboardWidget:
                # Widget bumps its dashboard; tab_id -> the tab's dashboard_id. Resolve
                # the tab from objects already in the session (loaded tabs + tabs being
                # written this flush) so no query is issued. If the tab isn't around,
                # skip — the accompanying tab/dashboard write covers that case.
                dash_id = _dashboard_id_for_tab(session, obj.tab_id)
                add(Dashboard, dash_id)
            else:
                spec = _CHILD_TO_PARENT.get(cls)
                if spec:
                    parent_cls, attr = spec
                    add(parent_cls, getattr(obj, attr, None))
        return touches

    @event.listens_for(Session, "before_flush")
    def _touch_parents(session: Session, _flush_context, _instances) -> None:
        touches = _parent_touches(session)
        if not touches:
            return
        # A bare UPDATE (not loading the rows) sets updated_at without pulling the
        # parents into this flush — no recursion, no extra SELECTs. Uses the flush's
        # own connection so it's part of the same transaction.
        now = datetime.now(timezone.utc)
        for parent_cls, ids in touches.items():
            pk = list(parent_cls.__table__.primary_key.columns)[0]
            session.execute(
                update(parent_cls.__table__)
                .where(pk.in_(ids))
                .values(updated_at=now)
            )


_register()
