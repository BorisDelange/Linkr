"""What a server-owned list of queries is given (services/server_runs/query_list.py),
compiled by the page (apps/web lib/server-runs/query-plan.ts)."""

from pydantic import Field

from app.schemas.base import CamelModel


class QueryItem(CamelModel):
    # Names its result file: `GET /server-runs/{run}/results/{key}`.
    key: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,80}$")
    sql: str
    # What it computes, for the job's input and log.
    what: str = ""
    # An external database may compute it (db_connect.query_external).
    pushdown: bool = True


class QueryListSpec(CamelModel):
    label: str = Field(min_length=1, max_length=255)
    items: list[QueryItem] = Field(min_length=1)
    # An item that fails is recorded (`state.errors`) and the run goes on; without
    # it the first failure fails the run.
    keep_going: bool = False
    # The page's own, carried into the run's state: what the results are for
    # (a fingerprint, a definition), so it applies them only where they belong.
    meta: dict = {}
