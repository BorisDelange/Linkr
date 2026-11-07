"""A column id in an ops log is one the app could have minted."""

import pytest
from pydantic import ValidationError

from app.schemas.dataset_fs import DsOps
from app.services.data.dataset_ops import replay_ops

UNMINTED = ['a"b', "a'b", "a b", "a;b", "", 'x": \'VARCHAR\'}) j, (SELECT 1) --']


def _columns():
    return [{"id": "col_a", "name": "a", "type": "string", "order": 0}]


@pytest.mark.parametrize("col_id", UNMINTED)
def test_a_replayed_log_drops_a_column_id_the_app_never_mints(col_id):
    columns, _ = replay_ops(_columns(), [{"col_a": "1"}], [
        {"type": "addColumn", "column": col_id, "name": "x", "colType": "string"},
        {"type": "renameColumn", "column": "col_a", "to": col_id, "toName": "x"},
    ])
    assert [c["id"] for c in columns] == ["col_a"]


@pytest.mark.parametrize("col_id", ["col_b", "col_b_2", "col-b", "COL1"])
def test_a_minted_column_id_still_replays(col_id):
    columns, _ = replay_ops(_columns(), [], [
        {"type": "addColumn", "column": col_id, "name": "x", "colType": "string"},
    ])
    assert [c["id"] for c in columns] == ["col_a", col_id]


@pytest.mark.parametrize("op", [
    {"type": "addColumn", "column": 'a"b', "name": "x", "colType": "string"},
    {"type": "renameColumn", "column": "col_a", "to": 'a"b', "toName": "x"},
])
def test_the_route_refuses_a_column_id_the_app_never_mints(op):
    with pytest.raises(ValidationError):
        DsOps(project_uid="p", path="d.csv", ops=[op])


def test_the_route_takes_the_other_ops_as_they_are():
    DsOps(project_uid="p", path="d.csv", ops=[{"type": "setCell", "row": 1, "column": "col_a", "value": 'a"b'}])
