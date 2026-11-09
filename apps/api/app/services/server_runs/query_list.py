"""A list of independent queries (`query_list` kinds): each run in turn on one
database, its rows kept in a file of the run (`results/<key>.json`), the
checkpoint written as each lands — a resume goes on at the first one not done.
The page compiled them and assembles what they return; the run only makes sure
they all run, page open or not.
"""

import asyncio
import re

from app.schemas.query_list import QueryListSpec
from app.services.server_runs.executor import (
    QueryingExecutor,
    read_json,
    run_dir,
    short,
    took,
    write_json,
)
from app.services.server_runs.worker import (
    QueryFailed,
    QueryStalled,
    QueryTimedOut,
    WorkerDied,
)

# A hung or cut query gets one more try before it counts as failed.
TRIES = 2
# A result's key, as the spec allows it (schemas/query_list.py): never a path.
KEY = re.compile(r"[A-Za-z0-9_.-]{1,80}")


def result_path(run_id: str, key: str):
    return run_dir(run_id) / "results" / f"{key}.json"


def read_result(run_id: str, key: str) -> list[dict] | None:
    path = result_path(run_id, key)
    return read_json(path) if path.exists() else None


class QueryListExecutor(QueryingExecutor):
    spec: QueryListSpec

    def percent(self) -> int:
        total = len(self.spec.items) or 1
        return int(100 * self.state.get("next", 0) / total)

    def start_note(self) -> str:
        n = self.state.get("next", 0)
        if self.attempt > 1 and n > 0:
            return f"Resumed at query {n + 1} of {len(self.spec.items)}"
        return super().start_note()

    def ended(self, status: str) -> None:
        # A finished run's results are what the page reads: kept until the run is pruned.
        if status == "cancelled":
            super().ended(status)

    async def body(self) -> None:
        st = self.state
        items = self.spec.items
        st["total"] = len(items)
        while st.get("next", 0) < len(items):
            i = st.get("next", 0)
            await self.boundary()
            item = items[i]
            what = item.what or item.key
            st["current"] = {"key": item.key, "what": what}
            await self.save()
            started = asyncio.get_running_loop().time()
            try:
                rows = await self._run(item.sql, what, item.pushdown)
            except (QueryFailed, QueryTimedOut, QueryStalled, WorkerDied) as e:
                if not self.spec.keep_going:
                    raise
                st.setdefault("errors", {})[item.key] = short(e)
                await self.note(f"{what}: failed — {short(e)}")
            else:
                write_json(result_path(self.run_id, item.key), rows)
                st.setdefault("rows", {})[item.key] = len(rows)
                await self.note(f"{what}: {len(rows):,} rows, {took(started)}")
            st["next"] = i + 1
            st.pop("current", None)
            await self.save()

    async def _run(self, sql: str, what: str, pushdown: bool = True) -> list[dict]:
        for attempt in range(TRIES):
            try:
                return await self.query(sql, what, pushdown=pushdown)
            except (QueryStalled, WorkerDied) as e:
                if attempt == TRIES - 1:
                    raise
                await self.note(f"{what}: {short(e)}, tried again")
        raise AssertionError("unreachable")
