"""The concept-list Parquet cache: counting units written per run, assembled
with the dictionaries into the cached list, paged back, invalidated."""

import threading
import time

import duckdb
import pytest

from app.services.data import concept_cache_fs, query_cancel


@pytest.fixture
def data_dir(monkeypatch, tmp_path):
    from app.config import settings
    monkeypatch.setattr(settings, "data_dir", str(tmp_path / "data"), raising=False)
    # data_path is a cached_property; clear it so the temp dir takes effect.
    settings.__dict__.pop("data_path", None)
    yield
    settings.__dict__.pop("data_path", None)


def _refresh(config, files, select, src_id, principal):
    """A one-shot list: a run with no unit, assembled straight away."""
    concept_cache_fs.write_manifest(src_id, principal, {}, reset=True)
    concept_cache_fs.assemble(config, None, files, [], select, src_id, principal)


@pytest.fixture
def duckdb_source(tmp_path):
    """A tiny DuckDB file with a `concept` table, returned as the (config, files)
    a file-engine source would pass to materialize."""
    db = tmp_path / "src.duckdb"
    con = duckdb.connect(str(db))
    con.execute("CREATE TABLE concept (concept_id INTEGER, concept_name TEXT, record_count INTEGER)")
    con.execute("INSERT INTO concept VALUES (1,'Sodium',10),(2,'Glucose',20),(3,'Urea',0)")
    con.execute("CREATE TABLE measurement (person_id INTEGER, concept_id INTEGER)")
    con.execute("INSERT INTO measurement VALUES (1,1),(1,1),(2,1),(2,2)")
    con.close()
    config = {"engine": "duckdb"}
    files = [("src.duckdb", str(db))]
    return config, files


def test_assemble_materializes_and_page_reads_back(duckdb_source, data_dir):
    config, files = duckdb_source
    src_id = "src-abc"
    select = "SELECT concept_id, concept_name, record_count FROM ext.concept"

    assert not concept_cache_fs.exists(src_id, "")
    _refresh(config, files, select, src_id, "")
    assert concept_cache_fs.exists(src_id, "")

    # Page query runs against the cached Parquet (view `concepts`), never the source.
    rows = concept_cache_fs.query_page(
        src_id, "", "SELECT * FROM concepts ORDER BY record_count DESC LIMIT 2"
    )
    assert [r["concept_id"] for r in rows] == [2, 1]
    assert rows[0]["concept_name"] == "Glucose"


def test_invalidate_removes_cache(duckdb_source, data_dir):
    config, files = duckdb_source
    src_id = "src-xyz"
    select = "SELECT concept_id, concept_name FROM ext.concept"
    _refresh(config, files, select, src_id, "")
    assert concept_cache_fs.exists(src_id, "")
    concept_cache_fs.invalidate(src_id)
    assert not concept_cache_fs.exists(src_id, "")
    assert concept_cache_fs.run_status(src_id, "") is None
    with pytest.raises(FileNotFoundError):
        concept_cache_fs.query_page(src_id, "", "SELECT * FROM concepts")


def test_one_cache_per_principal(duckdb_source, data_dir):
    """Two users' views of an external database never share a cache; dropping
    one user's leaves the other's, dropping the source's drops all."""
    config, files = duckdb_source
    select = "SELECT concept_id FROM ext.concept"
    _refresh(config, files, select, "src", "user:1")
    assert concept_cache_fs.exists("src", "user:1")
    assert not concept_cache_fs.exists("src", "user:2")
    assert not concept_cache_fs.exists("src", "")

    _refresh(config, files, select, "src", "user:2")
    concept_cache_fs.invalidate("src", "user:1")
    assert not concept_cache_fs.exists("src", "user:1")
    assert concept_cache_fs.exists("src", "user:2")

    concept_cache_fs.invalidate("src")
    assert not concept_cache_fs.exists("src", "user:2")
    assert concept_cache_fs.run_status("src", "user:2") is None


def test_cache_path_rejects_bad_id():
    with pytest.raises(ValueError):
        concept_cache_fs.cache_path("../etc/passwd", "")
    with pytest.raises(ValueError):
        concept_cache_fs.cache_path("src", "../x")


_UNIT = "SELECT 'd' AS dict_key, concept_id, COUNT(*)::BIGINT AS record_count, {pc} AS patient_count FROM ext.measurement GROUP BY concept_id"
_ASSEMBLE = """SELECT c.concept_id, c.concept_name, COALESCE(n.record_count, 0) AS record_count, n.patient_count
FROM ext.concept c LEFT JOIN (
  SELECT concept_id, SUM(record_count) AS record_count, SUM(patient_count) AS patient_count
  FROM memory.main._concept_counts WHERE dict_key = 'd' GROUP BY concept_id
) n ON n.concept_id = c.concept_id"""


