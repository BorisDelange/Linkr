"""Concept-count bench: synthetic OMOP Parquet folder, counted through the real
server functions (concept_cache_fs), checked against a brute-force count, timed.
Also times one patient's lookup, sorted vs unsorted files. See README.md.
"""

import argparse
import json
import math
import shutil
import sys
import time
from pathlib import Path

import duckdb

HERE = Path(__file__).parent
SQL = json.loads((HERE / "sql.json").read_text())
TABLES = {  # name -> (share of rows, concept col, source col, date col)
    "measurement": (0.7, "measurement_concept_id", "measurement_source_concept_id", "measurement_datetime"),
    "condition_occurrence": (0.2, "condition_concept_id", "condition_source_concept_id", "condition_start_datetime"),
    "drug_exposure": (0.1, "drug_concept_id", None, "drug_exposure_start_datetime"),
}


def generate(root: Path, rows: int, patients: int, sort: bool) -> None:
    if (root / "_done").exists():
        return
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True)
    con = duckdb.connect()
    con.execute("SET preserve_insertion_order = false")
    (root / "person").mkdir()
    con.execute(f"""COPY (SELECT r + 1 AS person_id, 1940 + r % 60 AS year_of_birth, CASE WHEN r % 2 = 0 THEN 8507 ELSE 8532 END AS gender_concept_id
        FROM range({patients}) t(r)) TO '{root}/person/data_0.parquet' (FORMAT PARQUET)""")
    (root / "concept").mkdir()
    con.execute(f"""COPY (
        SELECT r AS concept_id, 'Concept ' || r AS concept_name, 'Domain' || (r % 5) AS domain_id FROM range(1, 5001) t(r)
        UNION ALL SELECT 2000000000 + r, 'Source ' || r, 'Source' FROM range(1, 1001) t(r)
      ) TO '{root}/concept/data_0.parquet' (FORMAT PARQUET)""")
    for table, (share, ccol, scol, dcol) in TABLES.items():
        n = int(rows * share)
        # Skewed patients: patient 1 alone holds ~2 % of the rows (the "50 M rows" patient).
        pid = f"CASE WHEN hash(r, 7) % 50 = 0 THEN 1 ELSE 1 + (hash(r, 1) % {patients}) END"
        cid = "1 + (hash(r, 2) % 3000)"
        src = f", CASE WHEN hash(r, 3) % 10 = 0 THEN {cid} ELSE 2000000000 + (hash(r, 4) % 1000) + 1 END AS {scol}" if scol else ""
        select = f"""SELECT ({pid})::BIGINT AS person_id, ({cid})::BIGINT AS {ccol}{src},
            TIMESTAMP '2010-01-01' + to_seconds((hash(r, 5) % 400000000)::BIGINT) AS {dcol}
            FROM range({n}) t(r)"""
        if sort:
            select = f"SELECT * FROM ({select}) ORDER BY person_id, {dcol}"
        (root / table).mkdir()
        con.execute(f"COPY ({select}) TO '{root}/{table}' (FORMAT PARQUET, PER_THREAD_OUTPUT, ROW_GROUP_SIZE 122880)")
    (root / "_done").touch()


