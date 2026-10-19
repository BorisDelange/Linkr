#!/usr/bin/env bash
# Entry point of the SPE simulation's `matrix-runner` (docker/spe-sim/docker-compose.yml):
# loads /data into the engines of MATRIX_ENGINES, then runs the matrix with the API
# image's own code. /work holds the corpus in, the loaded files and the report out.
set -euo pipefail

export LINKR_DATA_DIR=/tmp/linkr-matrix
mkdir -p "$LINKR_DATA_DIR/_duckdb_ext"
# The image bundles the DuckDB extensions: the SPE has no internet to fetch them.
cp -rn "$LINKR_DUCKDB_EXT_BUNDLE"/. "$LINKR_DATA_DIR/_duckdb_ext"/ 2>/dev/null || true
export MATRIX_DUCKDB_EXT_DIR="$LINKR_DATA_DIR/_duckdb_ext"

# Same pytest as apps/api/uv.lock.
pip install --quiet --disable-pip-version-check pytest==9.1.1 >/dev/null

wait_for() {  # host port label
  for _ in $(seq 1 90); do
    if python3 -c "import socket,sys; socket.create_connection(('$1', $2), 2)" 2>/dev/null; then return 0; fi
    sleep 2
  done
  echo "  $3 did not answer on $1:$2" >&2
  return 1
}

if [ "${MATRIX_LOAD:-1}" = "1" ]; then
  IFS=',' read -ra wanted <<<"$MATRIX_ENGINES"
  for engine in "${wanted[@]}"; do
    case "$engine" in
      duckdb|sqlite) python3 /matrix/matrix.py load /data "$engine" --target "/work/omop.$engine" ;;
      postgresql) { wait_for "${MATRIX_POSTGRESQL_HOST:-datamart-postgres}" 5432 PostgreSQL || exit 1; }; python3 /matrix/matrix.py load /data postgresql ;;
      mysql) { wait_for "${MATRIX_MYSQL_HOST:-datamart-mysql}" 3306 MySQL || exit 1; }; python3 /matrix/matrix.py load /data mysql ;;
    esac
  done
fi

# DuckDB spills a query too big for memory into ./.tmp: run from a writable
# directory, as the image's entrypoint makes /app/.tmp point at the data volume.
cd "$LINKR_DATA_DIR"
exec python3 -m pytest -q -p no:cacheprovider --rootdir=/matrix /matrix/test_matrix.py "$@"
