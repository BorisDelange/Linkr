#!/bin/sh
# Apply pending DB migrations, then hand off to the server (exec so uvicorn is
# PID 1 and receives signals). Runs on every start; Alembic is a no-op when the
# schema is already current.
set -e

# Seed the runtime data volume's DuckDB extension dir from the image-baked
# bundle, so first use (native .xlsx read, external DB connectors) works fully
# offline. db_connect sets extension_directory to $LINKR_DATA_DIR/_duckdb_ext.
if [ -n "$LINKR_DUCKDB_EXT_BUNDLE" ] && [ -d "$LINKR_DUCKDB_EXT_BUNDLE" ]; then
  ext_dir="${LINKR_DATA_DIR:-$HOME/.linkr}/_duckdb_ext"
  mkdir -p "$ext_dir"
  cp -rn "$LINKR_DUCKDB_EXT_BUNDLE"/. "$ext_dir"/ 2>/dev/null || true
fi

alembic upgrade head

exec uvicorn app.main:app --host 0.0.0.0 --port 8000
