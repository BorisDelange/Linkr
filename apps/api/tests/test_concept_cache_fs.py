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
    concept_cache_fs.write_manifest("src", "", {"runId": "r1", "signature": "s1"}, reset=True)

    # Before any unit, the list is the dictionary with empty counts.
    concept_cache_fs.assemble(config, None, files, [], _ASSEMBLE, "src", "")
    assert _counts("src") == {1: (0, None), 2: (0, None), 3: (0, None)}

    concept_cache_fs.write_unit(config, None, files, [], _UNIT.format(pc="NULL::BIGINT"), "src", "", "records-0", "r1")
    for i, cond in enumerate(["person_id < 2", "person_id >= 2"]):
        sql = (
            "SELECT 'd' AS dict_key, concept_id, NULL::BIGINT AS record_count,"
            f" COUNT(DISTINCT person_id)::BIGINT AS patient_count FROM ext.measurement WHERE {cond} GROUP BY concept_id"
        )
        concept_cache_fs.write_unit(config, None, files, [], sql, "src", "", f"patients-{i}", "r1")

    status = concept_cache_fs.run_status("src", "")
    assert status["manifest"] == {"runId": "r1", "signature": "s1"}
    assert sorted(status["done_units"]) == ["patients-0", "patients-1", "records-0"]
    assert status["last_unit_at"] is not None

    concept_cache_fs.assemble(config, None, files, [], _ASSEMBLE, "src", "")
    assert _counts("src") == {1: (3, 2), 2: (1, 1), 3: (0, None)}


def test_reset_drops_the_units_and_a_resume_keeps_them(duckdb_source, data_dir):
    config, files = duckdb_source
    concept_cache_fs.write_manifest("src", "", {"runId": "r1", "n": 1}, reset=True)
    concept_cache_fs.write_unit(config, None, files, [], _UNIT.format(pc="NULL::BIGINT"), "src", "", "records-0", "r1")

    concept_cache_fs.write_manifest("src", "", {"runId": "r1", "n": 2}, reset=False)
    assert concept_cache_fs.run_status("src", "")["done_units"] == ["records-0"]

    concept_cache_fs.write_manifest("src", "", {"runId": "r2", "n": 3}, reset=True)
    status = concept_cache_fs.run_status("src", "")
    assert status["manifest"] == {"runId": "r2", "n": 3}
    assert status["done_units"] == []


def test_a_unit_needs_a_run_and_a_safe_key(duckdb_source, data_dir):
    config, files = duckdb_source
    sql = _UNIT.format(pc="NULL::BIGINT")
    with pytest.raises(concept_cache_fs.RunConflict, match="no counting run"):
        concept_cache_fs.write_unit(config, None, files, [], sql, "src", "", "records-0", "r1")
    concept_cache_fs.write_manifest("src", "", {"runId": "r1"}, reset=True)
    with pytest.raises(ValueError, match="invalid unit key"):
        concept_cache_fs.write_unit(config, None, files, [], sql, "src", "", "../escape", "r1")
    with pytest.raises(ValueError, match="invalid run id"):
        concept_cache_fs.write_unit(config, None, files, [], sql, "src", "", "records-0", "../x")
    with pytest.raises(ValueError, match="single SELECT"):
        concept_cache_fs.write_unit(config, None, files, [], f"{sql}; SELECT 1", "src", "", "records-0", "r1")


def test_manifest_size_is_bounded(data_dir):
    with pytest.raises(ValueError, match="too large"):
        concept_cache_fs.write_manifest("src", "", {"x": "a" * 1_100_000}, reset=True)


def test_a_running_unit_can_be_interrupted(duckdb_source, data_dir):
    """The unit route tags its query, and `/query/cancel` interrupts it: the COPY
    stops and no unit file is left behind."""
    config, files = duckdb_source
    concept_cache_fs.write_manifest("src", "", {"runId": "r1"}, reset=True)
    slow = (
        "SELECT 'd' AS dict_key, (r % 1000)::BIGINT AS concept_id, COUNT(*)::BIGINT AS record_count,"
        " NULL::BIGINT AS patient_count FROM range(10000000000) t(r) GROUP BY 2"
    )
    errors: list[BaseException] = []

    def run():
        token = query_cancel.current_query.set(("q1", "u1"))
        try:
            concept_cache_fs.write_unit(config, None, files, [], slow, "src", "", "records-0", "r1")
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


