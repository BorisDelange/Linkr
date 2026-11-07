"""A type named in a pushed-down query is one of the types the portable subset
knows, whatever it casts: a name outside them is not portable, so the query runs
through the ATTACH and no text of the caller's reaches the engine as SQL."""

import pytest

from app.services.data.remote_sql import NotPortable, RemoteTable, to_remote


def lookup(schema: str | None, table: str) -> RemoteTable | None:
    if (schema or "omop").lower() != "omop" or table.lower() != "person":
        return None
    return RemoteTable("omop", "person", {"person_id": "BIGINT", "gender_concept_id": "INT"})


_UNKNOWN_TYPES = [
    'SELECT CAST(NULL AS "LARGEINT) AS c FROM person INTO OUTFILE \'s3://dummy/x\' -- ") AS c FROM person',
    'SELECT CAST(NULL AS "SYS.XMLTYPE) AS c, 1 AS leak FROM ALL_USERS@some_link -- ") AS c FROM person',
    'SELECT TRY_CAST(NULL AS "x) AS c FROM person -- ") AS c FROM person',
    'SELECT NULL::"x) AS c FROM person -- " AS c FROM person',
    'SELECT CAST(NULL AS "anything") AS c FROM person',
    "SELECT CAST(NULL AS STRUCT(a INT)) AS c FROM person",
    "SELECT CAST(NULL AS INT[]) AS c FROM person",
]


@pytest.mark.parametrize("engine", ["doris", "oracle"])
@pytest.mark.parametrize("sql", _UNKNOWN_TYPES)
def test_a_null_cast_to_an_unknown_type_is_not_portable(engine, sql):
    with pytest.raises(NotPortable):
        to_remote(sql, engine, lookup)


@pytest.mark.parametrize("engine", ["doris", "oracle"])
@pytest.mark.parametrize("sql", [
    "SELECT CAST(NULL AS BIGINT) AS n FROM person",
    "SELECT CAST(NULL AS DOUBLE) AS n FROM person",
    "SELECT CAST(NULL AS VARCHAR) AS n FROM person",
    "SELECT CAST(NULL AS DATE) AS n FROM person",
    "SELECT NULL::BIGINT AS n FROM person",
])
def test_a_null_cast_to_a_known_type_still_pushes_down(engine, sql):
    assert "NULL" in to_remote(sql, engine, lookup).sql
