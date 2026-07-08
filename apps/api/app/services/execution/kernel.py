"""Persistent execution kernels — long-lived R/Python processes whose variable
namespace survives across runs (see docs/planning/fullstack-storage-plan.md §07).

Unlike the stateless runner (runtime.py), a kernel is a subprocess that stays
alive: the parent sends one code request at a time over stdin and reads its
output over stdout, while the child keeps its globals between requests — so
``a = 4`` in one run is still defined in the next. This mirrors the browser's
singleton Pyodide/WebR engines, but scoped per (project, language, env) and
managed server-side.

Streaming is the single execution path: ``execute_stream`` reads the kernel's
output line by line, invoking a callback for each ``__linkr_stream__`` chunk and
servicing ``__linkr_rpc__`` requests, until the final ``__linkr_done__`` line.
The one-shot ``execute`` used by analyses/widgets is a thin wrapper that
accumulates those chunks into a single RuntimeOutput.

Lifetime: started lazily on first execution, kept in memory, evicted on restart
or when the process dies. In-memory only — variables are lost on server restart
(no snapshot; serialising arbitrary R/Python objects is fragile).
"""

import asyncio
import base64
import json
import signal

from typing import Awaitable, Callable

from app.config import settings
from app.services.execution.runtime import RuntimeOutput, ExecutionError

# Callback invoked with (kind, data) for each incremental output chunk, where
# kind is "stdout" or "stderr". May be sync or async.
ChunkHandler = Callable[[str, str], Awaitable[None] | None]

# The kernel loop reads one request per stdin line: a one-char mode prefix
# ("S" = stream, anything else = batch) followed by base64 code. In stream mode
# stdout/stderr are flushed to the host as {"__linkr_stream__": ...} lines as
# they are produced, then a final {"__linkr_done__": true, ...} carries figures
# and the result table. Batch mode buffers everything and emits one result line
# (the legacy contract, used by analyses/widgets). Capture mirrors the stateless
# harness (matplotlib SVG figures, a `result`/last DataFrame as a table).
_PY_KERNEL_LOOP = r'''
import sys, io, json, base64, traceback

_real_out, _real_err = sys.stdout, sys.stderr


def _emit(obj):
    _real_out.write(json.dumps(obj) + "\n")
    _real_out.flush()


class _StreamWriter(io.TextIOBase):
    """A stdout/stderr replacement that emits each write to the host as a
    __linkr_stream__ line, so a REPL sees output as it is produced."""

    def __init__(self, kind):
        self._kind = kind

    def write(self, s):
        if s:
            _emit({"__linkr_stream__": self._kind, "data": s})
        return len(s)

    def flush(self):
        pass


def _linkr_sql_query(sql):
    """Ask the host to run SQL against the active connection; return rows (list of
    dicts). The host holds the connection config — the kernel never sees it."""
    _emit({"__linkr_rpc__": "query", "sql": sql})
    line = sys.stdin.readline()
    resp = json.loads(line)
    if resp.get("error"):
        raise RuntimeError(resp["error"])
    return resp.get("rows", [])


def sql_query(sql):
    """Query the active database connection and return a pandas DataFrame."""
    import pandas as pd
    rows = _linkr_sql_query(sql)
    return pd.DataFrame(rows) if rows else pd.DataFrame()


_ns = {"__name__": "__main__", "sql_query": sql_query}
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except Exception:
    plt = None


def _capture_table(obj):
    try:
        import pandas as pd
    except Exception:
        return None
    if isinstance(obj, pd.DataFrame):
        return {"headers": [str(c) for c in obj.columns],
                "rows": obj.head(1000).astype(str).values.tolist()}
    return None


def _run(code, stream):
    """Execute `code` in the persistent namespace. When `stream`, stdout/stderr
    are pushed to the host live and the returned strings are empty; otherwise
    they are buffered and returned in the done payload."""
    figures, table = [], None
    if stream:
        out = err = None
        sys.stdout, sys.stderr = _StreamWriter("stdout"), _StreamWriter("stderr")
    else:
        out, err = io.StringIO(), io.StringIO()
        sys.stdout, sys.stderr = out, err
    # Drop any `result` left by a previous run so we only surface a table when
    # THIS run defines one (the namespace persists between runs).
    _ns.pop("result", None)
    try:
        exec(compile(code, "<analysis>", "exec"), _ns)
        table = _capture_table(_ns.get("result"))
        if plt is not None:
            for num in plt.get_fignums():
                buf = io.BytesIO()
                plt.figure(num).savefig(buf, format="svg", bbox_inches="tight")
                figures.append({"type": "svg",
                                "data": buf.getvalue().decode("utf-8"),
                                "label": "Figure " + str(num)})
            plt.close("all")
    except KeyboardInterrupt:
        # Host sent SIGINT (Ctrl+C) — report it on the current stream and keep
        # the kernel alive for the next request.
        (sys.stderr if stream else err).write("KeyboardInterrupt\n")
    except Exception:
        traceback.print_exc()
    finally:
        sys.stdout, sys.stderr = _real_out, _real_err
    return {"stdout": "" if stream else out.getvalue(),
            "stderr": "" if stream else err.getvalue(),
            "figures": figures, "table": table, "html": None,
            "__linkr_done__": True}


# Explicit readline (not `for line in sys.stdin`) so sql_query can do its own
# readline() for RPC responses without fighting the iterator's read-ahead buffer.
while True:
    line = sys.stdin.readline()
    if not line:
        break
    line = line.strip()
    if not line:
        continue
    stream = line[:1] == "S"
    payload = line[1:]
    try:
        code = base64.b64decode(payload).decode("utf-8")
        result = _run(code, stream)
    except Exception as e:
        result = {"stdout": "", "stderr": "kernel error: " + str(e),
                  "figures": [], "table": None, "html": None,
                  "__linkr_done__": True}
    _emit(result)
'''