def _stalled_unit(monkeypatch, during):
    """A unit whose COPY runs `during()` before it finishes, as a reset or an
    invalidation landing mid-COPY would."""
    from app.services.data import db_connect
    real = db_connect.materialize_parquet

    def slow(*args, **kwargs):
        real(*args, **kwargs)
        during()

    monkeypatch.setattr(db_connect, "materialize_parquet", slow)


def test_a_unit_of_a_replaced_run_is_dropped(duckdb_source, data_dir, monkeypatch):
    """Another worker resets the run between the unit's start and its rename:
    the unit is not kept in the new run, which a resume would count as done."""
    config, files = duckdb_source
    concept_cache_fs.write_manifest("src", "", {"runId": "r1"}, reset=True)
    run = concept_cache_fs._run_dir("src", "")

    def reset_elsewhere():
        (run / "manifest.json").write_text('{"runId": "r2"}')

    _stalled_unit(monkeypatch, reset_elsewhere)
    with pytest.raises(concept_cache_fs.RunConflict, match="replaced"):
        concept_cache_fs.write_unit(config, None, files, [], _UNIT.format(pc="NULL::BIGINT"), "src", "", "records-0", "r1")
    assert concept_cache_fs.run_status("src", "")["done_units"] == []
    assert not list((run / "units").iterdir())


def test_a_unit_of_an_invalidated_run_is_dropped(duckdb_source, data_dir, monkeypatch):
    config, files = duckdb_source
    concept_cache_fs.write_manifest("src", "", {"runId": "r1"}, reset=True)
    _stalled_unit(monkeypatch, lambda: concept_cache_fs.invalidate("src"))
    with pytest.raises(concept_cache_fs.RunConflict):
        concept_cache_fs.write_unit(config, None, files, [], _UNIT.format(pc="NULL::BIGINT"), "src", "", "records-0", "r1")
    concept_cache_fs.write_manifest("src", "", {"runId": "r2"}, reset=False)
    assert concept_cache_fs.run_status("src", "")["done_units"] == []


def test_a_unit_for_a_stale_run_is_refused(duckdb_source, data_dir):
    config, files = duckdb_source
    concept_cache_fs.write_manifest("src", "", {"runId": "r1"}, reset=True)
    concept_cache_fs.write_manifest("src", "", {"runId": "r2"}, reset=True)
    with pytest.raises(concept_cache_fs.RunConflict, match="replaced"):
        concept_cache_fs.write_unit(config, None, files, [], _UNIT.format(pc="NULL::BIGINT"), "src", "", "records-0", "r1")
    with pytest.raises(concept_cache_fs.RunConflict, match="replaced"):
        concept_cache_fs.write_manifest("src", "", {"runId": "r1", "finishedAt": "x"}, reset=False)


def test_a_second_live_run_is_refused(duckdb_source, data_dir, monkeypatch):
    """While a unit counts, neither a reset nor another unit of the database may
    start; once it ends, both may."""
    config, files = duckdb_source
    concept_cache_fs.write_manifest("src", "", {"runId": "r1"}, reset=True)
    sql = _UNIT.format(pc="NULL::BIGINT")
    seen: list[str] = []

    def try_concurrent():
        with pytest.raises(concept_cache_fs.RunConflict, match="in progress"):
            concept_cache_fs.write_manifest("src", "", {"runId": "r2"}, reset=True)
        with pytest.raises(concept_cache_fs.RunConflict, match="in progress"):
            concept_cache_fs.write_unit(config, None, files, [], sql, "src", "", "records-1", "r1")
        seen.append("checked")

    _stalled_unit(monkeypatch, try_concurrent)
    concept_cache_fs.write_unit(config, None, files, [], sql, "src", "", "records-0", "r1")
    assert seen == ["checked"]
    assert concept_cache_fs.run_status("src", "")["done_units"] == ["records-0"]
    monkeypatch.undo()
    concept_cache_fs.write_manifest("src", "", {"runId": "r2"}, reset=True)


def test_a_manifest_write_sweeps_leftover_unit_files(data_dir):
    concept_cache_fs.write_manifest("src", "", {"runId": "r1"}, reset=True)
    units = concept_cache_fs._run_dir("src", "") / "units"
    units.mkdir()
    (units / "records-0.parquet.tmp-1-abc").write_text("x")
    concept_cache_fs.write_manifest("src", "", {"runId": "r1"}, reset=False)
    assert not list(units.iterdir())


