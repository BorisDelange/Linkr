"""Persistent execution kernels — long-lived R/Python processes whose variable
namespace survives across runs (see docs/planning/fullstack-storage-plan.html §07).

Unlike the stateless runner (runtime.py), a kernel is a subprocess that stays
alive: the parent sends one code request at a time over stdin and reads one JSON
result over stdout, while the child keeps its globals between requests — so
``a = 4`` in one run is still defined in the next. This mirrors the browser's
singleton Pyodide/WebR engines, but scoped per (project, language, env) and
managed server-side.

Lifetime: started lazily on first execution, kept in memory, evicted on restart
or when the process dies. In-memory only — variables are lost on server restart
(no snapshot; serialising arbitrary R/Python objects is fragile).
"""

import asyncio
import base64
import json

from app.config import settings
from app.services.execution.runtime import RuntimeOutput, ExecutionError

# The kernel loop: read one base64 code request per stdin line, exec it in a
# persistent namespace, emit one JSON result line. Capture mirrors the stateless
# harness (matplotlib SVG figures, a `result`/last DataFrame as a table).
_PY_KERNEL_LOOP = r'''
import sys, io, json, base64, traceback


def _linkr_sql_query(sql):
    """Ask the host to run SQL against the active connection; return rows (list of
    dicts). The host holds the connection config — the kernel never sees it."""
    sys.__stdout__.write(json.dumps({"__linkr_rpc__": "query", "sql": sql}) + "\n")
    sys.__stdout__.flush()
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


def _run(code):
    out, err, figures, table = io.StringIO(), io.StringIO(), [], None
    real_out, real_err = sys.stdout, sys.stderr
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
    except Exception:
        traceback.print_exc()
    finally:
        sys.stdout, sys.stderr = real_out, real_err
    return {"stdout": out.getvalue(), "stderr": err.getvalue(),
            "figures": figures, "table": table, "html": None}


# Explicit readline (not `for line in sys.stdin`) so sql_query can do its own
# readline() for RPC responses without fighting the iterator's read-ahead buffer.
while True:
    line = sys.stdin.readline()
    if not line:
        break
    line = line.strip()
    if not line:
        continue
    try:
        code = base64.b64decode(line).decode("utf-8")
        result = _run(code)
    except Exception as e:
        result = {"stdout": "", "stderr": "kernel error: " + str(e),
                  "figures": [], "table": None, "html": None}
    sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()
'''