# The R kernel loop: same wire protocol as Python (one "[SB]"+base64 request per
# stdin line). In stream mode, stdout/stderr flush per output line as
# __linkr_stream__ records; in batch mode capture.output buffers a single blob.
# eval() runs in globalenv() so variables persist; an svglite device per run
# yields SVG figures. R interrupts (SIGINT) surface as a caught condition, so the
# kernel survives Ctrl+C.
_R_KERNEL_LOOP = r'''
suppressMessages({
  .has_svglite <- requireNamespace("svglite", quietly = TRUE)
  library(jsonlite); library(base64enc)
})
.con <- file("stdin", "r")
.run_n <- 0
.emit <- function(obj) {
  cat(toJSON(obj, auto_unbox = TRUE, null = "null"), "\n", sep = "")
  flush(stdout())
}
.stream_lines <- function(kind, text) {
  if (length(text) == 0) return(invisible())
  for (.l in text) .emit(list("__linkr_stream__" = kind, data = paste0(.l, "\n")))
}
repeat {
  .line <- readLines(.con, n = 1, warn = FALSE)
  if (length(.line) == 0) break
  .line <- trimws(.line)
  if (nchar(.line) == 0) next
  .stream <- substr(.line, 1, 1) == "S"
  .code <- rawToChar(base64decode(substr(.line, 2, nchar(.line))))
  .run_n <- .run_n + 1
  .pat <- sprintf("_linkr_p_%03d_%%03d.svg", .run_n)
  if (.has_svglite) svglite::svglite(filename = .pat, width = 8, height = 6)
  .err <- character(0)
  .out <- tryCatch(
    withCallingHandlers(
      utils::capture.output(eval(parse(text = .code), envir = globalenv())),
      warning = function(w) { .err <<- c(.err, conditionMessage(w)); invokeRestart("muffleWarning") },
      message = function(m) { .err <<- c(.err, conditionMessage(m)); invokeRestart("muffleMessage") }
    ),
    interrupt = function(i) { .err <<- c(.err, "interrupt"); character(0) },
    error = function(e) { .err <<- c(.err, conditionMessage(e)); character(0) }
  )
  if (.has_svglite) invisible(grDevices::dev.off())
  if (.stream) {
    .stream_lines("stdout", .out)
    .stream_lines("stderr", .err)
  }
  .figs <- list()
  for (.f in list.files(".", pattern = sprintf("^_linkr_p_%03d_.*svg$", .run_n))) {
    .svg <- paste(readLines(.f, warn = FALSE), collapse = "\n")
    if (grepl("<svg", .svg, fixed = TRUE))
      .figs[[length(.figs) + 1]] <- list(type = "svg", data = .svg, label = paste("Plot", length(.figs) + 1))
    file.remove(.f)
  }
  .emit(list(stdout = if (.stream) "" else paste(.out, collapse = "\n"),
             stderr = if (.stream) "" else paste(.err, collapse = "\n"),
             figures = .figs, table = NULL, html = NULL,
             "__linkr_done__" = TRUE))
}
'''