def test_counted_relations_say_which_relations_hold_the_concepts(duckdb_source, data_dir):
    """Records name their relation; the patient units and a unit of an older
    build (no relation) are not reported."""
    config, files = duckdb_source
    units = [{"key": k, "step": "records"} for k in ("records-0-std", "records-1-std", "records-2-std")]
    concept_cache_fs.write_manifest("src", "", {"runId": "r1", "units": units}, reset=True)
    for i, (rel, cond) in enumerate([("ev_a", "concept_id = 1"), ("ev_b", "concept_id = 2")]):
        sql = (
            f"SELECT 'd' AS dict_key, concept_id, COUNT(*)::BIGINT AS record_count, NULL::BIGINT AS patient_count,"
            f" '{rel}' AS relation, 'sig-{rel}' AS relation_sig FROM ext.measurement WHERE {cond} GROUP BY concept_id"
        )
        concept_cache_fs.write_unit(config, None, files, [], sql, "src", "", f"records-{i}-std", "r1")
    concept_cache_fs.write_unit(config, None, files, [], _UNIT.format(pc="NULL::BIGINT"), "src", "", "records-2-std", "r1")
    patients = (
        "SELECT 'd' AS dict_key, concept_id, NULL::BIGINT AS record_count, COUNT(DISTINCT person_id)::BIGINT AS patient_count"
        " FROM ext.measurement GROUP BY concept_id"
    )
    concept_cache_fs.write_unit(config, None, files, [], patients, "src", "", "patients-1-of-1", "r1")

    got = sorted(concept_cache_fs.counted_relations("src", "", ["2"]), key=lambda r: r["relation"])
    assert got == [
        {"relation": "ev_a", "signature": "sig-ev_a", "holds": False},
        {"relation": "ev_b", "signature": "sig-ev_b", "holds": True},
    ]


def test_counted_relations_of_units_that_name_none(duckdb_source, data_dir):
    config, files = duckdb_source
    assert concept_cache_fs.counted_relations("src", "", ["1"]) == []
    concept_cache_fs.write_manifest("src", "", {"runId": "r1", "units": [{"key": "records-0-std", "step": "records"}]}, reset=True)
    concept_cache_fs.write_unit(config, None, files, [], _UNIT.format(pc="NULL::BIGINT"), "src", "", "records-0-std", "r1")
    assert concept_cache_fs.counted_relations("src", "", ["1"]) == []


def _relation_unit(column: str) -> str:
    return (
        f"SELECT 'd' AS dict_key, {column} AS concept_id, COUNT(*)::BIGINT AS record_count, NULL::BIGINT AS patient_count,"
        f" 'ev' AS relation, 'sig' AS relation_sig FROM ext.measurement GROUP BY {column}"
    )


def test_a_relation_counted_on_one_of_its_columns_is_not_reported(duckdb_source, data_dir):
    """The standard and source units name one relation: with the source unit not
    done yet, a concept only it holds would read as absent and drop the relation."""
    config, files = duckdb_source
    units = [{"key": "records-0-std", "step": "records"}, {"key": "records-0-src", "step": "records"}]
    concept_cache_fs.write_manifest("src", "", {"runId": "r1", "units": units}, reset=True)
    concept_cache_fs.write_unit(config, None, files, [], _relation_unit("concept_id"), "src", "", "records-0-std", "r1")
    assert concept_cache_fs.counted_relations("src", "", ["999"]) == []

    concept_cache_fs.write_unit(config, None, files, [], _relation_unit("concept_id"), "src", "", "records-0-src", "r1")
    assert concept_cache_fs.counted_relations("src", "", ["999"]) == [{"relation": "ev", "signature": "sig", "holds": False}]


def test_counted_relations_without_planned_units_report_none(duckdb_source, data_dir):
    config, files = duckdb_source
    concept_cache_fs.write_manifest("src", "", {"runId": "r1"}, reset=True)
    concept_cache_fs.write_unit(config, None, files, [], _relation_unit("concept_id"), "src", "", "records-0-std", "r1")
    assert concept_cache_fs.counted_relations("src", "", ["1"]) == []


# --- The `stats` step -----------------------------------------------------------


def test_ranges_pack_ids_by_their_rows():
    weights = [(5, 40), (1, 30), (9, 10), (7, 200), (12, 5)]
    # 1+5 fill a range; 7 alone exceeds it; 9+12 share the last, open-ended one.
    assert concept_cache_fs.pack_ranges(weights, 100) == [(None, 5), (6, 7), (8, None)]
    assert concept_cache_fs.pack_ranges([(3, 10)], 100) == [(None, None)]


