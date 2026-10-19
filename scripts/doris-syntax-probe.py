"""Check, against a live Doris, the remote_sql translations no unit test can run.

DuckDB SQL from the app is translated by `app.services.data.remote_sql.to_remote`
(the very translator the pushdown uses), run on Doris through DuckDB's `mysql`
extension and `mysql_query` (the app's own path), and compared with the DuckDB
original run in memory on the same rows. Cases:

- `STRING_AGG(x, sep ORDER BY o)` → `GROUP_CONCAT(x ORDER BY o SEPARATOR sep)`:
  one-char, multi-char and CHR(10)||CHR(10) separators, the default ',', NULL
  values skipped, an all-NULL group;
- `CHR(n)` → `CHAR(n)` without `USING utf8`: 65, 127, 10, and next to text;
- `LOWER()` on accented text ('HÉMORRAGIE', 'É', 'Ç', 'ŒUF'), and the strict
  concept search predicate (`LOWER(col) LIKE '%hémorragie%'`, lowerLikeSql in
  apps/web/src/lib/fuzzy-search.ts).

The rows live in a temporary table `linkr_probe_<random>` created in the given
database and dropped at the end (so the login needs CREATE/INSERT/DROP there;
the app's own read-only login will not do). Nothing else is written. A table,
not literal rows: Doris' FE folds constant expressions itself, so LOWER('É')
would test the FE's Java, not the BE that computes a real column.

Usage (from the repo root):

    DORIS_HOST=127.0.0.1 DORIS_PORT=9030 DORIS_USER=root DORIS_PASSWORD= \\
    DORIS_DATABASE=omop apps/api/.venv/bin/python scripts/doris-syntax-probe.py

    # or with arguments (each overrides its env var); no password → prompted
    apps/api/.venv/bin/python scripts/doris-syntax-probe.py \\
        --host 127.0.0.1 --port 9030 --user root --database omop

    # translate only: prints the DuckDB result and the Doris SQL, no connection
    apps/api/.venv/bin/python scripts/doris-syntax-probe.py --dry-run

Exit code 0 when every case passes, 1 otherwise. Needs DuckDB's `mysql`
extension (installed on first use, or already in ~/.duckdb/extensions).
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
import secrets
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "api"))

import duckdb  # noqa: E402

from app.services.data.remote_sql import NotPortable, RemoteTable, to_remote  # noqa: E402

ALIAS = "doris_probe"
COLUMNS = {"id": "INT", "grp": "INT", "ord": "INT", "txt": "VARCHAR"}
ROWS: list[tuple[int, int, int, str | None]] = [
    (1, 1, 3, "b"), (2, 1, 1, "a"), (3, 1, 2, None), (4, 1, 4, "c"),
    (5, 2, 1, None), (6, 2, 2, None),
    (7, 3, 1, "HÉMORRAGIE"), (8, 3, 2, "É"), (9, 3, 3, "Ç"), (10, 3, 4, "ŒUF"),
    (11, 3, 5, "Hémorragie cérébrale"), (12, 3, 6, "hemorragie"),
]


@dataclass(frozen=True)
class Case:
    name: str
    sql: str  # DuckDB SQL; {t} is the probe table


CASES = [
    Case("GROUP_CONCAT ',' ORDER BY", "SELECT grp, STRING_AGG(txt, ',' ORDER BY ord) AS s FROM {t} GROUP BY grp"),
    Case("GROUP_CONCAT ORDER BY DESC", "SELECT grp, STRING_AGG(txt, ',' ORDER BY ord DESC) AS s FROM {t} GROUP BY grp"),
    Case("GROUP_CONCAT multi-char sep", "SELECT grp, STRING_AGG(txt, ' | ' ORDER BY ord) AS s FROM {t} GROUP BY grp"),
    Case("GROUP_CONCAT CHR(10)||CHR(10) sep",
         "SELECT grp, STRING_AGG(txt, CHR(10) || CHR(10) ORDER BY ord) AS s FROM {t} GROUP BY grp"),
    Case("GROUP_CONCAT default sep", "SELECT grp, STRING_AGG(txt ORDER BY ord) AS s FROM {t} GROUP BY grp"),
    Case("GROUP_CONCAT filtered (CASE)",
         "SELECT grp, STRING_AGG(txt, ';' ORDER BY ord) FILTER (WHERE ord > 1) AS s FROM {t} GROUP BY grp"),
    Case("CHAR(65), CHAR(127), CHAR(10)", "SELECT id, CHR(65) AS a, CHR(127) AS b, CHR(10) AS c FROM {t} WHERE id = 1"),
    Case("CHAR(n) next to text", "SELECT id, CHR(65) || txt || CHR(127) AS s FROM {t} WHERE id IN (1, 7)"),
    Case("LOWER accented", "SELECT id, LOWER(txt) AS l FROM {t} WHERE grp = 3"),
    Case("UPPER accented", "SELECT id, UPPER(txt) AS u FROM {t} WHERE grp = 3"),
    Case("strict search LOWER LIKE",
         "SELECT id FROM {t} WHERE LOWER(txt) LIKE '%hémorragie%'"),
    Case("strict search exact + prefix rank",
         "SELECT id, (CASE WHEN LOWER(txt) LIKE 'œuf' THEN 1 WHEN LOWER(txt) LIKE 'hém%' THEN 2 ELSE 3 END) AS r "
         "FROM {t} WHERE grp = 3"),
]


def translate(sql: str, database: str, table: str) -> str:
    def lookup(schema: str | None, name: str) -> RemoteTable | None:
        if name.lower() == table and (schema or database).lower() == database.lower():
            return RemoteTable(database, table, {c: COLUMNS[c] for c in COLUMNS})
        return None

    return to_remote(sql, "doris", lookup).sql


def local_rows(sql: str, table: str) -> list[tuple]:
    con = duckdb.connect()
    con.execute(f'CREATE TABLE "{table}" (id INT, grp INT, ord INT, txt VARCHAR)')
    con.executemany(f'INSERT INTO "{table}" VALUES (?, ?, ?, ?)', ROWS)
    rows = con.execute(sql).fetchall()
    con.close()
    return sorted(rows, key=repr)


def dsn_value(value: str) -> str:
    # Same escaping as db_connect._dsn_value: one opaque token per value.
    escaped = str(value).replace("\\", "\\\\").replace("'", "\\'")
    return re.sub(r"\s", lambda m: "\\" + m.group(0), escaped)


def sql_literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def connect(args: argparse.Namespace) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    try:
        con.execute("LOAD mysql")
    except duckdb.Error:
        con.execute("INSTALL mysql")
        con.execute("LOAD mysql")
    parts = [f"host={dsn_value(args.host)}", f"port={args.port}", f"database={dsn_value(args.database)}",
             f"user={dsn_value(args.user)}"]
    if args.password:
        parts.append(f"password={dsn_value(args.password)}")
    dsn = " ".join(parts).replace("'", "''")
    # Writable, like the app's Doris ATTACH: Doris rejects READ_ONLY's transaction.
    con.execute(f"ATTACH '{dsn}' AS {ALIAS} (TYPE mysql)")
    return con


def remote_execute(con: duckdb.DuckDBPyConnection, sql: str) -> None:
    con.execute(f"CALL mysql_execute('{ALIAS}', {sql_literal(sql)})")


def remote_rows(con: duckdb.DuckDBPyConnection, sql: str) -> list[tuple]:
    return sorted(con.execute(f"SELECT * FROM mysql_query('{ALIAS}', {sql_literal(sql)})").fetchall(), key=repr)


def doris_literal(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("\\", "\\\\").replace("'", "''") + "'"


def create_table(con: duckdb.DuckDBPyConnection, database: str, table: str) -> None:
    qualified = f"`{database}`.`{table}`"
    remote_execute(con, (
        f"CREATE TABLE {qualified} (id INT, grp INT, ord INT, txt VARCHAR(255)) "
        "DUPLICATE KEY(id) DISTRIBUTED BY HASH(id) BUCKETS 1 PROPERTIES ('replication_num' = '1')"
    ))
    values = ", ".join("(" + ", ".join(doris_literal(v) for v in row) + ")" for row in ROWS)
    remote_execute(con, f"INSERT INTO {qualified} VALUES {values}")


def show(label: str, rows: list[tuple]) -> None:
    print(f"    {label}:")
    for row in rows:
        print(f"      {row!r}")


def main() -> int:
    env = os.environ.get
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--host", default=env("DORIS_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(env("DORIS_PORT", "9030")), help="MySQL protocol port of the FE")
    parser.add_argument("--user", default=env("DORIS_USER", "root"))
    parser.add_argument("--password", default=env("DORIS_PASSWORD"))
    parser.add_argument("--database", default=env("DORIS_DATABASE", "omop"))
    parser.add_argument("--dry-run", action="store_true", help="translate and run DuckDB only, no connection")
    args = parser.parse_args()

    table = f"linkr_probe_{secrets.token_hex(4)}"
    con = None
    if not args.dry_run:
        if args.password is None:
            args.password = getpass.getpass(f"Password for {args.user}@{args.host}:{args.port}: ")
        con = connect(args)
        try:
            print("Doris:", con.execute(f"SELECT * FROM mysql_query('{ALIAS}', 'SELECT @@version_comment AS v')").fetchone()[0])
        except duckdb.Error:
            pass

    failures = 0
    try:
        if con is not None:
            create_table(con, args.database, table)
            stored = remote_rows(con, f"SELECT id, grp, ord, txt FROM `{args.database}`.`{table}`")
            if stored != sorted(ROWS, key=repr):
                print("FAIL  rows read back differ from the rows written (connection charset?):")
                show("written", sorted(ROWS, key=repr))
                show("read", stored)
                return 1
            print(f"Probe table `{args.database}`.`{table}`: {len(ROWS)} rows read back intact.\n")

        for case in CASES:
            duck_sql = case.sql.format(t=table)
            try:
                doris_sql = translate(duck_sql, args.database, table)
            except NotPortable as exc:
                failures += 1
                print(f"FAIL  {case.name}: not portable ({exc})\n    DuckDB SQL: {duck_sql}\n")
                continue
            expected = local_rows(duck_sql, table)
            if con is None:
                print(f"DRY   {case.name}\n    DuckDB SQL: {duck_sql}\n    Doris SQL:  {doris_sql}")
                show("DuckDB", expected)
                print()
                continue
            try:
                got = remote_rows(con, doris_sql)
            except duckdb.Error as exc:
                failures += 1
                print(f"FAIL  {case.name}: Doris error\n    Doris SQL:  {doris_sql}\n    {exc}\n")
                continue
            ok = got == expected
            failures += not ok
            print(f"{'PASS' if ok else 'FAIL'}  {case.name}\n    DuckDB SQL: {duck_sql}\n    Doris SQL:  {doris_sql}")
            show("DuckDB", expected)
            show("Doris", got)
            print()
    finally:
        if con is not None:
            try:
                remote_execute(con, f"DROP TABLE IF EXISTS `{args.database}`.`{table}`")
            except duckdb.Error as exc:
                print(f"WARNING: could not drop `{args.database}`.`{table}`: {exc}")
            con.close()

    if con is None:
        print(f"Dry run: {len(CASES)} cases translated, {failures} not portable.")
    else:
        print(f"{len(CASES) - failures}/{len(CASES)} passed.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
