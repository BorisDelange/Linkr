"""Server-side R/Python execution — the counterpart to the browser's Pyodide /
WebR engines (see docs/planning/fullstack-storage-plan.html §06).

A run happens in a throwaway working directory as a subprocess with a hard
wall-clock timeout. The subprocess wraps the user's code in a harness that
mirrors the browser engines' capture contract exactly, and writes a single JSON
``RuntimeOutput`` to ``_linkr_output.json``:

    {stdout, stderr, figures: [{type, data, label}], table: {headers, rows} | null, html}

Isolation is process-level (fresh cwd, timeout) — sufficient for the trusted,
authenticated CHU deployment (RStudio Workbench model). Stronger sandboxing
(cpu/mem quotas, seccomp) is a later hardening pass, not a blocker.
"""

import asyncio
import json
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from app.config import settings

_OUTPUT_FILE = "_linkr_output.json"
_USER_FILE = "_linkr_user_code.py"
_HARNESS_FILE = "_linkr_harness.py"
_R_USER_FILE = "_linkr_user_code.R"
_R_HARNESS_FILE = "_linkr_harness.R"


@dataclass
class RuntimeOutput:
    """Mirror of the frontend RuntimeOutput type (lib/runtimes/types.ts)."""

    stdout: str = ""
    stderr: str = ""
    figures: list[dict] = field(default_factory=list)
    table: dict | None = None
    html: str | None = None


class ExecutionError(Exception):
    """A run could not be carried out (timeout, missing interpreter, harness crash)."""


# The Python harness runs user code with exec() so a trailing expression is not
# auto-printed; we capture a `result` variable (or the last DataFrame) as a table,
# matching pyodide-engine._linkr_capture_table. matplotlib figures -> SVG, as in
# _linkr_get_figures.
_PY_HARNESS = '''\
import sys, io, json, traceback

_out, _err = io.StringIO(), io.StringIO()
figures, table, html = [], None, None

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
        headers = [str(c) for c in obj.columns]
        rows = obj.head(1000).astype(str).values.tolist()
        return {"headers": headers, "rows": rows}
    return None


_real_out, _real_err = sys.stdout, sys.stderr
sys.stdout, sys.stderr = _out, _err
_ns = {"__name__": "__main__"}
try:
    with open("''' + _USER_FILE + '''", "r", encoding="utf-8") as fh:
        _code = fh.read()
    exec(compile(_code, "<analysis>", "exec"), _ns)
    table = _capture_table(_ns.get("result"))
    if plt is not None:
        for num in plt.get_fignums():
            buf = io.BytesIO()
            plt.figure(num).savefig(buf, format="svg", bbox_inches="tight")
            figures.append({
                "type": "svg",
                "data": buf.getvalue().decode("utf-8"),
                "label": "Figure " + str(num),
            })
        plt.close("all")
except Exception:
    traceback.print_exc()
finally:
    sys.stdout, sys.stderr = _real_out, _real_err

with open("''' + _OUTPUT_FILE + '''", "w", encoding="utf-8") as fh:
    json.dump({
        "stdout": _out.getvalue(),
        "stderr": _err.getvalue(),
        "figures": figures,
        "table": table,
        "html": html,
    }, fh)
'''