def _counts(src_id):
    rows = concept_cache_fs.query_page(src_id, "", "SELECT * FROM concepts ORDER BY concept_id")
    return {r["concept_id"]: (r["record_count"], r["patient_count"]) for r in rows}


def test_units_add_up_in_the_assembled_list(duckdb_source, data_dir):
    """Records from one unit and patients from two disjoint slices: the list sums
    them, and a concept no unit saw keeps the dictionary row with no counts."""
    config, files = duckdb_source
    concept_cache_fs.write_manifest("src", "", {"signature": "s1"}, reset=True)

    # Before any unit, the list is the dictionary with empty counts.
    concept_cache_fs.assemble(config, None, files, [], _ASSEMBLE, "src", "")
    assert _counts("src") == {1: (0, None), 2: (0, None), 3: (0, None)}

    concept_cache_fs.write_unit(config, None, files, [], _UNIT.format(pc="NULL::BIGINT"), "src", "", "records-0")
    for i, cond in enumerate(["person_id < 2", "person_id >= 2"]):
        sql = (
            "SELECT 'd' AS dict_key, concept_id, NULL::BIGINT AS record_count,"
            f" COUNT(DISTINCT person_id)::BIGINT AS patient_count FROM ext.measurement WHERE {cond} GROUP BY concept_id"
        )
        concept_cache_fs.write_unit(config, None, files, [], sql, "src", "", f"patients-{i}")

    status = concept_cache_fs.run_status("src", "")
    assert status["manifest"] == {"signature": "s1"}
    assert sorted(status["done_units"]) == ["patients-0", "patients-1", "records-0"]
    assert status["last_unit_at"] is not None

    concept_cache_fs.assemble(config, None, files, [], _ASSEMBLE, "src", "")
    assert _counts("src") == {1: (3, 2), 2: (1, 1), 3: (0, None)}


def test_reset_drops_the_units_and_a_resume_keeps_them(duckdb_source, data_dir):
    config, files = duckdb_source
    concept_cache_fs.write_manifest("src", "", {"n": 1}, reset=True)
    concept_cache_fs.write_unit(config, None, files, [], _UNIT.format(pc="NULL::BIGINT"), "src", "", "records-0")

    concept_cache_fs.write_manifest("src", "", {"n": 2}, reset=False)
    assert concept_cache_fs.run_status("src", "")["done_units"] == ["records-0"]

    concept_cache_fs.write_manifest("src", "", {"n": 3}, reset=True)
    status = concept_cache_fs.run_status("src", "")
    assert status["manifest"] == {"n": 3}
    assert status["done_units"] == []


def test_a_unit_needs_a_run_and_a_safe_key(duckdb_source, data_dir):
    config, files = duckdb_source
    sql = _UNIT.format(pc="NULL::BIGINT")
    with pytest.raises(ValueError, match="no counting run"):
        concept_cache_fs.write_unit(config, None, files, [], sql, "src", "", "records-0")
    concept_cache_fs.write_manifest("src", "", {}, reset=True)
    with pytest.raises(ValueError, match="invalid unit key"):
        concept_cache_fs.write_unit(config, None, files, [], sql, "src", "", "../escape")
    with pytest.raises(ValueError, match="single SELECT"):
        concept_cache_fs.write_unit(config, None, files, [], f"{sql}; SELECT 1", "src", "", "records-0")


def test_manifest_size_is_bounded(data_dir):
    with pytest.raises(ValueError, match="too large"):
        concept_cache_fs.write_manifest("src", "", {"x": "a" * 1_100_000}, reset=True)


def test_a_running_unit_can_be_interrupted(duckdb_source, data_dir):
    """The unit route tags its query, and `/query/cancel` interrupts it: the COPY
    stops and no unit file is left behind."""
    config, files = duckdb_source
    concept_cache_fs.write_manifest("src", "", {}, reset=True)
    slow = (
        "SELECT 'd' AS dict_key, (r % 1000)::BIGINT AS concept_id, COUNT(*)::BIGINT AS record_count,"
        " NULL::BIGINT AS patient_count FROM range(10000000000) t(r) GROUP BY 2"
    )
    errors: list[BaseException] = []

    def run():
        token = query_cancel.current_query.set(("q1", "u1"))
        try:
            concept_cache_fs.write_unit(config, None, files, [], slow, "src", "", "records-0")
        except BaseException as e:  # noqa: BLE001
            errors.append(e)
        finally:
            query_cancel.current_query.reset(token)

    t = threading.Thread(target=run)
    t.start()
    deadline = time.monotonic() + 10
    while "q1" not in query_cancel._running:
        assert time.monotonic() < deadline, "the unit never started"
        time.sleep(0.02)
    assert query_cancel.cancel("q1", "u1")
    t.join(timeout=30)
    assert not t.is_alive()
    assert errors and isinstance(errors[0], duckdb.InterruptException)
    assert concept_cache_fs.run_status("src", "")["done_units"] == []