_VALUED_UNIT = """SELECT 'd' AS dict_key, concept_id, bin, bin_count, value_count, min_val, max_val, mean_val, std_val,
  p01, q1_val, median_val, q3_val, p99
FROM (VALUES
  (1, -1, 2, 50, 1.0, 9.0, 4.996, 2.5, 1.5, 2.0, 5.0, 7.0, 8.5),
  (1, 0, 30, 50, 1.0, 9.0, 4.996, 2.5, 1.5, 2.0, 5.0, 7.0, 8.5),
  (1, 19, 18, 50, 1.0, 9.0, 4.996, 2.5, 1.5, 2.0, 5.0, 7.0, 8.5)
) t(concept_id, bin, bin_count, value_count, min_val, max_val, mean_val, std_val, p01, q1_val, median_val, q3_val, p99)"""


def _stats_run(duckdb_source, stats_keys):
    config, files = duckdb_source
    units = [{"key": "records-0-std", "step": "records"}] + [{"key": k, "step": "stats"} for k in stats_keys]
    concept_cache_fs.write_manifest("src", "", {"runId": "r1", "units": units}, reset=True)
    records = (
        "SELECT 'd' AS dict_key, concept_id, COUNT(*)::BIGINT AS record_count, NULL::BIGINT AS patient_count,"
        " 'ev_m' AS relation, 'sig' AS relation_sig FROM ext.measurement GROUP BY concept_id"
    )
    concept_cache_fs.write_unit(config, None, files, [], records, "src", "", "records-0-std", "r1")
    return config, files


def test_stats_ranges_come_from_the_counted_rows_of_the_value_tables(duckdb_source, data_dir):
    _stats_run(duckdb_source, [])
    dicts = [{"dictKey": "d", "relations": ["ev_m"]}]
    # concept 1: 3 rows, concept 2: 1 row.
    assert concept_cache_fs.plan_stats_ranges("src", "", dicts, 2) == [
        {"dictKey": "d", "lo": None, "hi": 1}, {"dictKey": "d", "lo": 2, "hi": None},
    ]
    assert concept_cache_fs.plan_stats_ranges("src", "", dicts, 100) == [{"dictKey": "d", "lo": None, "hi": None}]
    # A dictionary whose relations no record unit counted (it holds its counts): one unit.
    held = [{"dictKey": "h", "relations": ["ev_held"]}]
    concept_cache_fs.write_manifest("src", "", {"runId": "r2"}, reset=True)
    assert concept_cache_fs.plan_stats_ranges("src", "", held, 100) == [{"dictKey": "h", "lo": None, "hi": None}]


def test_precomputed_stats_read_like_the_panel_query(duckdb_source, data_dir):
    config, files = _stats_run(duckdb_source, ["stats-1-of-2", "stats-2-of-2"])
    assert concept_cache_fs.precomputed_stats("src", "", 1, None) is None
    concept_cache_fs.write_unit(config, None, files, [], _VALUED_UNIT, "src", "", "stats-1-of-2", "r1")

    stats, computed_at = concept_cache_fs.precomputed_stats("src", "", 1, "d")
    assert computed_at > 0
    assert stats["rowCount"] == 3
    assert stats["histogramVariant"] == concept_cache_fs.PRECOMPUTED_STATS_VARIANT
    assert stats["distribution"] == {
        "total_count": 50, "non_null_count": 50, "min_val": 1.0, "max_val": 9.0, "mean_val": 5.0,
        "median_val": 5.0, "std_val": 2.5, "q1_val": 2.0, "q3_val": 7.0,
    }
    # 20 bins over P1–P99 (1.5–8.5): width 0.35; the outliers on every bin.
    assert stats["histogram"] == [
        {"bin_start": 1.5, "count": 30, "excluded_count": 2},
        {"bin_start": 8.15, "count": 18, "excluded_count": 2},
    ]
    # Another dictionary's concept 1, or a concept no done unit holds: not yet.
    assert concept_cache_fs.precomputed_stats("src", "", 1, "other") is None
    assert concept_cache_fs.precomputed_stats("src", "", 2, None) is None

    # Every stats unit done: a concept without values reads as such.
    concept_cache_fs.write_unit(config, None, files, [], _VALUED_UNIT + " WHERE false", "src", "", "stats-2-of-2", "r1")
    stats, _ = concept_cache_fs.precomputed_stats("src", "", 2, None)
    assert stats["rowCount"] == 1
    assert stats["distribution"]["non_null_count"] == 0
    assert stats["histogram"] == []


