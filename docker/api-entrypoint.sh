#!/bin/sh
# Apply pending DB migrations, then hand off to the server (exec so uvicorn is
# PID 1 and receives signals). Runs on every start; Alembic is a no-op when the
# schema is already current.
set -e

# Started as root: hand the data dir to the unprivileged user, then re-exec this
# script as that user. Never serve as root — a kernel is code its user wrote.
if [ "$(id -u)" = "0" ]; then
  data_dir="${LINKR_DATA_DIR:-/var/lib/linkr}"
  mkdir -p "$data_dir"
  # Only when needed: a recursive chown of a large volume on every start is slow.
  [ "$(stat -c %U "$data_dir")" = linkr ] || chown -R linkr:linkr "$data_dir"
  exec setpriv --reuid=linkr --regid=linkr --init-groups env HOME=/home/linkr "$0" "$@"
fi

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
