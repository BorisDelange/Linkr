"""Parity + behavior tests for the dataset ops replay engine.

The parity cases come from the SAME fixture the frontend test consumes
(apps/web/src/lib/dataset-ops.fixture.json), so the TS and Python twins can't
drift. A drift would mean the client and the server disagree about what an edited
dataset contains — silently, since each side stays internally consistent.
"""

import json
from pathlib import Path

from app.services.data.dataset_ops import (
    ROW_ORD,
    canonical_op,
    ops_hash,
    replay_ops,
)

_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "web" / "src" / "lib" / "dataset-ops.fixture.json"
)


def _cases():
    data = json.loads(_FIXTURE.read_text())
    return data["cases"]


def test_replay_matches_shared_fixture():
    for case in _cases():
        columns, rows = replay_ops(
            case["input"]["columns"], case["input"]["rows"], case["ops"]
        )
        assert columns == case["expected"]["columns"], case["name"]
        assert rows == case["expected"]["rows"], case["name"]


def test_canonical_wire_form_matches_shared_fixture():
    canonical = json.loads(_FIXTURE.read_text())["canonical"]
    # Compared as JSON, not by equality: key ORDER is the property under test, and
    # both export builders write this form verbatim.
    emitted = [json.dumps(canonical_op(op)) for op in canonical["ops"]]
    assert emitted == [json.dumps(op) for op in canonical["expected"]]


def test_ops_hash_matches_shared_fixture():
    canonical = json.loads(_FIXTURE.read_text())["canonical"]
    assert ops_hash(canonical["ops"]) == canonical["hash"]


def _base():
    columns = [
        {"id": "col_a", "name": "a", "type": "string", "order": 0},
        {"id": "col_b", "name": "b", "type": "string", "order": 1},
    ]
    rows = [
        {"col_a": "1", "col_b": "x"},
        {"col_a": "2", "col_b": "y"},
        {"col_a": "3", "col_b": "z"},
    ]
    return columns, rows


def _op(**kwargs):
    return {"id": kwargs.pop("id", "o"), "at": kwargs.pop("at", 1_700_000_000_000), **kwargs}


def test_replay_leaves_the_input_untouched():
    columns, rows = _base()
    replay_ops(columns, rows, [_op(type="removeRow", row=0)])
    assert len(rows) == 3
    assert ROW_ORD not in rows[0]


def test_added_rows_keep_negative_ordinals_disjoint_from_raw():
    columns, rows = _base()
    columns, rows = replay_ops(columns, rows, [_op(type="addRow", row=-1)])
    columns, rows = replay_ops(columns, rows, [_op(type="addRow", row=-2)])
    assert [r[ROW_ORD] for r in rows] == [0, 1, 2, -1, -2]


def test_set_cell_addresses_by_ordinal_not_position():
    columns, rows = _base()
    columns, rows = replay_ops(columns, rows, [
        _op(type="removeRow", row=0),
        _op(type="setCell", row=2, column="col_b", value="edited"),
    ])
    assert [r[ROW_ORD] for r in rows] == [1, 2]
    assert rows[1]["col_b"] == "edited"


def test_stale_ops_are_skipped_not_fatal():
    columns, rows = _base()
    columns, rows = replay_ops(columns, rows, [
        _op(type="setCell", row=99, column="col_a", value="no"),
        _op(type="setCell", row=0, column="col_missing", value="no"),
        {"id": "x", "at": 0, "type": "nope"},
    ])
    assert len(rows) == 3
    assert "col_missing" not in rows[0]


def test_rename_onto_an_existing_id_is_refused():
    columns, rows = _base()
    columns, rows = replay_ops(columns, rows, [
        _op(type="renameColumn", column="col_a", to="col_b", toName="b"),
    ])
    assert [c["id"] for c in columns] == ["col_a", "col_b"]
    assert rows[0]["col_b"] == "x"


def test_canonical_op_orders_keys_and_drops_absent_fields():
    canonical = canonical_op(_op(type="setCell", row=0, column="col_a", value="v"))
    assert list(canonical) == ["id", "type", "at", "row", "column", "value"]


def test_canonical_op_keeps_an_explicit_null_cell_value():
    canonical = canonical_op(_op(type="setCell", row=0, column="col_a", value=None))
    assert "value" in canonical
    assert canonical["value"] is None


def test_canonical_op_sorts_the_values_map():
    canonical = canonical_op(
        _op(type="addRow", row=-1, values={"col_b": "y", "col_a": "x"})
    )
    assert list(canonical["values"]) == ["col_a", "col_b"]


def test_ops_hash_is_stable_and_changes_with_the_log():
    one = [_op(type="setCell", row=0, column="col_a", value="v")]
    two = one + [_op(type="setCell", row=1, column="col_a", value="w")]
    assert ops_hash(one) == ops_hash(one)
    assert ops_hash(one) != ops_hash(two)
    assert len(ops_hash([])) == 8