def test_double_concept_ids_are_matched_as_numbers(duckdb_source, data_dir):
    """Ids that went through pandas or a CSV are DOUBLE: '1.0' as text. The stats,
    the row count and the relations holding a concept must still find it."""
    config, files = duckdb_source
    units = [{"key": "records-0-std", "step": "records"}, {"key": "stats-1-of-1", "step": "stats"}]
    concept_cache_fs.write_manifest("src", "", {"runId": "r1", "units": units}, reset=True)
    records = (
        "SELECT 'd' AS dict_key, concept_id::DOUBLE AS concept_id, COUNT(*)::BIGINT AS record_count,"
        " NULL::BIGINT AS patient_count, 'ev_m' AS relation, 'sig' AS relation_sig"
        " FROM ext.measurement GROUP BY concept_id"
    )
    concept_cache_fs.write_unit(config, None, files, [], records, "src", "", "records-0-std", "r1")
    doubled = _VALUED_UNIT.replace("SELECT 'd' AS dict_key, concept_id,", "SELECT 'd' AS dict_key, concept_id::DOUBLE AS concept_id,")
    concept_cache_fs.write_unit(config, None, files, [], doubled, "src", "", "stats-1-of-1", "r1")

    stats, _ = concept_cache_fs.precomputed_stats("src", "", 1, "d")
    assert stats["rowCount"] == 3
    assert stats["distribution"]["non_null_count"] == 50
    assert concept_cache_fs.counted_relations("src", "", ["1"]) == [{"relation": "ev_m", "signature": "sig", "holds": True}]
    assert concept_cache_fs.counted_relations("src", "", ["9"])[0]["holds"] is False


def test_diagnose_names_the_unit_that_should_describe_a_concept(duckdb_source, data_dir):
    config, files = _stats_run(duckdb_source, ["stats-1-of-2", "stats-2-of-2"])
    run = {"runId": "r1", "units": [{"key": "records-0-std", "step": "records"},
           {"key": "stats-1-of-2", "step": "stats"}, {"key": "stats-2-of-2", "step": "stats"}],
           "statsRanges": [{"dictKey": "d", "lo": None, "hi": 1}, {"dictKey": "d", "lo": 2, "hi": None}]}
    concept_cache_fs.write_manifest("src", "", run, reset=False)
    concept_cache_fs.write_unit(config, None, files, [], _VALUED_UNIT, "src", "", "stats-1-of-2", "r1")
    concept_cache_fs.write_unit(config, None, files, [], _VALUED_UNIT + " WHERE false", "src", "", "stats-2-of-2", "r1")

    described = concept_cache_fs.diagnose_stats("src", "", 1, "d")
    assert described["statsUnitsPlanned"] == 2 and described["statsUnitsDone"] == 2
    assert [u["unit"] for u in described["covering"]] == ["stats-1-of-2"]
    assert described["covering"][0]["rows"] == 3
    assert described["inStatsUnits"][0]["asNumber"] == 3
    assert described["inRecordUnits"][0]["unit"] == "records-0-std"

    # Concept 2 has rows, but the unit of its range wrote nothing: said so.
    missed = concept_cache_fs.diagnose_stats("src", "", 2, "d")
    assert missed["covering"] == [{"unit": "stats-2-of-2", "dictKey": "d", "lo": 2, "hi": None, "done": True,
                                   "rows": 0, "concepts": 0, "minConceptId": None, "maxConceptId": None,
                                   "conceptIdType": None}]
    assert missed["inStatsUnits"] == []
    assert missed["inRecordUnits"][0]["asNumber"] == 1


def test_the_list_is_assembled_from_the_count_units_alone(duckdb_source, data_dir):
    config, files = _stats_run(duckdb_source, ["stats-1-of-1"])
    concept_cache_fs.write_unit(config, None, files, [], _VALUED_UNIT, "src", "", "stats-1-of-1", "r1")
    concept_cache_fs.assemble(config, None, files, [], _ASSEMBLE, "src", "")
    assert _counts("src") == {1: (3, None), 2: (1, None), 3: (0, None)}
