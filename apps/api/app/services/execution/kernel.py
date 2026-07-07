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

_ns = {"__name__": "__main__"}
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


for line in sys.stdin:
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


class Kernel:
    """One persistent interpreter process. Serialises requests (one at a time)."""

    def __init__(self, cmd: list[str]):
        self._cmd = cmd
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self.busy = False

    async def _ensure_started(self) -> asyncio.subprocess.Process:
        if self._proc is not None and self._proc.returncode is None:
            return self._proc
        self._proc = await asyncio.create_subprocess_exec(
            *self._cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        return self._proc

    async def execute(self, code: str) -> RuntimeOutput:
        async with self._lock:
            proc = await self._ensure_started()
            assert proc.stdin is not None and proc.stdout is not None
            self.busy = True
            try:
                payload = base64.b64encode(code.encode("utf-8")) + b"\n"
                proc.stdin.write(payload)
                await proc.stdin.drain()
                line = await asyncio.wait_for(
                    proc.stdout.readline(),
                    timeout=settings.execution_timeout_seconds,
                )
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

    async def shutdown(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            self._proc.kill()
            await self._proc.wait()
        self._proc = None


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

    def _make(self, language: str) -> Kernel:
        if language == "python":
            import sys

            return Kernel([sys.executable, "-c", _PY_KERNEL_LOOP])
        raise ExecutionError(f"No persistent kernel for language: {language}")


manager = KernelManager()
