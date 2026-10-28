"""The embeddings runtime: a venv holding sentence-transformers + torch, shared by
every workspace of the instance, under ``data_dir/runtimes/embeddings/``.

Not a dependency of the API: torch is over a gigabyte and most deployments never
encode anything. It is installed on demand (one click in the app) with uv, from
the configured index (`pip_index_url`, an institution mirror in an SPE). Unless
`embeddings_torch_backend` is empty, uv picks the torch build for the machine
(`--torch-backend auto`: CUDA when an NVIDIA driver is present, CPU otherwise),
which reaches download.pytorch.org — set it empty behind a mirror that only
proxies PyPI.

Also where worker processes are started: `run_worker` streams the worker's
protocol (services/suggestions/worker.py) into a job.
"""

import asyncio
import json
import sys
import tempfile
from pathlib import Path

from app.config import settings
from app.services.execution.child_env import child_env

PACKAGES = ["sentence-transformers>=3", "huggingface_hub", "numpy", "duckdb"]
WORKER = Path(__file__).with_name("worker.py")


class WorkerError(RuntimeError):
    pass


def runtime_dir() -> Path:
    return settings.data_path / "runtimes" / "embeddings"


def venv_python() -> Path:
    venv = runtime_dir() / ".venv"
    return venv / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def _probe_path() -> Path:
    return runtime_dir() / "probe.json"


def is_installed() -> bool:
    return venv_python().is_file() and _probe_path().is_file()


def probe() -> dict | None:
    """What the last install found: torch / sentence-transformers versions and
    the devices torch can use."""
    path = _probe_path()
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def uninstall() -> None:
    import shutil

    shutil.rmtree(runtime_dir(), ignore_errors=True)


def _uv_env() -> dict[str, str]:
    env = child_env(provision=True)
    env["UV_CACHE_DIR"] = str(settings.data_path / ".cache" / "uv")
    env["UV_INDEX_URL"] = settings.pip_index_url
    return env


def worker_env(*, network: bool = False) -> dict[str, str]:
    """A worker's environment. Offline unless it downloads: sentence-transformers
    otherwise checks the Hub for updates, which in an SPE means waiting on
    timeouts. The Hub cache stays inside the data dir."""
    env = child_env(provision=network)
    env["HF_HOME"] = str(settings.data_path / ".cache" / "huggingface")
    env["PYTHONUNBUFFERED"] = "1"
    env["TOKENIZERS_PARALLELISM"] = "false"
    if network:
        if settings.hf_endpoint:
            env["HF_ENDPOINT"] = settings.hf_endpoint
    else:
        env["HF_HUB_OFFLINE"] = "1"
        env["TRANSFORMERS_OFFLINE"] = "1"
    return env


async def _stream(args: list[str], env: dict[str, str], on_line) -> int:
    proc = await asyncio.create_subprocess_exec(
        *args, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    try:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            await on_line(raw.decode("utf-8", "replace").rstrip())
        return await proc.wait()
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        raise


async def install(handle) -> dict:
    """Create the venv and install the packages, then probe it. A job body."""
    import shutil

    shutil.rmtree(runtime_dir(), ignore_errors=True)
    runtime_dir().mkdir(parents=True, exist_ok=True)
    env = _uv_env()
    tail: list[str] = []

    async def on_line(line: str) -> None:
        tail.append(line)
        del tail[:-40]
        await handle.log(line)

    steps = [
        [settings.uv_bin, "venv", "--python", f"{sys.version_info.major}.{sys.version_info.minor}",
         str(runtime_dir() / ".venv")],
        [settings.uv_bin, "pip", "install", "--python", str(venv_python()),
         *(["--torch-backend", settings.embeddings_torch_backend] if settings.embeddings_torch_backend else []),
         *PACKAGES],
    ]
    for i, args in enumerate(steps):
        await handle.log("$ " + " ".join(args))
        code = await _stream(args, env, on_line)
        if code != 0:
            raise WorkerError("\n".join(tail[-15:]) or f"{args[1]} failed")
        await handle.progress(10 if i == 0 else 90)
    found = await run_worker("probe", {}, handle=handle, python=venv_python())
    _probe_path().write_text(json.dumps(found, indent=2), encoding="utf-8")
    return found


async def run_worker(
    command: str,
    spec: dict,
    *,
    handle=None,
    python: Path | None = None,
    network: bool = False,
    checkpoints: dict | None = None,
) -> dict:
    """Run one worker command and return its result. Progress and log lines go
    to the job `handle` when there is one; cancelling kills the process.
    `checkpoints` (stage → source concepts written) is kept up to date as the
    worker reports them, so it still holds after a cancel."""
    interpreter = python or venv_python()
    if python is None and not is_installed():
        raise WorkerError("The embeddings runtime is not installed")
    with tempfile.TemporaryDirectory(prefix="linkr-embeddings-") as tmp:
        spec_path = Path(tmp) / "spec.json"
        spec_path.write_text(json.dumps(spec), encoding="utf-8")
        found: dict = {}
        tail: list[str] = []

        async def on_line(line: str) -> None:
            if line.startswith("@@progress "):
                if handle is not None:
                    try:
                        await handle.progress(int(line.split(" ", 1)[1]))
                    except ValueError:
                        pass
                return
            if line.startswith("@@result "):
                found.update(json.loads(line.split(" ", 1)[1]))
                return
            if line.startswith("@@checkpoint "):
                if checkpoints is not None:
                    point = json.loads(line.split(" ", 1)[1])
                    checkpoints[point["stage"]] = point["done"]
                return
            tail.append(line)
            del tail[:-40]
            if handle is not None and line.strip():
                await handle.log(line)

        code = await _stream(
            [str(interpreter), "-u", str(WORKER), command, str(spec_path)], worker_env(network=network), on_line,
        )
    if code != 0:
        raise WorkerError("\n".join(tail[-15:]) or f"worker {command} exited with {code}")
    return found