# The R kernel loop: same wire protocol as Python (one base64 code request per
# stdin line -> one JSON result line). eval() runs in globalenv() so variables
# persist; capture.output collects stdout, handlers route warnings/messages/errors
# to stderr, and an svglite device per run yields SVG figures.
_R_KERNEL_LOOP = r'''
suppressMessages({
  .has_svglite <- requireNamespace("svglite", quietly = TRUE)
  library(jsonlite); library(base64enc)
})
.con <- file("stdin", "r")
.run_n <- 0
repeat {
  .line <- readLines(.con, n = 1, warn = FALSE)
  if (length(.line) == 0) break
  .line <- trimws(.line)
  if (nchar(.line) == 0) next
  .run_n <- .run_n + 1
  .code <- rawToChar(base64decode(.line))
  .pat <- sprintf("_linkr_p_%03d_%%03d.svg", .run_n)
  if (.has_svglite) svglite::svglite(filename = .pat, width = 8, height = 6)
  .err <- character(0)
  .out <- tryCatch(
    withCallingHandlers(
      utils::capture.output(eval(parse(text = .code), envir = globalenv())),
      warning = function(w) { .err <<- c(.err, conditionMessage(w)); invokeRestart("muffleWarning") },
      message = function(m) { .err <<- c(.err, conditionMessage(m)); invokeRestart("muffleMessage") }
    ),
    error = function(e) { .err <<- c(.err, conditionMessage(e)); character(0) }
  )
  if (.has_svglite) invisible(grDevices::dev.off())
  .figs <- list()
  for (.f in list.files(".", pattern = sprintf("^_linkr_p_%03d_.*svg$", .run_n))) {
    .svg <- paste(readLines(.f, warn = FALSE), collapse = "\n")
    if (grepl("<svg", .svg, fixed = TRUE))
      .figs[[length(.figs) + 1]] <- list(type = "svg", data = .svg, label = paste("Plot", length(.figs) + 1))
    file.remove(.f)
  }
  .result <- list(stdout = paste(.out, collapse = "\n"),
                  stderr = paste(.err, collapse = "\n"),
                  figures = .figs, table = NULL, html = NULL)
  cat(toJSON(.result, auto_unbox = TRUE, null = "null"), "\n", sep = "")
  flush(stdout())
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

    def __init__(self, cmd: list[str], cwd: str | None = None):
        self._cmd = cmd
        self._cwd = cwd
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self.busy = False

    async def _ensure_started(self) -> asyncio.subprocess.Process:
        if self._proc is not None and self._proc.returncode is None:
            return self._proc
        self._proc = await asyncio.create_subprocess_exec(
            *self._cmd,
            cwd=self._cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        return self._proc

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def execute(self, code: str, query_resolver=None) -> RuntimeOutput:
        """Run code and return its output. While running, the kernel may emit SQL
        RPC requests (from sql_query); each is fulfilled by `query_resolver(sql)`
        (an async callable returning rows) and the result is fed back over stdin."""
        async with self._lock:
            proc = await self._ensure_started()
            assert proc.stdin is not None and proc.stdout is not None
            self.busy = True
            try:
                proc.stdin.write(base64.b64encode(code.encode("utf-8")) + b"\n")
                await proc.stdin.drain()
                line = await self._read_result(proc, query_resolver)
            except asyncio.TimeoutError as e:
                # A hung run poisons the namespace — kill so the next call restarts clean.
                await self.shutdown()
                raise ExecutionError(
                    f"Execution exceeded the {settings.execution_timeout_seconds}s time limit."
                ) from e
            finally:
                self.busy = False

            if not line:
                await self.shutdown()
                raise ExecutionError("Kernel exited unexpectedly.")
            data = json.loads(line.decode("utf-8"))
            return RuntimeOutput(
                stdout=data.get("stdout", ""),
                stderr=data.get("stderr", ""),
                figures=data.get("figures", []),
                table=data.get("table"),
                html=data.get("html"),
            )

    async def _read_result(self, proc, query_resolver) -> bytes:
        """Read stdout until the final result line, servicing SQL RPC requests
        emitted mid-run. Each read is bounded by the execution timeout."""
        while True:
            line = await asyncio.wait_for(
                proc.stdout.readline(), timeout=settings.execution_timeout_seconds
            )
            if not line:
                return line
            try:
                msg = json.loads(line.decode("utf-8"))
            except ValueError:
                continue  # not JSON — ignore stray output
            if msg.get("__linkr_rpc__") == "query":
                resp = await _resolve_query(query_resolver, msg.get("sql", ""))
                proc.stdin.write((json.dumps(resp) + "\n").encode("utf-8"))
                await proc.stdin.drain()
                continue
            return line

    async def shutdown(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            self._proc.kill()
            await self._proc.wait()
        self._proc = None
        if self._cwd:
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
                kernel = self._make(language)
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

    def _make(self, language: str) -> Kernel:
        if language == "python":
            import sys

            return Kernel([sys.executable, "-c", _PY_KERNEL_LOOP])
        if language == "r":
            import tempfile

            # R writes SVG plot files to cwd; give the kernel its own dir.
            workdir = tempfile.mkdtemp(prefix="linkr-rkernel-")
            return Kernel(["Rscript", "--vanilla", "-e", _R_KERNEL_LOOP], cwd=workdir)
        raise ExecutionError(f"No persistent kernel for language: {language}")


manager = KernelManager()
