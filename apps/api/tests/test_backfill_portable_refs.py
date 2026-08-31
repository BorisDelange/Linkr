"""The a9b0c1d2e3f4 backfill: derive the pointer of a link configured before
pointers existed.

Data-mutating logic on links the export depends on, so it is worth pinning: fill
a blank, never overwrite a real choice, never invent one for an id that resolves
to nothing. Exercised through the module's own helpers (`_pointer`) plus a real
SQLite round trip for the SQL half.
"""

import importlib.util
import json
from pathlib import Path

import pytest
import sqlalchemy as sa

_MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "a9b0c1d2e3f4_backfill_portable_refs.py"
)


def _load():
    spec = importlib.util.spec_from_file_location("backfill_refs", _MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Row:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def test_pointer_carries_lineage_slug_and_label():
    mod = _load()
    ref = json.loads(
        mod._pointer(_Row(lineage_id="lin", entity_id="mimic", name={"en": "MIMIC"}))
    )
    assert ref == {"lineageId": "lin", "entityId": "mimic", "label": {"en": "MIMIC"}}


def test_pointer_omits_absent_parts():
    mod = _load()
    assert json.loads(mod._pointer(_Row(lineage_id="lin", entity_id=None, name=None))) == {
        "lineageId": "lin"
    }


def test_pointer_refuses_a_row_with_no_identity():
    # Neither lineage nor slug: nothing the receiving instance could resolve, so
    # a pointer would be noise that never matches.
    mod = _load()
    assert mod._pointer(_Row(lineage_id=None, entity_id=None, name={"en": "X"})) is None


def test_pointer_parses_a_json_encoded_name():
    # SQLite hands back the LocalizedString column as text.
    mod = _load()
    ref = json.loads(mod._pointer(_Row(lineage_id="lin", entity_id=None, name='{"en":"X"}')))
    assert ref["label"] == {"en": "X"}


@pytest.fixture
def bind():
    engine = sa.create_engine("sqlite://")
    with engine.connect() as conn:
        conn.execute(
            sa.text(
                "CREATE TABLE data_sources (id TEXT, entity_id TEXT, lineage_id TEXT, name TEXT)"
            )
        )
        conn.execute(
            sa.text(
                "CREATE TABLE dq_rule_sets (id TEXT, data_source_id TEXT, data_source_ref TEXT)"
            )
        )
        conn.execute(
            sa.text(
                "INSERT INTO data_sources VALUES "
                "('db-1','mimic','lin-1','{\"en\":\"MIMIC\"}'), ('db-2',NULL,NULL,NULL)"
            )
        )
        yield conn


def _backfill_rule_sets(mod, conn):
    """The upgrade's single-link loop, for the one table this fixture builds."""
    targets = mod._targets(conn, "data_sources")
    rows = conn.execute(
        sa.text(
            "SELECT id, data_source_id AS target_id FROM dq_rule_sets "
            "WHERE data_source_ref IS NULL AND data_source_id IS NOT NULL "
            "AND data_source_id <> ''"
        )
    ).fetchall()
    for row in rows:
        target = targets.get(row.target_id)
        if target is None:
            continue
        ref = mod._pointer(target)
        if ref is None:
            continue
        conn.execute(
            sa.text("UPDATE dq_rule_sets SET data_source_ref = :ref WHERE id = :id"),
            {"ref": ref, "id": row.id},
        )


def _ref_of(conn, rs_id):
    return conn.execute(
        sa.text("SELECT data_source_ref FROM dq_rule_sets WHERE id = :id"), {"id": rs_id}
    ).scalar()


def test_fills_a_blank_pointer(bind):
    mod = _load()
    bind.execute(sa.text("INSERT INTO dq_rule_sets VALUES ('rs-1','db-1',NULL)"))
    _backfill_rule_sets(mod, bind)
    assert json.loads(_ref_of(bind, "rs-1"))["lineageId"] == "lin-1"


def test_never_overwrites_an_existing_pointer(bind):
    # It records the choice the user actually made, which may differ from what
    # the stale local id still names.
    mod = _load()
    bind.execute(
        sa.text("INSERT INTO dq_rule_sets VALUES ('rs-1','db-1','{\"lineageId\":\"by-hand\"}')")
    )
    _backfill_rule_sets(mod, bind)
    assert json.loads(_ref_of(bind, "rs-1"))["lineageId"] == "by-hand"


def test_leaves_an_unresolvable_id_alone(bind):
    # A deleted database, or a foreign UUID from an import predating pointers.
    mod = _load()
    bind.execute(sa.text("INSERT INTO dq_rule_sets VALUES ('rs-1','db-gone',NULL)"))
    _backfill_rule_sets(mod, bind)
    assert _ref_of(bind, "rs-1") is None


def test_leaves_a_target_without_identity_alone(bind):
    mod = _load()
    bind.execute(sa.text("INSERT INTO dq_rule_sets VALUES ('rs-1','db-2',NULL)"))
    _backfill_rule_sets(mod, bind)
    assert _ref_of(bind, "rs-1") is None