async def _resolve_query(query_resolver, sql: str) -> dict:
    """Run a kernel SQL RPC via the resolver; return {rows} or {error}."""
    if query_resolver is None:
        return {"error": "No active database connection for sql_query()."}
    try:
        return {"rows": await query_resolver(sql)}
    except Exception as e:  # noqa: BLE001 — surface any query failure to the kernel
        return {"error": str(e)}


class Kernel:
    """One persistent interpreter process. Serialises requests (one at a time)."""

    def __init__(self, cmd: list[str], cwd: str | None = None, owns_cwd: bool = False):
        self._cmd = cmd
        self._cwd = cwd
        # Only remove cwd on shutdown when we created it (a throwaway temp dir).
        # A per-project working dir is persistent and must never be deleted here.
        self._owns_cwd = owns_cwd
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self.busy = False

    async def _ensure_started(self) -> asyncio.subprocess.Process:
        if self._proc is not None and self._proc.returncode is None:
            return self._proc
        # One result line carries the whole JSON output (stdout + base64 figures +
        # table), which easily exceeds asyncio's default 64 KB StreamReader limit
        # and would raise LimitOverrunError on readline(). Raise it to 64 MB.
        self._proc = await asyncio.create_subprocess_exec(
            *self._cmd,
            cwd=self._cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=64 * 1024 * 1024,
        )
        return self._proc

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    def interrupt(self) -> bool:
        """Send SIGINT to the running kernel (Ctrl+C). Returns False if no live
        process. The kernel catches the interrupt and stays alive for the next
        request; a hung C-extension that ignores SIGINT still hits the timeout."""
        if self._proc is None or self._proc.returncode is not None:
            return False
        try:
            self._proc.send_signal(signal.SIGINT)
            return True
        except ProcessLookupError:
            return False

    async def execute(self, code: str, query_resolver=None) -> RuntimeOutput:
        """One-shot run: accumulate the streamed output into a single
        RuntimeOutput (the legacy contract used by analyses/widgets)."""
        chunks: dict[str, list[str]] = {"stdout": [], "stderr": []}

        def collect(kind: str, data: str) -> None:
            chunks.setdefault(kind, []).append(data)

        out = await self.execute_stream(code, collect, query_resolver=query_resolver)
        # Stream chunks carry the incremental output; the done payload's stdout/
        # stderr are empty in stream mode, so prepend the accumulated chunks.
        return RuntimeOutput(
            stdout="".join(chunks["stdout"]) + out.stdout,
            stderr="".join(chunks["stderr"]) + out.stderr,
            figures=out.figures,
            table=out.table,
            html=out.html,
        )

    async def execute_stream(
        self, code: str, on_chunk: ChunkHandler, query_resolver=None
    ) -> RuntimeOutput:
        """Run code, invoking `on_chunk(kind, data)` for each incremental output
        chunk, and return the final RuntimeOutput (figures/table; stdout/stderr
        empty since they were streamed). SQL RPCs from sql_query are serviced by
        `query_resolver(sql)` mid-run. One execution at a time per kernel."""
        async with self._lock:
            self.busy = True
            try:
                # A dead subprocess (crashed on a prior run) leaves a broken stdin
                # pipe; restart once so a single failure doesn't poison every future
                # run (which surfaced as a persistent 500).
                try:
                    done = await self._run_once(code, on_chunk, query_resolver)
                except (BrokenPipeError, ConnectionResetError):
                    await self.shutdown()
                    done = await self._run_once(code, on_chunk, query_resolver)
            except asyncio.TimeoutError as e:
                # A hung run poisons the namespace — kill so the next call restarts clean.
                await self.shutdown()
                raise ExecutionError(
                    f"Execution exceeded the {settings.execution_timeout_seconds}s time limit."
                ) from e
            finally:
                self.busy = False

        if done is None:
            await self.shutdown()
            raise ExecutionError("Kernel exited unexpectedly.")
        return RuntimeOutput(
            stdout=done.get("stdout", ""),
            stderr=done.get("stderr", ""),
            figures=done.get("figures", []),
            table=done.get("table"),
            html=done.get("html"),
        )

    async def _run_once(self, code: str, on_chunk, query_resolver) -> dict | None:
        """Send `code` to the (started) kernel in stream mode and read until the
        done payload. Raises BrokenPipeError/ConnectionResetError on a dead pipe."""
        proc = await self._ensure_started()
        assert proc.stdin is not None and proc.stdout is not None
        proc.stdin.write(b"S" + base64.b64encode(code.encode("utf-8")) + b"\n")
        await proc.stdin.drain()
        return await self._read_stream(proc, on_chunk, query_resolver)

    async def _read_stream(self, proc, on_chunk, query_resolver) -> dict | None:
        """Read stdout line by line: forward __linkr_stream__ chunks to on_chunk,
        service __linkr_rpc__ SQL requests, return the __linkr_done__ payload (or
        None on EOF). Each read is bounded by the execution timeout."""
        while True:
            line = await asyncio.wait_for(
                proc.stdout.readline(), timeout=settings.execution_timeout_seconds
            )
            if not line:
                return None
            try:
                msg = json.loads(line.decode("utf-8"))
            except ValueError:
                continue  # not JSON — ignore stray output
            if msg.get("__linkr_rpc__") == "query":
                resp = await _resolve_query(query_resolver, msg.get("sql", ""))
                proc.stdin.write((json.dumps(resp) + "\n").encode("utf-8"))
                await proc.stdin.drain()
                continue
            stream_kind = msg.get("__linkr_stream__")
            if stream_kind is not None:
                res = on_chunk(stream_kind, msg.get("data", ""))
                if asyncio.iscoroutine(res):
                    await res
                continue
            if msg.get("__linkr_done__"):
                return msg
            # An unmarked JSON line (legacy) is treated as the final payload.
            return msg

    async def shutdown(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            self._proc.kill()
            await self._proc.wait()
        self._proc = None
        if self._cwd and self._owns_cwd:
            import shutil

            shutil.rmtree(self._cwd, ignore_errors=True)


class KernelManager:
    """Holds live kernels keyed by (project_uid, language, env_id)."""

    def __init__(self):
        self._kernels: dict[tuple[str, str, str], Kernel] = {}
        self._lock = asyncio.Lock()

    async def get(self, project_uid: str, language: str, env_id: str) -> Kernel:
        key = (project_uid, language, env_id)
        async with self._lock:
            kernel = self._kernels.get(key)
            if kernel is None:
                kernel = self._make(language, project_uid)
                self._kernels[key] = kernel
            return kernel

    async def restart(self, project_uid: str, language: str, env_id: str) -> None:
        key = (project_uid, language, env_id)
        async with self._lock:
            kernel = self._kernels.pop(key, None)
        if kernel is not None:
            await kernel.shutdown()

    async def shutdown_all(self) -> None:
        async with self._lock:
            kernels = list(self._kernels.values())
            self._kernels.clear()
        for k in kernels:
            await k.shutdown()

    def list_for_project(self, project_uid: str) -> list[dict]:
        """Live kernels for a project: their language, env, and running/busy state."""
        return [
            {
                "language": lang,
                "envId": env,
                "alive": kernel.alive,
                "busy": kernel.busy,
            }
            for (proj, lang, env), kernel in self._kernels.items()
            if proj == project_uid
        ]

    def _make(self, language: str, project_uid: str) -> Kernel:
        # The kernel runs in the project's real working directory (RStudio/Jupyter
        # model): scripts/ and datasets/ are reachable by readable relative paths.
        from app.services import project_fs

        cwd = str(project_fs.project_dir(project_uid))
        if language == "python":
            import sys

            return Kernel([sys.executable, "-c", _PY_KERNEL_LOOP], cwd=cwd)
        if language == "r":
            return Kernel(["Rscript", "--vanilla", "-e", _R_KERNEL_LOOP], cwd=cwd)
        raise ExecutionError(f"No persistent kernel for language: {language}")


manager = KernelManager()
