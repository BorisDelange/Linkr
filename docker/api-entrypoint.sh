#!/bin/sh
# Apply pending DB migrations, then hand off to the server (exec so uvicorn is
# PID 1 and receives signals). Runs on every start; Alembic is a no-op when the
# schema is already current.
set -e

alembic upgrade head

exec uvicorn app.main:app --host 0.0.0.0 --port 8000
