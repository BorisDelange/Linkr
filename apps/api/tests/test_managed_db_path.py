"""`managed_db.path_for` turns a data source id into a filesystem path, so what
it accepts is a security boundary as much as a correctness one."""

import pytest

from app.services.data.managed_db import path_for


@pytest.mark.parametrize(
    "source_id",
    [
        # The case that broke: a database imported from a workspace or installed
        # from the catalog keeps the readable slug its repo declares as its
        # primary key, so requiring a UUID made every managed operation on one
        # raise — surfacing as a 500 on GET /data-sources/{id}/schema.
        "mimic-iv-demo",
        "aadc2713-f4a7-41c2-bf55-845f4ba0408b",
        "db_1",
        "a",
    ],
)
def test_accepts_the_ids_the_app_actually_mints(source_id):
    assert path_for(source_id).name == f"{source_id}.duckdb"


@pytest.mark.parametrize(
    "source_id",
    [
        "../etc/passwd",
        "a/b",
        "/abs",
        "..",
        ".hidden",
        "",
        "a b",
        "x;rm -rf /",
        # Uppercase is refused so two ids cannot name the same file on a
        # case-insensitive filesystem (`abc`/`ABC` on macOS).
        "ABC",
        "a" * 200,
        None,
    ],
)
def test_rejects_anything_that_could_escape_or_collide(source_id):
    with pytest.raises(ValueError):
        path_for(source_id)


def test_stays_inside_the_databases_directory():
    path = path_for("mimic-iv-demo")
    assert path.parent.name == "_databases"
    assert path.resolve().parent == path.parent.resolve()
