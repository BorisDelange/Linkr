"""A data catalog's disclosure audit (`catalog_audit` runs): CPU only, computed in
a process of the run's own (`compute.child_main`) so that the API's event loop
keeps serving while it works, and a stop ends it at once.

The checkpoint — the next system, the unknowns and findings so far — is a file
of the run, written as the process reports it; a resume starts a process there.
The audit, stamped as `auditCatalog` stamps its own, is the run's result
(`results/audit.json`), which the page reads and keeps with the results it audited.
"""

import asyncio
import contextlib
import multiprocessing
import threading
from multiprocessing.connection import Connection
from multiprocessing.process import BaseProcess

from app.schemas.catalog_audit_run import CatalogAuditRunSpec
from app.services.server_runs import query_list
from app.services.server_runs.catalog_audit import compute
from app.services.server_runs.executor import (
    RunExecutor,
    now_iso,
    read_json,
    run_dir,
    write_json,
)
from app.services.server_runs.worker import _exited, _to_the_end

# A checkpoint after this many systems, or this many seconds, whichever first.
CHECKPOINT_EVERY = 500
CHECKPOINT_S = 1.0
# Seconds the process sleeps per system: a test's way to stop it midway.
PACE_S = 0.0
TERM_GRACE_S = 5.0
RESULT = "audit"

_EOF = ("eof",)


def checkpoint_path(run_id: str):
    return run_dir(run_id) / "checkpoint.json"


class CatalogAuditExecutor(RunExecutor):
    spec: CatalogAuditRunSpec

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.process: BaseProcess | None = None

    def percent(self) -> int:
        total = self.state.get("total") or 0
        return int(100 * self.state.get("next", 0) / total) if total else 0

    def start_note(self) -> str:
        n = self.state.get("next", 0)
        if self.attempt > 1 and n > 0:
            return f"Resumed at system {n + 1:,} of {self.state.get('total', 0):,}"
        return super().start_note()

    def ended(self, status: str) -> None:
        # A finished run's audit is what the page reads: kept until the run is pruned.
        if status == "done":
            checkpoint_path(self.run_id).unlink(missing_ok=True)
        elif status == "cancelled":
            super().ended(status)

    async def body(self) -> None:
        st = self.state
        path = checkpoint_path(self.run_id)
        checkpoint = read_json(path) if path.exists() else None
        st["next"] = checkpoint["next"] if checkpoint else 0
        messages: asyncio.Queue = asyncio.Queue()
        ctx = multiprocessing.get_context("spawn")
        receive, send = ctx.Pipe(duplex=False)
        self.process = ctx.Process(
            target=compute.child_main,
            args=(self.spec.input.model_dump(by_alias=True), checkpoint, CHECKPOINT_EVERY, CHECKPOINT_S, PACE_S, send),
            name="linkr-catalog-audit", daemon=True,
        )
        threading.Thread(
            target=_read, args=(receive, asyncio.get_running_loop(), messages), name="catalog-audit-replies", daemon=True,
        ).start()
        try:
            await _to_the_end(asyncio.to_thread(self.process.start))
        finally:
            # Else the process's end would never read as EOF here.
            send.close()
        while True:
            msg = await messages.get()
            if msg is _EOF:
                raise RuntimeError(f"the audit process ended (exit code {self.process.exitcode})")
            if msg[0] == "error":
                raise RuntimeError(msg[1])
            if msg[0] == "total":
                st["total"] = msg[1]
                await self.save()
            elif msg[0] == "checkpoint":
                write_json(path, msg[1])
                st["next"] = msg[1]["next"]
                await self.save()
            elif msg[0] == "done":
                _, mark, result = msg
                audit = {
                    **self.spec.meta.model_dump(by_alias=True), "computedAt": now_iso(), "durationMs": mark["elapsedMs"], **result,
                }
                write_json(query_list.result_path(self.run_id, RESULT), audit)
                st["next"] = mark["next"]
                st["computedAt"] = audit["computedAt"]
                await self.note(
                    f"{result['components']:,} systems, {result['unknowns']:,} unknowns, {len(result['findings'])} findings"
                )
                return

    async def teardown(self) -> None:
        process = self.process
        if process is None or process.pid is None:
            return
        if process.exitcode is None:
            process.terminate()
            if not await _exited(process, TERM_GRACE_S):
                process.kill()
                await _exited(process, TERM_GRACE_S)


def _read(conn: Connection, loop: asyncio.AbstractEventLoop, messages: asyncio.Queue) -> None:
    """Hand the process's messages to the event loop; EOF is how its end shows."""
    while True:
        try:
            msg = conn.recv()
        except Exception:  # noqa: BLE001 — EOF, or a message that cannot be read: the process is done with
            msg = _EOF
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(messages.put_nowait, msg)
        if msg is _EOF:
            break
    conn.close()
