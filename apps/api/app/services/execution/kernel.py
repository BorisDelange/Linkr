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
import os
import signal
import subprocess
import time
from pathlib import Path

from typing import TYPE_CHECKING, Awaitable, Callable

from app.config import settings
from app.services.execution.runtime import RuntimeOutput, ExecutionError

if TYPE_CHECKING:
    from app.models.environment import Environment


def _client_py_source() -> Path | None:
    """The `linkr` Python client package's source root (the directory to put on
    PYTHONPATH), or None when it is not on disk.

    Mirrors renv_provisioner.client_r_source. It is put on the path rather than
    installed into each project venv so `import linkr` works in a project whose
    environment was never built — the same promise the R client makes."""
    override = os.environ.get("LINKR_CLIENT_PY_SOURCE")
    if override:
        path = Path(override)
        return path if (path / "linkr" / "__init__.py").is_file() else None
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "packages" / "linkr-py" / "src"
        if (candidate / "linkr" / "__init__.py").is_file():
            return candidate
    return None


def _read_rss_kb(pid: int) -> int | None:
    """Resident set size (KB) of a process, without a psutil dependency.

    Reads /proc on Linux (the production Docker image) and falls back to `ps` on
    macOS/dev. Returns None if the process is gone or unreadable — RSS is
    best-effort monitoring, never load-bearing."""
    try:
        with open(f"/proc/{pid}/statm") as f:
            # Fields are in pages; column 2 (resident) × page size.
            resident_pages = int(f.read().split()[1])
        import resource

        return resident_pages * (resource.getpagesize() // 1024)
    except (OSError, ValueError, IndexError):
        pass
    try:
        out = subprocess.run(
            ["ps", "-o", "rss=", "-p", str(pid)],
            capture_output=True, text=True, timeout=2,
        )
        val = out.stdout.strip()
        return int(val) if val else None
    except (subprocess.SubprocessError, ValueError):
        return None

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
import sys, io, json, base64, time, traceback

_real_out, _real_err = sys.stdout, sys.stderr


def _emit(obj):
    _real_out.write(json.dumps(obj) + "\n")
    _real_out.flush()


# Current run number, tagged onto each streamed chunk so the host can discard a
# stopped run's leftover output instead of feeding it to the next run.
_CUR_RUN = 0


class _StreamWriter(io.TextIOBase):
    """A stdout/stderr replacement that emits writes to the host as
    __linkr_stream__ lines, so a REPL sees output as it is produced.

    Writes are coalesced on a short deadline rather than sent one per call: print()
    issues a separate write() per line, so `print(df)` on a large frame sent one JSON
    message, one flush and one websocket frame PER ROW — which cost far more than
    producing the text. Buffering by time, not by size, keeps a slow producer live
    (a lone line still goes out within _FLUSH_S) while a burst leaves as few frames."""

    _FLUSH_S = 0.05

    def __init__(self, kind):
        self._kind = kind
        self._buf = []
        self._deadline = None

    def write(self, s):
        if s:
            now = time.monotonic()
            self._buf.append(s)
            if self._deadline is None:
                self._deadline = now + self._FLUSH_S
            elif now >= self._deadline:
                self.flush()
        return len(s)

    def flush(self):
        if not self._buf:
            self._deadline = None
            return
        _emit({"__linkr_stream__": self._kind, "data": "".join(self._buf),
               "__linkr_run__": _CUR_RUN})
        self._buf = []
        self._deadline = None


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


def _capture_html(obj):
    """A rich HTML widget (plotly figure, folium map, DataFrame styler, anything
    with _repr_html_) rendered to a standalone HTML string, for display in an
    iframe. plotly figures include their JS; other objects give an HTML fragment we
    wrap minimally. Returns None when the object has no HTML representation."""
    if obj is None:
        return None
    # plotly figures: full standalone HTML with the plotly.js bundle inlined.
    try:
        import plotly.graph_objs as go  # noqa
        import plotly.io as pio
        if isinstance(obj, go.Figure):
            # Inline plotly.js (not a CDN link) so it renders inside a sandboxed
            # iframe with no network access.
            return pio.to_html(obj, full_html=True, include_plotlyjs=True)
    except Exception:
        pass
    # Generic _repr_html_ (folium, DataFrame.style, bokeh, etc.).
    repr_html = getattr(obj, "_repr_html_", None)
    if callable(repr_html):
        try:
            frag = repr_html()
        except Exception:
            return None
        if isinstance(frag, str) and frag.strip():
            return f"<!doctype html><html><head><meta charset='utf-8'></head><body>{frag}</body></html>"
    return None


_MISSING = object()


def _exec_capture_last(code):
    """Exec `code`; if its last statement is a bare expression, return that value
    (so `fig` on the last line is captured like a REPL result), else _MISSING.
    Raises on user errors so the caller prints the traceback."""
    import ast

    tree = ast.parse(code, "<analysis>", "exec")  # SyntaxError → caller's except
    last_expr = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last_expr = tree.body.pop()
    exec(compile(tree, "<analysis>", "exec"), _ns)
    if last_expr is None:
        return _MISSING
    return eval(compile(ast.Expression(last_expr.value), "<analysis>", "eval"), _ns)


def _run(code, stream):
    """Execute `code` in the persistent namespace. When `stream`, stdout/stderr
    are pushed to the host live and the returned strings are empty; otherwise
    they are buffered and returned in the done payload."""
    figures, table, html = [], None, None
    failed = False
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
        last = _exec_capture_last(code)
        # A `result` variable OR a trailing expression can carry the payload.
        # Prefer an explicit `result`; fall back to the last expression's value.
        candidate = _ns.get("result")
        if candidate is None and last is not _MISSING:
            candidate = last
        table = _capture_table(candidate)
        html = _capture_html(candidate)
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
        failed = True
    except Exception:
        traceback.print_exc()
        failed = True
    finally:
        # Writes are coalesced on a deadline that only advances on the NEXT write, so
        # whatever the run produced last is still sitting in the buffer. Flush both
        # before restoring, or a run's final lines never reach the host.
        if stream:
            sys.stdout.flush()
            sys.stderr.flush()
        sys.stdout, sys.stderr = _real_out, _real_err
    return {"stdout": "" if stream else out.getvalue(),
            "stderr": "" if stream else err.getvalue(),
            "figures": figures, "table": table, "html": html,
            "failed": failed, "__linkr_done__": True}


# Explicit readline (not `for line in sys.stdin`) so sql_query can do its own
# readline() for RPC responses without fighting the iterator's read-ahead buffer.
_run_n = 0
while True:
    try:
        line = sys.stdin.readline()
    except KeyboardInterrupt:
        # A Stop SIGINT that lands while idle (between runs, in readline) must not
        # kill the kernel — just resume waiting for the next request.
        continue
    if not line:
        break
    line = line.strip()
    if not line:
        continue
    # Bump the counter BEFORE anything interruptible, so the done emitted below always
    # carries THIS run's tag — a tag from the previous run would be discarded as stale
    # by the host and leave the client waiting forever.
    _run_n += 1
    _CUR_RUN = _run_n
    try:
        # Inside the try: a Stop SIGINT racing the dispatch can land HERE, between the
        # readline and _run's own handler. Uncaught it killed the interpreter (and the
        # whole namespace) instead of just aborting the run.
        # Ack first: tells the host we're inside the interrupt-safe loop, so Stop works
        # even for a run that prints nothing before it hangs.
        _emit({"__linkr_ack__": True})
        stream = line[:1] == "S"
        code = base64.b64decode(line[1:]).decode("utf-8")
        result = _run(code, stream)
    # BaseException so a stray KeyboardInterrupt between expressions (outside
    # _run's own handler) ends the run cleanly instead of killing the interpreter.
    except BaseException as e:  # noqa: BLE001
        result = {"stdout": "", "stderr": "kernel error: " + str(e),
                  "figures": [], "table": None, "html": None,
                  "__linkr_done__": True}
    # Tag the done with the run counter so the host can discard a STALE done left
    # in the pipe by a stopped run (whose reader was torn down) instead of pairing
    # it with the next run — that mismatch made a fresh run look done instantly.
    result["__linkr_run__"] = _run_n
    _emit(result)
'''


# The R kernel loop: same wire protocol as Python (one "[SB]"+base64 request per
# stdin line). In stream mode, stdout/stderr flush per output line as
# __linkr_stream__ records; in batch mode capture.output buffers a single blob.
# eval() runs in globalenv() so variables persist; an svglite device per run
# yields SVG figures. R interrupts (SIGINT) surface as a caught condition, so the
# kernel survives Ctrl+C.
# NOTE: keep this R source LEAN. It is passed to `Rscript --vanilla -e <loop>` as a
# single argv string; past a ~7 KB threshold Rscript mangles the argument (emits a
# "WARNING: '-e ..." and dies with "unexpected end of input"), so the kernel never
# starts and the client hangs on "Loading R runtime". Prose comments therefore live
# HERE in Python, not inside the R string. What the leading R does:
#   - STRICT library isolation (the renv "sandbox" technique): when LINKR_R_LIB is set
#     (a project env), REPLACE the .Library binding with LINKR_R_SANDBOX — a directory
#     the server pre-populates with symlinks to ONLY the base+recommended packages
#     (selected by Priority, not by path). This works even where base and contributed
#     packages share one directory (e.g. the macOS R.framework), which a plain
#     .libPaths()+ .Library could not isolate. Then pin .libPaths() to [project lib,
#     shared kernel-infra lib] so library() resolves ONLY against the project's
#     declared packages + the kernel infra + base R — a server-global package (plotly
#     not in renv.lock) never leaks. Empty LINKR_R_LIB (the app interpreter) keeps the
#     default paths but still PREPENDS the kernel-infra lib, so the packages Linkr
#     ships win over a same-named one in the site library. That is not hypothetical:
#     LinkR v1 (the Shiny app) is itself an R package called `linkr`, so on a machine
#     where it is installed, library(linkr) used to load v1 and every linkr_*() helper
#     came back "could not find function".
#   - point install.packages()/renv at the configured repo so a manual install in
#     the R console has a CRAN mirror despite --vanilla skipping the site Rprofile.
#   - absorb a STRAY interrupt during the idle stdin read: a Stop SIGINT races the
#     run's own completion and can land after the run's done payload, while the
#     kernel is back blocking idle on stdin. Catching it there (the `.stray_int`
#     retry) stops it from firing at the start of the NEXT run and aborting it with
#     a spurious "interrupt". A real in-flight run is still interrupted inside
#     .eval_one. .stray_int distinguishes an absorbed interrupt (retry the read)
#     from a real EOF (readLines returns character(0) → break).
# And what the per-run body does (comments kept here, not in the R string, to stay
# under the argv threshold):
#   - ack (__linkr_ack__) BEFORE any interruptible work, so the host knows the
#     interpreter is inside its interrupt-catching loop and Stop can SIGINT it even
#     for a run that prints nothing before hanging. See Kernel._running.
#   - figures go into a PROCESS-UNIQUE temp dir, never the shared working directory:
#     ephemeral dashboard kernels share the project cwd and all start at .run_n = 1,
#     so a fixed "p_001.svg" in "." made parallel widgets overwrite each other's
#     figures — only one widget's plot survived.
#   - the 28x28in @ pointsize 24 device reproduces WebR's 2016x2016px client canvas
#     (webr-engine.ts), so a widget's absolute sizes (base_size, margins, point/text
#     sizes) render identically in both modes; the old 8x6 landscape device made
#     large base_size text overflow and overlap.
#   - one top-level expression at a time: in stream mode each expression's output is
#     emitted as soon as it finishes, so `print("a"); Sys.sleep(5); print("b")` shows
#     "a", the pause, then "b" instead of both at the end. Batch mode accumulates
#     into .out for the single final payload.
#   - that per-expression output is emitted as ONE message, not one per line. The
#     granularity R can actually offer is the expression (capture.output returns the
#     whole block once the call has returned), so splitting it per line bought no
#     earlier delivery — it only multiplied the cost: `sql_query("SELECT * FROM
#     person")` on a large table became one JSON encode, one flush and one websocket
#     frame PER ROW, which took far longer than the query. Interleaving is unchanged:
#     stdout and stderr are still emitted separately, in order, per expression.
#   - auto-print ONLY visible values, exactly like the R REPL: `x <- 3`, `library(..)`
#     and other invisible-returning calls print nothing, while a bare `x` or
#     `head(df)` prints. withVisible() carries R's visibility flag; printing
#     `.last_value` directly (always visible) would leak the injected dataset
#     preamble's intermediate values.
#   - the outer tryCatch(interrupt=) around the eval loop catches an interrupt landing
#     BETWEEN expressions (in .stream_lines/parse/…, outside .eval_one's handler),
#     which would otherwise be uncaught and kill the interpreter.
#   - an error STOPS the run (.failed), like `Rscript` and unlike the REPL: the loop
#     used to carry on, so `library(nope); iris` printed the error and then all of
#     iris, which reads as a run that worked. A failed run emits no table and no
#     htmlwidget either — those describe a result the script never reached.
#   - htmlwidget save uses ONLY selfcontained=TRUE: the client shows it in a
#     sandboxed, network-less iframe, so a non-self-contained widget (JS/CSS in a
#     sibling *_files/ dir) renders blank. Surface the save error instead.
#   - a trailing data.frame becomes the result table, by the same rule the Python
#     kernel applies to a pandas DataFrame: an explicit `result` wins, else the
#     last visible value, capped at 1000 rows. Cells go through format() so
#     factors and dates read as they do in the console instead of as integer
#     codes, and every NA becomes "" — format(NA) is "NA" for most types but ""
#     for dates, and a literal "NA" cell is indistinguishable from a string that
#     happens to say NA. An htmlwidget is not a data.frame, so a DT::datatable
#     takes the html branch above and never produces both.
_R_KERNEL_LOOP = r'''
tryCatch({
local({
  .lib <- Sys.getenv("LINKR_R_LIB")
  if (nzchar(.lib)) {
    .sandbox <- Sys.getenv("LINKR_R_SANDBOX")
    if (nzchar(.sandbox) && dir.exists(.sandbox)) {
      .base <- .BaseNamespaceEnv
      if (bindingIsLocked(".Library", .base)) unlockBinding(".Library", .base)
      assign(".Library", .sandbox, envir = .base)
      lockBinding(".Library", .base)
    }
    .paths <- c(.lib, Sys.getenv("LINKR_R_KERNEL_LIB"))
    .libPaths(.paths[nzchar(.paths)])
  } else {
    .klib <- Sys.getenv("LINKR_R_KERNEL_LIB")
    if (nzchar(.klib)) .libPaths(c(.klib, .libPaths()))
  }
  .repo <- Sys.getenv("LINKR_R_REPOS")
  if (nzchar(.repo)) options(repos = c(CRAN = .repo))
})
suppressMessages({
  .has_svglite <- requireNamespace("svglite", quietly = TRUE)
  library(jsonlite); library(base64enc)
})
}, interrupt = function(e) NULL)
.con <- file("stdin", "r")
.run_n <- 0
.emit <- function(obj) {
  cat(toJSON(obj, auto_unbox = TRUE, null = "null"), "\n", sep = "")
  flush(stdout())
}
.stream_lines <- function(kind, text) {
  if (length(text) == 0) return(invisible())
  .emit(list("__linkr_stream__" = kind, data = paste0(paste0(text, collapse = "\n"), "\n"),
             "__linkr_run__" = .run_n))
}
# A true handle on fd 1, unaffected by sink(). .eval_one runs user code under
# utils::capture.output(), which sinks the default connection — an RPC emitted
# through .emit() from inside user code would land in the run's captured stdout
# instead of reaching the host, and the kernel would then block forever waiting
# for a reply nobody was asked for. Only protocol lines emitted from within user
# code need this; .emit() elsewhere runs outside the sink.
#
# Opened on first use, never at boot: holding a second handle on fd 1 from the
# start blocks the kernel before it reaches its read loop.
.rpc_con <- NULL
.rpc_connection <- function() {
  if (is.null(.rpc_con))
    .rpc_con <<- tryCatch(file("/dev/fd/1", "w", raw = TRUE), error = function(e) NULL)
  if (is.null(.rpc_con))
    stop("sql_query() is unavailable: this kernel could not open fd 1.", call. = FALSE)
  .rpc_con
}

# sql_query(): the R counterpart of the Python kernel's helper. Same RPC — emit a
# query request, block on the reply — so the host services both kernels through
# one code path and holds the connection config; the kernel never sees it.
# Reads from .con, the same handle the run loop uses, so the reply cannot be
# swallowed by a second buffered reader.
sql_query <- function(sql) {
  .rc <- .rpc_connection()
  writeLines(toJSON(list("__linkr_rpc__" = "query", sql = sql),
                    auto_unbox = TRUE, null = "null"), .rc)
  flush(.rc)
  .resp <- fromJSON(readLines(.con, n = 1, warn = FALSE), simplifyVector = FALSE)
  if (!is.null(.resp$error)) stop(.resp$error, call. = FALSE)
  .rows <- .resp$rows
  if (length(.rows) == 0) return(data.frame())
  # rows arrive as a list of {column: value} objects; NULL (SQL NULL) becomes NA
  # so a column keeps its length and does not silently collapse.
  .cols <- names(.rows[[1]])
  .df <- lapply(.cols, function(.c)
    unlist(lapply(.rows, function(.r) if (is.null(.r[[.c]])) NA else .r[[.c]]), use.names = FALSE))
  names(.df) <- .cols
  as.data.frame(.df, stringsAsFactors = FALSE, optional = TRUE)
}
repeat {
  # Absorb a stray SIGINT arriving during the idle read (a late Stop from a
  # finished run) so it can't bleed into the next run. See Python notes below.
  .stray_int <- FALSE
  .line <- tryCatch(readLines(.con, n = 1, warn = FALSE),
                    interrupt = function(i) { .stray_int <<- TRUE; character(0) })
  if (.stray_int) next
  if (length(.line) == 0) break
  .line <- trimws(.line)
  if (nchar(.line) == 0) next
  .run_n <- .run_n + 1
  # Ack before any interruptible work: tells the host we're inside the
  # interrupt-catching loop, so Stop works even for a run that prints nothing.
  .emit(list("__linkr_ack__" = TRUE))
  .stream <- substr(.line, 1, 1) == "S"
  .code <- rawToChar(base64decode(substr(.line, 2, nchar(.line))))
  .fig_dir <- file.path(tempdir(), sprintf("linkr_figs_%03d", .run_n))
  dir.create(.fig_dir, showWarnings = FALSE, recursive = TRUE)
  .pat <- file.path(.fig_dir, "p_%03d.svg")
  if (.has_svglite) svglite::svglite(filename = .pat, width = 28, height = 28, pointsize = 24)
  .err <- character(0)
  .interrupted <- FALSE
  # The value of the last evaluated expression — captured so a trailing htmlwidget
  # (plotly/leaflet/DT) can be rendered to HTML like a REPL auto-print.
  .last_value <- NULL
  .failed <- FALSE
  .eval_one <- function(.e) tryCatch(
    withCallingHandlers(
      utils::capture.output({
        .vis <- withVisible(eval(.e, envir = globalenv()))
        .last_value <<- .vis$value
        if (isTRUE(.vis$visible)) print(.vis$value)
      }),
      warning = function(w) { .err <<- c(.err, conditionMessage(w)); invokeRestart("muffleWarning") },
      message = function(m) { .err <<- c(.err, conditionMessage(m)); invokeRestart("muffleMessage") }
    ),
    interrupt = function(i) { .err <<- c(.err, "interrupt"); .interrupted <<- TRUE; character(0) },
    error = function(e) { .err <<- c(.err, conditionMessage(e)); .failed <<- TRUE; character(0) }
  )
  .out <- character(0)
  tryCatch({
    .exprs <- tryCatch(parse(text = .code),
                       error = function(e) { .err <<- c(.err, conditionMessage(e)); .failed <<- TRUE; NULL })
    for (.e in .exprs) {
      .e_out <- .eval_one(.e)
      if (.stream) {
        .stream_lines("stdout", .e_out)
        .stream_lines("stderr", .err)
        .err <- character(0)
      } else {
        .out <- c(.out, .e_out)
      }
      # Stop (Ctrl+C) interrupts the whole run, not just the current expression —
      # otherwise a `print` after an interrupted `Sys.sleep` would still fire.
      if (.interrupted || .failed) break
    }
  }, interrupt = function(i) { .interrupted <<- TRUE })
  # A parse error (or any error left over when there were no expressions to run)
  # still needs to reach a streaming client — flush it here.
  if (.stream && length(.err) > 0) { .stream_lines("stderr", .err); .err <- character(0) }
  if (.has_svglite) invisible(grDevices::dev.off())
  .figs <- list()
  for (.f in sort(list.files(.fig_dir, pattern = "svg$", full.names = TRUE))) {
    .svg <- paste(readLines(.f, warn = FALSE), collapse = "\n")
    if (grepl("<svg", .svg, fixed = TRUE))
      .figs[[length(.figs) + 1]] <- list(type = "svg", data = .svg, label = paste("Plot", length(.figs) + 1))
  }
  unlink(.fig_dir, recursive = TRUE)
  # A trailing htmlwidget (plotly/leaflet/DT/…) → standalone HTML, shown in an
  # iframe on the client. saveWidget needs pandoc-free self-contained output.
  .html <- NULL
  if (!.interrupted && !.failed && inherits(.last_value, "htmlwidget") &&
      requireNamespace("htmlwidgets", quietly = TRUE)) {
    .tmp <- tempfile(fileext = ".html")
    .ok <- tryCatch({ htmlwidgets::saveWidget(.last_value, .tmp, selfcontained = TRUE); TRUE },
                    error = function(e) { .err <<- c(.err, conditionMessage(e)); FALSE })
    if (isTRUE(.ok) && file.exists(.tmp)) {
      .html <- paste(readLines(.tmp, warn = FALSE), collapse = "\n")
      file.remove(.tmp)
    }
  }
  .table <- NULL
  if (!.interrupted && !.failed) {
    .cand <- if (exists("result", envir = globalenv(), inherits = FALSE))
      get("result", envir = globalenv()) else .last_value
    if (is.data.frame(.cand) && ncol(.cand) > 0) {
      .table <- tryCatch({
        .head <- utils::head(.cand, 1000)
        list(headers = as.character(names(.head)),
             rows = unname(lapply(seq_len(nrow(.head)), function(.i)
               as.character(vapply(.head, function(.col) {
                 .cell <- .col[[.i]]
                 if (length(.cell) != 1L || is.na(.cell)) return("")
                 .v <- format(.cell)
                 if (length(.v) == 1L) .v else ""
               }, character(1))))))
      }, error = function(e) NULL)
    }
  }
  .emit(list(stdout = if (.stream) "" else paste(.out, collapse = "\n"),
             stderr = if (.stream) "" else paste(.err, collapse = "\n"),
             figures = .figs, table = .table, html = .html,
             failed = (.failed || .interrupted),
             "__linkr_run__" = .run_n, "__linkr_done__" = TRUE))
}
'''


# Heavy imports a widget process almost always needs. Run once at spawn on a
# warm-pool process so the first real run doesn't pay the import cost. Kept in a
# try/except: a project env may lack one (e.g. no plotly) and that must not stop
# the process from starting — the real run will surface a clear ImportError.
_WARM_BOOTSTRAP = {
    "python": (
        "try:\n"
        "    import pandas, numpy, matplotlib\n"
        "    matplotlib.use('Agg')\n"
        "    import matplotlib.pyplot\n"
        "except Exception:\n"
        "    pass\n"
    ),
    "r": (
        "suppressWarnings(suppressMessages(tryCatch({\n"
        "  library(arrow); library(ggplot2); library(dplyr)\n"
        "}, error = function(e) NULL)))\n"
    ),
}


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

    def __init__(
        self,
        cmd: list[str],
        cwd: str | None = None,
        owns_cwd: bool = False,
        env: dict[str, str] | None = None,
    ):
        self._cmd = cmd
        self._cwd = cwd
        # Extra env layered over the server's own (LINKR_IDE/DATASETS/PROJECT), so a
        # script reaches the datasets dir without hard-coding its absolute path.
        self._env = env
        # Only remove cwd on shutdown when we created it (a throwaway temp dir).
        # A per-project working dir is persistent and must never be deleted here.
        self._owns_cwd = owns_cwd
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self.busy = False
        # Highest run number whose done payload we've already consumed. The kernel
        # tags every done with a monotonic __linkr_run__; a done at or below this
        # is a STALE leftover from a stopped run whose reader was torn down, and
        # must be skipped so it isn't paired with the current run. Reset whenever a
        # fresh process starts (its counter restarts at 0).
        self._run_seq = 0
        # Has THIS process proven it reached its interrupt-catching read loop? A SIGINT
        # delivered before that point (the interpreter is still booting: importing
        # site-packages, sourcing the R prologue) hits a process with no handler
        # installed and kills it, taking the namespace with it. The kernel's first
        # emitted line is the proof; from then on the process stays interrupt-safe, so
        # this only ever gates the cold-start window. Reset with the process.
        self._running = False
        # Monotonic timestamp of the last run — drives the idle-timeout sweep and
        # the footer's "last active" display. Seeded at creation so a just-started
        # kernel isn't immediately considered idle.
        self.last_activity = time.monotonic()

    @property
    def pid(self) -> int | None:
        return self._proc.pid if self._proc is not None and self._proc.returncode is None else None

    @property
    def rss_kb(self) -> int | None:
        pid = self.pid
        return _read_rss_kb(pid) if pid is not None else None

    def idle_seconds(self) -> float:
        return time.monotonic() - self.last_activity

    async def _ensure_started(self) -> asyncio.subprocess.Process:
        if self._proc is not None and self._proc.returncode is None:
            return self._proc
        # One result line carries the whole JSON output (stdout + base64 figures +
        # table), which easily exceeds asyncio's default 64 KB StreamReader limit
        # and would raise LimitOverrunError on readline(). Raise it to 64 MB.
        proc_env = None
        if self._env:
            import os

            proc_env = {**os.environ, **self._env}
        self._proc = await asyncio.create_subprocess_exec(
            *self._cmd,
            cwd=self._cwd,
            env=proc_env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=64 * 1024 * 1024,
        )
        # A fresh process restarts its run counter at 0 and has not yet proven it
        # reached its interrupt-catching loop.
        self._run_seq = 0
        self._running = False
        return self._proc

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    def interrupt(self) -> bool:
        """Send SIGINT to the running kernel (Ctrl+C). Returns False if no live
        process. The kernel catches the interrupt and stays alive for the next
        request; a hung C-extension that ignores SIGINT still hits the timeout.

        Only fires while a run is in flight AND the interpreter has confirmed it is
        executing (``_running``). A Stop click races the run's own completion — the
        client aborts the stream and calls this in parallel. If the run already
        finished, the kernel is back to blocking on stdin for the NEXT request; a
        SIGINT delivered then is queued by the interpreter and caught at the start of
        the following run, which would wrongly abort a fresh run with a spurious
        "interrupt". Skipping it when idle keeps Stop→re-run working.

        ``busy`` alone is NOT enough: it is set before the code is even written to
        stdin, so on a COLD kernel a Stop within ~100ms lands while the interpreter is
        still booting — before it installs any handler — and kills it outright,
        destroying the whole namespace. ``_running`` is set only once the kernel has
        emitted its first line for this run, i.e. it is definitely inside its
        interrupt-catching loop."""
        if self._proc is None or self._proc.returncode is not None:
            return False
        if not self.busy or not self._running:
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
            failed=out.failed,
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
            self.last_activity = time.monotonic()
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
                self.last_activity = time.monotonic()

        if done is None:
            await self.shutdown()
            raise ExecutionError("Kernel exited unexpectedly.")
        return RuntimeOutput(
            stdout=done.get("stdout", ""),
            stderr=done.get("stderr", ""),
            figures=done.get("figures", []),
            table=done.get("table"),
            html=done.get("html"),
            failed=bool(done.get("failed")),
        )

    async def _run_once(self, code: str, on_chunk, query_resolver) -> dict | None:
        """Send `code` to the (started) kernel in stream mode and read until the
        done payload. Raises BrokenPipeError/ConnectionResetError on a dead pipe."""
        proc = await self._ensure_started()
        assert proc.stdin is not None and proc.stdout is not None
        # The kernel increments __linkr_run__ on every request it reads, in lockstep
        # with this counter (one request per _run_once). We accept only the done
        # carrying our number; anything lower is a leftover from a stopped run whose
        # reader was torn down, so it must be skipped instead of ending THIS run.
        self._run_seq += 1
        expected = self._run_seq
        proc.stdin.write(b"S" + base64.b64encode(code.encode("utf-8")) + b"\n")
        await proc.stdin.drain()
        return await self._read_stream(proc, on_chunk, query_resolver, expected)

    async def _read_stream(self, proc, on_chunk, query_resolver, expected=None) -> dict | None:
        """Read stdout line by line: forward __linkr_stream__ chunks to on_chunk,
        service __linkr_rpc__ SQL requests, return the __linkr_done__ payload (or
        None on EOF). Each read is bounded by the execution timeout.

        `expected` is this run's kernel run number. Chunks and a done tagged with a
        LOWER number are leftovers from a stopped run whose reader was torn down —
        they still sit in the pipe and must be discarded, not fed to this run."""
        # Until we've seen this run's first tagged line, we can't tell a leftover
        # chunk from ours (chunks carry no run number). But leftovers only ever
        # precede our own output, and the kernel processes requests strictly in
        # order, so once our done arrives everything before it that outranks us was
        # already skipped. A leftover done (lower number) is the reliable discriminator.
        while True:
            line = await asyncio.wait_for(
                proc.stdout.readline(), timeout=settings.execution_timeout_seconds
            )
            if not line:
                return None
            # Any line at all proves the interpreter is past boot and inside its
            # interrupt-catching loop, so Stop can now safely SIGINT it.
            self._running = True
            try:
                msg = json.loads(line.decode("utf-8"))
            except ValueError:
                continue  # not JSON — ignore stray output
            if msg.get("__linkr_rpc__") == "query":
                resp = await _resolve_query(query_resolver, msg.get("sql", ""))
                proc.stdin.write((json.dumps(resp) + "\n").encode("utf-8"))
                await proc.stdin.drain()
                continue
            # The kernel's per-run ack: it is inside its interrupt-catching loop and
            # nothing has been evaluated yet. Carries no output — just unblocks Stop
            # for a run that prints nothing before it hangs.
            if msg.get("__linkr_ack__"):
                continue
            run_n = msg.get("__linkr_run__")
            is_stale = (
                expected is not None and isinstance(run_n, int) and run_n < expected
            )
            stream_kind = msg.get("__linkr_stream__")
            if stream_kind is not None:
                # Drop a leftover chunk from a stopped run so its output doesn't
                # bleed into ours.
                if is_stale:
                    continue
                res = on_chunk(stream_kind, msg.get("data", ""))
                if asyncio.iscoroutine(res):
                    await res
                continue
            if msg.get("__linkr_done__"):
                # A done from an earlier run (its reader was torn down) is stale —
                # skip it and keep reading for ours. Without the tag (legacy), accept.
                if is_stale:
                    continue
                # A done from a LATER run means the pipe desynced (the kernel read a
                # request we never counted), so this payload belongs to work we can't
                # attribute. Accepting it would repeat the "fresh run looks instantly
                # done" bug in the other direction; the pipe is unrecoverable, so fail
                # and let the caller restart the kernel.
                if expected is not None and isinstance(run_n, int) and run_n > expected:
                    raise ExecutionError(
                        f"Kernel stream desynchronised (run {run_n} > {expected})."
                    )
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


class KernelLimitReached(Exception):
    """A user has hit max_kernels_per_user concurrent R/Python kernels."""


class KernelManager:
    """Holds live kernels keyed by (project_uid, language, session_id).

    Idle kernels are evicted after ``session_timeout_minutes`` (their process is
    a long-lived interpreter holding memory), and the number of concurrent
    kernels per user is capped at ``max_kernels_per_user`` — the same limits the
    PTY shells enforce, so a user cannot pin unbounded server processes."""

    def __init__(self):
        # Keyed by (project_uid, user_id, language, session_id): a kernel holds a
        # live variable namespace, so it MUST be per-user — two users on the same
        # session id must never share one interpreter (they'd see each other's
        # variables). The managed environment is resolved separately and passed to
        # `get`; the session id only selects which live process among a user's own.
        self._kernels: dict[tuple[str, int, str, str], Kernel] = {}
        self._lock = asyncio.Lock()
        # Memo of the data dir whose shared R sandbox + kernel-infra library are already
        # provisioned, so the hot spawn path costs an in-memory compare instead of two
        # Rscript launches. Keyed by path, not a bare bool: the data dir is
        # reconfigurable (and per-test), and a stale "ready" against a fresh, empty
        # sandbox starts an R kernel that dies on launch. Its own lock (never the
        # manager lock) so a cold build doesn't block unrelated kernel ops.
        self._r_shared_ready_for: str | None = None
        self._r_shared_lock = asyncio.Lock()

    def _timeout_seconds(self) -> float:
        return settings.session_timeout_minutes * 60

    def _sweep_idle_locked(self) -> list[Kernel]:
        """Drop kernels idle past the timeout. Caller holds the lock; returns the
        evicted kernels to shut down outside it (shutdown awaits the process)."""
        timeout = self._timeout_seconds()
        evicted: list[Kernel] = []
        for key in list(self._kernels):
            kernel = self._kernels[key]
            # Dead kernels are evicted immediately (even with the idle timeout
            # disabled) — they'd otherwise count toward the per-user cap.
            idle = timeout > 0 and not kernel.busy and kernel.idle_seconds() > timeout
            if not kernel.alive or idle:
                evicted.append(kernel)
                del self._kernels[key]
        return evicted

    def _count_for_user(self, user_id: int) -> int:
        return sum(1 for (_p, uid, _l, _s) in self._kernels if uid == user_id)

    async def get(
        self,
        project_uid: str,
        user_id: int,
        language: str,
        session_id: str,
        environment: "Environment | None" = None,
        token: str | None = None,
    ) -> Kernel:
        """Return the caller's live kernel, launching one on a cache miss.

        `environment` is the resolved project environment (interpreter + packages)
        used only when a new kernel is spawned; on the hot path (kernel already
        alive) it is ignored, so callers may pass None to keep today's behaviour.

        `token` (a kernel token for the client libraries) is likewise baked into the
        process env at spawn. A live kernel therefore keeps the token it started
        with: it outlives a single request, so it cannot be refreshed per call. The
        token's lifetime is what bounds this — an expired one is re-minted by the
        next kernel this session starts."""
        # BEFORE the lock: provisioning the shared R sandbox / kernel-infra library
        # shells out to Rscript (~9s on a cold cache, ~0.3s warm). Doing it inside
        # _make — which runs under self._lock — froze the whole event loop and queued
        # every other user's kernel op behind it.
        await self._prepare_r_shared(language)
        key = (project_uid, user_id, language, session_id)
        async with self._lock:
            to_shutdown = self._sweep_idle_locked()
            kernel = self._kernels.get(key)
            if kernel is None:
                if self._count_for_user(user_id) >= settings.max_kernels_per_user:
                    for k in to_shutdown:
                        await k.shutdown()
                    raise KernelLimitReached(
                        f"Kernel session limit reached ({settings.max_kernels_per_user})."
                    )
                kernel = self._make(language, project_uid, environment, token)
                self._kernels[key] = kernel
        for k in to_shutdown:
            await k.shutdown()
        return kernel

    async def _prepare_r_shared(self, language: str) -> None:
        """Materialise the SHARED R directories a kernel needs: the base+recommended
        sandbox, the kernel-infra library (jsonlite/base64enc/svglite + their dependency
        closure), and the `linkr` client package with its own private dependency library.

        All shell out to Rscript, so they run in a thread — never on the event loop, and
        never under the manager lock. Memoised per data dir: after the first success this
        is an in-memory string compare, so the hot spawn path costs nothing.

        Runs for the app interpreter too, not just a project env: `library(linkr)` must
        work in every R session the IDE starts, and the sandbox is a prerequisite of the
        client install (its dependency resolution runs under the same isolation)."""
        if language != "r":
            return
        from app.services import project_fs

        data_dir = str(project_fs.kernel_r_lib())
        if self._r_shared_ready_for == data_dir:
            return
        async with self._r_shared_lock:
            if self._r_shared_ready_for == data_dir:
                return
            from app.services.execution import renv_provisioner

            await asyncio.to_thread(renv_provisioner.ensure_r_sandbox)
            await asyncio.to_thread(renv_provisioner.ensure_kernel_r_lib)
            await asyncio.to_thread(renv_provisioner.ensure_client_r_lib)
            self._r_shared_ready_for = data_dir

    async def spawn_batch(
        self, language: str, project_uid: str, environment: "Environment | None" = None
    ) -> Kernel:
        """A one-shot kernel in a FRESH process (empty namespace), NOT cached and
        NOT counted against the per-user session limit — for a background 'run as
        job'. The caller must ``shutdown()`` it when done. Same interpreter/cwd/env
        selection as an interactive kernel, so managed envs resolve identically."""
        await self._prepare_r_shared(language)
        return self._make(language, project_uid, environment)

    async def restart(
        self, project_uid: str, user_id: int, language: str, session_id: str
    ) -> None:
        key = (project_uid, user_id, language, session_id)
        async with self._lock:
            kernel = self._kernels.pop(key, None)
        if kernel is not None:
            await kernel.shutdown()

    def interrupt(
        self, project_uid: str, user_id: int, language: str, session_id: str
    ) -> bool:
        """SIGINT the caller's live kernel for (project, language, session) — the
        Stop button. Returns False if there's no live kernel to interrupt."""
        kernel = self._kernels.get((project_uid, user_id, language, session_id))
        return kernel.interrupt() if kernel is not None else False

    async def shutdown_session(
        self, project_uid: str, user_id: int, session_id: str
    ) -> None:
        """Kill every kernel (python + r) of one session for a user — used when the
        user deletes that session."""
        async with self._lock:
            keys = [
                k for k in self._kernels
                if k[0] == project_uid and k[1] == user_id and k[3] == session_id
            ]
            kernels = [self._kernels.pop(k) for k in keys]
        for k in kernels:
            await k.shutdown()

    async def shutdown_all(self) -> None:
        async with self._lock:
            kernels = list(self._kernels.values())
            self._kernels.clear()
        for k in kernels:
            await k.shutdown()

    def list_for_user(self, project_uid: str, user_id: int) -> list[dict]:
        """Live kernels for one user in a project: language, session, running/busy
        state, and monitoring (pid, resident memory KB, idle seconds)."""
        return [
            {
                "language": lang,
                "sessionId": session,
                "alive": kernel.alive,
                "busy": kernel.busy,
                "pid": kernel.pid,
                "rssKb": kernel.rss_kb,
                "idleSeconds": round(kernel.idle_seconds()),
            }
            for (proj, uid, lang, session), kernel in self._kernels.items()
            if proj == project_uid and uid == user_id
        ]

    def _make(
        self,
        language: str,
        project_uid: str,
        environment: "Environment | None" = None,
        token: str | None = None,
    ) -> Kernel:
        # The kernel runs in the IDE working dir (RStudio/Jupyter model), so what the
        # terminal sees matches the IDE sidebar. The datasets dir is reachable via
        # $LINKR_DATASETS (it may be a different, re-pointable server folder).
        from app.services import project_fs

        cwd = str(project_fs.ide_dir(project_uid))
        env = project_fs.runtime_env(project_uid, token)
        # A project environment isolates the interpreter (Python venv) or library path
        # (R). `environment is None` is the APP INTERPRETER — the shared server Python /
        # Rscript that runs built-in dashboard component renders; it is deliberately
        # NOT isolated (it uses the app's own packages). A project env, even empty, IS
        # isolated (see the R branch).
        has_env = environment is not None
        interpreter_path = environment.interpreter_path if has_env else None
        if language == "python":
            import sys

            # Python isolation comes from the built venv; an empty/unbuilt env has none,
            # so it falls back to the app interpreter. (R isolates without a build via a
            # possibly-empty library — Python has no lib-only equivalent.)
            python = interpreter_path or sys.executable
            # `import linkr` must work in every project, including one whose venv was
            # never built, so the client package is put on the path rather than
            # installed into each env. PREPENDED, so it wins over an unrelated
            # same-named package the interpreter might already see.
            client_src = _client_py_source()
            if client_src is not None:
                existing = env.get("PYTHONPATH") or os.environ.get("PYTHONPATH", "")
                env = {
                    **env,
                    "PYTHONPATH": (
                        f"{client_src}{os.pathsep}{existing}" if existing else str(client_src)
                    ),
                }
            return Kernel([python, "-c", _PY_KERNEL_LOOP], cwd=cwd, env=env)
        if language == "r":
            # renv keeps a shared Rscript; a project env is isolated by its private
            # library. LINKR_R_REPOS gives a CRAN mirror for a manual install.packages()
            # (--vanilla skips the site Rprofile). STRICT isolation for a project env
            # (see _R_KERNEL_LOOP): the kernel pins .libPaths() to [project lib, shared
            # kernel-infra lib, base R] and drops the site/user library, so a global
            # package (plotly not in the project's renv.lock) never resolves. This
            # applies even to an empty/unbuilt env — its project lib is just empty, so
            # library() of an undeclared package fails cleanly (reproducible renv model)
            # instead of leaking a server-global package. The shared kernel lib
            # (jsonlite/base64enc/svglite) keeps the kernel itself working there. The app
            # interpreter (environment is None) keeps the default paths.
            # The kernel-infra library and the client library are passed in BOTH cases.
            # An isolated env pins .libPaths() to them; the app interpreter prepends the
            # kernel lib to the default paths, so `library(linkr)` finds the client this
            # server ships rather than an unrelated same-named package in the site
            # library (LinkR v1 is itself an R package called `linkr`).
            env = {
                **env,
                "LINKR_R_REPOS": settings.r_repos,
                "LINKR_R_KERNEL_LIB": str(project_fs.kernel_r_lib()),
                "LINKR_CLIENT_R_LIB": str(project_fs.client_r_lib()),
            }
            if has_env:
                from app.services.execution import renv_provisioner

                # The shared sandbox + kernel-infra library are provisioned by
                # _prepare_r_shared() BEFORE the manager lock (they shell out to
                # Rscript); _make must stay non-blocking.
                env = {
                    **env,
                    "LINKR_R_LIB": interpreter_path or str(renv_provisioner.library_path(project_uid)),
                    "LINKR_R_SANDBOX": str(project_fs.r_sandbox()),
                }
            # Run the loop from a file, not `-e`: `-e` silently truncates a long
            # program, and the loop is close enough to that limit that a few added
            # lines would make the kernel hang at boot with no usable error.
            loop_path = project_fs.kernel_r_script(_R_KERNEL_LOOP)
            return Kernel(["Rscript", "--vanilla", str(loop_path)], cwd=cwd, env=env)
        raise ExecutionError(f"No persistent kernel for language: {language}")


def _interpreter_key(language: str, project_uid: str, environment: "Environment | None") -> str:
    """Identity of the interpreter a run will use, so warm processes are only
    reused by runs that would spawn the same interpreter/library set.

    The app interpreter (environment is None) is shared → a per-language system key.
    A project R env is ALWAYS isolated to its own library (even empty/unbuilt), so it
    is keyed per project — otherwise a shared warm process (with global packages)
    could be handed to an env that must only see its declared packages. Python only
    isolates once built (a venv), so an unbuilt Python env still shares the app key."""
    if environment is not None:
        if environment.interpreter_path:
            return environment.interpreter_path
        if language == "r":
            return f"__project_r__:{project_uid}"
    return f"__system__:{language}"


class WarmPool:
    """A small stock of pre-started, pre-imported processes per
    (language, project, interpreter), so a dashboard widget run pays ~0 startup.

    A warm process has already run the heavy imports (pandas/matplotlib), sits
    idle, and is handed to exactly one run. After the run the process is discarded
    (never reused → its namespace never carries state between widgets); the pool
    then tops itself back up in the background.
    """

    def __init__(self) -> None:
        self._pools: dict[tuple[str, str, str], list[Kernel]] = {}
        # In-flight warm spawns per bucket, so concurrent refills don't each spawn
        # the full shortfall (which would overshoot pool_size).
        self._reserved: dict[tuple[str, str, str], int] = {}
        self._lock = asyncio.Lock()

    def _sweep_idle_locked(self) -> list[Kernel]:
        """Drop warm processes that have sat unused past the session timeout (each
        is a live interpreter holding heavy imports in memory) plus any that died.
        A prewarm burst that widgets never consume would otherwise pin those
        processes until app shutdown. Caller holds the lock; returns the evicted
        kernels to shut down outside it (shutdown awaits the process)."""
        timeout = settings.session_timeout_minutes * 60
        evicted: list[Kernel] = []
        for key in list(self._pools):
            kept: list[Kernel] = []
            for k in self._pools[key]:
                idle = timeout > 0 and k.idle_seconds() > timeout
                if not k.alive or idle:
                    evicted.append(k)
                else:
                    kept.append(k)
            if kept:
                self._pools[key] = kept
            else:
                del self._pools[key]
        return evicted

    async def acquire(
        self, make: "Callable[[], Kernel]", language: str, project_uid: str,
        interpreter_key: str,
    ) -> Kernel:
        """Take a warm process for this bucket, or make + warm one on the spot when
        the pool is empty. Always returns a started kernel; the caller owns it and
        must shutdown() it when the run finishes."""
        key = (language, project_uid, interpreter_key)
        async with self._lock:
            stale = self._sweep_idle_locked()
            bucket = self._pools.get(key)
            k = bucket.pop() if bucket else None
            reserved = self._reserved.get(key, 0)
        for s in stale:
            await s.shutdown()
        if k is not None and k.alive:
            return k
        # Empty pool but a prewarm/refill is in flight (reserved > 0): a warm process
        # is seconds away. Wait for it rather than each concurrent run cold-starting
        # its own — that's what made a page of widgets warm serially instead of once.
        if reserved > 0:
            for _ in range(600):  # up to ~30s, matched to a cold Rscript+library() warm
                await asyncio.sleep(0.05)
                async with self._lock:
                    bucket = self._pools.get(key)
                    k = bucket.pop() if bucket else None
                    still_warming = self._reserved.get(key, 0) > 0
                if k is not None and k.alive:
                    return k
                if not still_warming:
                    break  # warming finished without a spare for us — fall through
        # Cache miss (empty pool, nothing warming): make + warm inline.
        k = make()
        await _warm(k, language)
        return k

    async def refill(
        self, make: "Callable[[], Kernel]", language: str, project_uid: str,
        interpreter_key: str, pool_size: int,
    ) -> None:
        """Bring the bucket up to `pool_size`, warming the missing processes
        CONCURRENTLY (so prewarming N for a page of N widgets costs one cold start,
        not N of them). Best-effort: a spawn/warm failure just leaves the pool
        short (the next acquire makes one). A reservation counter prevents two
        concurrent refills from both spawning the same shortfall."""
        key = (language, project_uid, interpreter_key)
        async with self._lock:
            stale = self._sweep_idle_locked()
            have = len(self._pools.get(key, [])) + self._reserved.get(key, 0)
            need = max(0, pool_size - have)
            if need > 0:
                self._reserved[key] = self._reserved.get(key, 0) + need
        for s in stale:
            await s.shutdown()
        if need == 0:
            return

        async def warm_one() -> None:
            k = make()
            try:
                await _warm(k, language)
            except Exception:  # noqa: BLE001 — a warm failure must not crash refill
                await k.shutdown()
                async with self._lock:
                    self._reserved[key] = max(0, self._reserved.get(key, 0) - 1)
                return
            async with self._lock:
                self._pools.setdefault(key, []).append(k)
                self._reserved[key] = max(0, self._reserved.get(key, 0) - 1)

        await asyncio.gather(*(warm_one() for _ in range(need)))

    async def shutdown_all(self) -> None:
        async with self._lock:
            kernels = [k for bucket in self._pools.values() for k in bucket]
            self._pools.clear()
        for k in kernels:
            await k.shutdown()


async def _warm(k: Kernel, language: str) -> None:
    """Start a kernel and run its warm bootstrap (heavy imports) so a later run
    on it is import-free. Swallows the bootstrap's own errors — a missing package
    surfaces on the real run, not here."""
    bootstrap = _WARM_BOOTSTRAP.get(language, "")
    if bootstrap:
        await k.execute(bootstrap)
    else:
        await k._ensure_started()


manager = KernelManager()
warm_pool = WarmPool()


class EphemeralConcurrency:
    """Bounds simultaneous ephemeral widget runs so a dashboard with many widgets
    doesn't launch an unbounded number of processes at once. Excess runs queue on
    the semaphore but still execute in parallel up to the bound."""

    def __init__(self) -> None:
        self._sem: asyncio.Semaphore | None = None

    def _semaphore(self) -> asyncio.Semaphore:
        # Built lazily on the running loop (settings aren't available at import in
        # every test harness, and a Semaphore binds to the current event loop).
        if self._sem is None:
            self._sem = asyncio.Semaphore(settings.widget_max_concurrency)
        return self._sem

    async def __aenter__(self):
        await self._semaphore().acquire()
        return self

    async def __aexit__(self, *exc):
        self._semaphore().release()


_ephemeral_gate = EphemeralConcurrency()


# Background refill/prewarm tasks are retained here: the event loop keeps only a
# weak reference to a bare create_task, so one whose sole reference is dropped can
# be garbage-collected mid-flight (silently cancelling the refill). Holding a
# strong ref until the task finishes prevents that.
_bg_tasks: set[asyncio.Task] = set()


def _spawn_bg(coro) -> None:
    task = asyncio.create_task(coro)
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


async def run_ephemeral(
    language: str,
    project_uid: str,
    code: str,
    environment: "Environment | None",
    query_resolver=None,
) -> RuntimeOutput:
    """Run `code` in a FRESH, isolated process taken from the warm pool, then
    discard it and refill the pool in the background. Bounded by the concurrency
    gate. For dashboard widgets: parallel, never sharing a namespace or a lock."""
    interpreter_key = _interpreter_key(language, project_uid, environment)

    # Provision the shared R dirs here (off the loop, memoised) so the pool's sync
    # factory below never shells out to Rscript.
    await manager._prepare_r_shared(language)

    def make() -> Kernel:
        return manager._make(language, project_uid, environment)

    async with _ephemeral_gate:
        k = await warm_pool.acquire(make, language, project_uid, interpreter_key)
        try:
            return await k.execute(code, query_resolver=query_resolver)
        finally:
            await k.shutdown()
            _spawn_bg(
                warm_pool.refill(
                    make, language, project_uid, interpreter_key, settings.widget_pool_size
                )
            )


async def prewarm(
    language: str, project_uid: str, environment: "Environment | None",
    count: int | None = None,
) -> None:
    """Fill the warm pool for this (language, project, interpreter) in the
    background — called on dashboard open so the widgets' first runs are warm.

    `count` lets the dashboard size the pool to how many code widgets a page has
    (so 4 widgets get 4 warm processes, not the default 2), clamped to the
    concurrency bound so a huge page can't pre-spawn an unbounded fleet."""
    interpreter_key = _interpreter_key(language, project_uid, environment)
    target = settings.widget_pool_size if count is None else count
    target = max(settings.widget_pool_size, min(target, settings.widget_max_concurrency))

    # Provision the shared R dirs here (off the loop, memoised) so the pool's sync
    # factory below never shells out to Rscript.
    await manager._prepare_r_shared(language)

    def make() -> Kernel:
        return manager._make(language, project_uid, environment)

    _spawn_bg(warm_pool.refill(make, language, project_uid, interpreter_key, target))