def source_files(root: Path) -> list[tuple[str, str]]:
    return [(p.relative_to(root).as_posix(), str(p)) for p in sorted(root.rglob("*.parquet"))]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=20_000_000)
    ap.add_argument("--patients", type=int, default=200_000)
    ap.add_argument("--variant", choices=["unsorted", "sorted"], default="unsorted")
    ap.add_argument("--slice-rows", type=int, default=100_000_000)
    ap.add_argument("--old", action="store_true", help="also time the former single COPY")
    ap.add_argument("--no-check", action="store_true")
    ap.add_argument("--overview-only", action="store_true", help="skip the concept counts")
    ap.add_argument("--work", required=True, help="folder for the generated data (tens of GB at 1 B rows)")
    args = ap.parse_args()

    from app.config import settings
    from app.services.data import concept_cache_fs, db_connect

    work = Path(args.work)
    root = work / f"omop-{args.rows}-{args.patients}-{args.variant}"
    t0 = time.monotonic()
    generate(root, args.rows, args.patients, args.variant == "sorted")
    print(f"data ready in {time.monotonic() - t0:.1f}s at {root}")

    settings.data_dir = str(work / f"data-{args.variant}")
    settings.__dict__.pop("data_path", None)
    files = source_files(root)
    known = ["person", "concept", *TABLES]
    config = {"engine": "parquet"}

    def q(sql):
        return db_connect.query_parquet_folder(files, known, sql)

    if not args.overview_only:
        size = q(SQL["size"])[0]
        wanted = min(64, math.ceil(int(size["event_rows"]) / args.slice_rows))
        n = 1 if wanted < 2 else wanted
        if str(n) not in SQL["plans"]:
            n = min((int(k) for k in SQL["plans"]), key=lambda k: abs(k - n))
        bounds = [r["b"] for r in q(SQL["bounds"][str(n)])] if n > 1 else []
        print(f"event rows {size['event_rows']:,}, patients {size['patients']:,} -> {n} slice(s) {bounds}")

        units = SQL["plans"][str(n)]
        concept_cache_fs.write_manifest("bench", "", {"bench": True}, reset=True)
        timings = []
        for u in units:
            sql = u["sql"]
            for i, b in enumerate(bounds, start=1):
                sql = sql.replace(f"'__B{i}'", str(b))
            t = time.monotonic()
            concept_cache_fs.write_unit(config, None, files, known, sql, "bench", "", u["key"])
            timings.append((u["key"], time.monotonic() - t))
            print(f"  {u['key']:<24} {timings[-1][1]:7.2f}s", flush=True)
            if u["key"] == [x for x in units if x["step"] == "records"][-1]["key"]:
                t = time.monotonic()
                concept_cache_fs.assemble(config, None, files, known, SQL["assemble"]["partial"], "bench", "")
                print(f"  {'assemble (records done)':<24} {time.monotonic() - t:7.2f}s")
        t = time.monotonic()
        concept_cache_fs.assemble(config, None, files, known, SQL["assemble"]["complete"], "bench", "")
        print(f"  {'assemble (complete)':<24} {time.monotonic() - t:7.2f}s")
        total = sum(s for _, s in timings)
        print(f"units total {total:.1f}s, slowest {max(timings, key=lambda x: x[1])}")

        if not args.no_check:
            got = {
                r["concept_id"]: (r["record_count"], r["patient_count"])
                for r in concept_cache_fs.query_page("bench", "", "SELECT concept_id, record_count, patient_count FROM concepts")
            }
            parts = []
            for table, (_, ccol, scol, _) in TABLES.items():
                parts.append(f"SELECT {ccol} AS cid, person_id AS pid FROM {table}")
                if scol:
                    parts.append(f"SELECT {scol}, person_id FROM {table} WHERE {scol} IS DISTINCT FROM {ccol}")
            expected = {
                r["cid"]: (r["n"], r["p"])
                for r in q(f"SELECT cid, COUNT(*)::BIGINT AS n, COUNT(DISTINCT pid)::BIGINT AS p FROM ({' UNION ALL '.join(parts)}) GROUP BY cid")
            }
            bad = [(c, got.get(c), e) for c, e in expected.items() if got.get(c) != e]
            zero = [c for c, v in got.items() if c not in expected and v != (0, 0)]
            print(f"check: {len(expected)} concepts with events, {len(bad)} mismatches, {len(zero)} non-zero without events")
            if bad or zero:
                print(bad[:5], zero[:5])
                sys.exit(1)

    t = time.monotonic()
    rows = q("SELECT COUNT(*) AS n FROM measurement WHERE person_id = 1")[0]["n"]
    print(f"one patient's measurements ({rows:,} rows): {time.monotonic() - t:.2f}s")
    t = time.monotonic()
    q("SELECT COUNT(*) AS n FROM measurement WHERE person_id = 4242")
    print(f"a small patient's measurements: {time.monotonic() - t:.2f}s")

    if "overview" in SQL:
        ov = SQL["overview"]
        t = time.monotonic()
        inv = q(ov["inventory"])
        print(f"overview inventory ({len(inv)} concepts): {time.monotonic() - t:.2f}s")
        for name, tiles in ov["density"].items():
            t = time.monotonic()
            for sql in tiles:
                q(sql)
            print(f"overview density, {name} view: {time.monotonic() - t:.2f}s")
        t = time.monotonic()
        n = len(q(ov["events"]))
        print(f"overview events, one day ({n} rows): {time.monotonic() - t:.2f}s")

    if args.old:
        parts = []
        for table, (_, ccol, scol, _) in TABLES.items():
            parts.append(f"SELECT {ccol} AS cid, person_id AS pid FROM {table}")
            if scol:
                parts.append(f"SELECT {scol}, person_id FROM {table}")
        old = f"SELECT cid, COUNT(*) AS n, COUNT(DISTINCT pid) AS p FROM ({' UNION ALL '.join(parts)}) GROUP BY cid"
        t = time.monotonic()
        db_connect.materialize_parquet(config, None, files, known, old, str(work / "old.parquet"))
        print(f"former single COPY: {time.monotonic() - t:.1f}s")


if __name__ == "__main__":
    main()