# The R harness opens an SVG graphics device writing one file per plot page,
# sources the user file (Rscript autoprints to stdout, mirroring WebR's
# withAutoprint), then closes the device. Prefer svglite (standalone, the same
# writer WebR uses) and fall back to the base cairo svg() device — svglite avoids
# the X11/cairo shared-library dependency that the built-in device needs. User
# errors surface on stderr via message().
#
# Geometry must match WebR's client device so a plugin's absolute sizes (base_size,
# margins, point/text sizes) render the same in both modes. WebR uses a 2016×2016 px
# canvas at pointsize 24 (webr-engine.ts: 1008 × R_PLOT_SCALE=2). svglite sizes in
# inches at 72 px/in, so 28×28 in @ pointsize 24 reproduces that exact 2016 px square;
# a small landscape device (the old 8×6) made large base_size text overflow and overlap.
_R_HARNESS = '''\
.linkr_dev_open <- function() {
  if (requireNamespace("svglite", quietly = TRUE)) {
    svglite::svglite(filename = "_linkr_plot_%03d.svg", width = 28, height = 28, pointsize = 24)
    return(TRUE)
  }
  tryCatch({
    grDevices::svg("_linkr_plot_%03d.svg", onefile = FALSE, width = 28, height = 28, pointsize = 24)
    TRUE
  }, error = function(e) FALSE)
}
.linkr_have_dev <- .linkr_dev_open()
tryCatch(
  source("''' + _R_USER_FILE + '''", echo = FALSE, print.eval = TRUE),
  error = function(e) message(conditionMessage(e))
)
if (.linkr_have_dev) invisible(grDevices::dev.off())
'''


async def run_python(code: str) -> RuntimeOutput:
    if not settings.enable_code_execution:
        raise ExecutionError("Code execution is disabled on this server.")

    workdir = Path(tempfile.mkdtemp(prefix="linkr-exec-"))
    try:
        (workdir / _USER_FILE).write_text(code, encoding="utf-8")
        (workdir / _HARNESS_FILE).write_text(_PY_HARNESS, encoding="utf-8")
        _, stderr = await _run_subprocess([sys_executable(), _HARNESS_FILE], workdir)
        # The harness always writes _OUTPUT_FILE, even on user error (traps
        # exceptions into stderr). No output means the harness itself crashed.
        if not (workdir / _OUTPUT_FILE).exists():
            raise ExecutionError(stderr or "Execution failed.")
        return _read_output(workdir)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


async def run_r(code: str) -> RuntimeOutput:
    if not settings.enable_code_execution:
        raise ExecutionError("Code execution is disabled on this server.")

    workdir = Path(tempfile.mkdtemp(prefix="linkr-exec-"))
    try:
        (workdir / _R_USER_FILE).write_text(code, encoding="utf-8")
        (workdir / _R_HARNESS_FILE).write_text(_R_HARNESS, encoding="utf-8")
        stdout, stderr = await _run_subprocess(
            ["Rscript", "--vanilla", _R_HARNESS_FILE], workdir
        )
        # Rscript autoprints to stdout; figures are the SVG files the harness
        # opened. Skip blank pages (an unused device can leave an empty file).
        figures = []
        for p in sorted(workdir.glob("_linkr_plot_*.svg")):
            svg = p.read_text(encoding="utf-8")
            if "<svg" in svg:
                figures.append(
                    {"type": "svg", "data": svg, "label": f"Plot {len(figures) + 1}"}
                )
        return RuntimeOutput(stdout=stdout, stderr=stderr, figures=figures)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


async def _run_subprocess(cmd: list[str], workdir: Path) -> tuple[str, str]:
    """Run cmd in workdir with a wall-clock timeout; return (stdout, stderr)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(workdir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as e:
        raise ExecutionError(f"Interpreter not found: {cmd[0]}") from e

    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=settings.execution_timeout_seconds
        )
    except asyncio.TimeoutError as e:
        proc.kill()
        await proc.wait()
        raise ExecutionError(
            f"Execution exceeded the {settings.execution_timeout_seconds}s time limit."
        ) from e

    return (
        (stdout or b"").decode("utf-8", "replace"),
        (stderr or b"").decode("utf-8", "replace"),
    )


def _read_output(workdir: Path) -> RuntimeOutput:
    path = workdir / _OUTPUT_FILE
    if not path.exists():
        raise ExecutionError("Execution produced no output.")
    data = json.loads(path.read_text(encoding="utf-8"))
    return RuntimeOutput(
        stdout=data.get("stdout", ""),
        stderr=data.get("stderr", ""),
        figures=data.get("figures", []),
        table=data.get("table"),
        html=data.get("html"),
    )


def sys_executable() -> str:
    import sys

    return sys.executable
