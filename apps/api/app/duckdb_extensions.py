"""Install the DuckDB extensions Linkr loads, ahead of time.

Linkr installs an extension on first use (the external-database connectors, .xlsx
reads), which downloads it from extensions.duckdb.org. A server with no internet
access fails there, so an offline install runs this once beforehand:

    python -m app.duckdb_extensions                      # into data_dir/_duckdb_ext
    python -m app.duckdb_extensions --repository URL     # from a mirror of extensions.duckdb.org
    python -m app.duckdb_extensions --dir PATH           # elsewhere (the Docker image bakes them)

From the repo root, `npm run duckdb:extensions -- [options]` runs it in apps/api's venv.
"""

import argparse
import sys

import duckdb

# excel: native .xlsx reads; postgres / mysql (also Doris) / sqlite: database connectors.
EXTENSIONS = ("excel", "postgres", "mysql", "sqlite")


def _literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def install(directory: str, repository: str | None = None) -> None:
    con = duckdb.connect()
    con.execute(f"SET extension_directory = {_literal(directory)}")
    source = f" FROM {_literal(repository)}" if repository else ""
    for ext in EXTENSIONS:
        con.execute(f"INSTALL {ext}{source}")
        con.execute(f"LOAD {ext}")
        print(f"  {ext}: ok", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dir", help="extension directory (default: <LINKR_DATA_DIR>/_duckdb_ext)")
    parser.add_argument("--repository", help="extension repository URL or local path (default: extensions.duckdb.org)")
    args = parser.parse_args()
    if args.dir:
        directory = args.dir
    else:
        # Imported here so the image build, which passes --dir, needs no configured settings.
        from app.services.data.db_connect import _ext_dir
        directory = _ext_dir()
    print(f"DuckDB {duckdb.__version__} extensions → {directory}", flush=True)
    try:
        install(directory, args.repository)
    except duckdb.Error as e:
        print(f"\nFailed: {e}\n\nWithout internet access, pass --repository with a mirror of "
              "extensions.duckdb.org, or copy this folder from a machine with the same DuckDB "
              "version and platform that ran this command.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
