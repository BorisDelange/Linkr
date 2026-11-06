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
import contextlib
import json
import shutil
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path

from app.config import settings
from app.services.execution.child_env import child_env

# torch 2.6 / transformers 4.50 are the first to load weights with torch.load's
# weights_only, which refuses to run code from a pickle.
PACKAGES = ["sentence-transformers>=3", "torch>=2.6", "transformers>=4.50", "huggingface_hub", "numpy", "duckdb"]
WORKER = Path(__file__).with_name("worker.py")


class WorkerError(RuntimeError):
    pass


def runtime_dir() -> Path:
    return settings.data_path / "runtimes" / "embeddings"


def venv_python(root: Path | None = None) -> Path:
    venv = (root or runtime_dir()) / ".venv"
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


_install_lock = asyncio.Lock()
_workers = 0


class RuntimeInUse(WorkerError):
    pass


def in_use() -> bool:
    """Whether a worker runs on the installed runtime, for any workspace."""
    return _workers > 0


@contextlib.contextmanager
def worker_running() -> Iterator[None]:
    global _workers
    _workers += 1
    try:
        yield
    finally:
        _workers -= 1


async def install(handle) -> dict:
    """Build a new runtime and put it in place of the installed one, then probe it. A
    job body. The installed one serves every workspace until the new one works."""
    async with _install_lock:
        return await _build_and_swap(handle)


async def ensure_installed(handle) -> None:
    async with _install_lock:
        if not is_installed():
            await _build_and_swap(handle)


def _refuse_in_use() -> None:
    if in_use():
        raise RuntimeInUse("The embeddings runtime is in use: try again once the running jobs have ended")


async def _build_and_swap(handle) -> dict:
    _refuse_in_use()
    staging = runtime_dir().with_name(runtime_dir().name + ".new")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    env = _uv_env()
    tail: list[str] = []

    async def on_line(line: str) -> None:
        tail.append(line)
        del tail[:-40]
        await handle.log(line)

    steps = [
        [settings.uv_bin, "venv", "--python", f"{sys.version_info.major}.{sys.version_info.minor}",
         str(staging / ".venv")],
        [settings.uv_bin, "pip", "install", "--python", str(venv_python(staging)),
         *(["--torch-backend", settings.embeddings_torch_backend] if settings.embeddings_torch_backend else []),
         *PACKAGES],
    ]
    try:
        for i, args in enumerate(steps):
            await handle.log("$ " + " ".join(args))
            code = await _stream(args, env, on_line)
            if code != 0:
                raise WorkerError("\n".join(tail[-15:]) or f"{args[1]} failed")
            await handle.progress(10 if i == 0 else 90)
        found = await run_worker("probe", {}, handle=handle, python=venv_python(staging))
        (staging / _probe_path().name).write_text(json.dumps(found, indent=2), encoding="utf-8")
        # A worker may have started on the installed runtime during the build.
        _refuse_in_use()
        retired = runtime_dir().with_name(runtime_dir().name + ".old")
        shutil.rmtree(retired, ignore_errors=True)
        if runtime_dir().exists():
            runtime_dir().rename(retired)
        staging.rename(runtime_dir())
        shutil.rmtree(retired, ignore_errors=True)
        return found
    finally:
        shutil.rmtree(staging, ignore_errors=True)


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
    `checkpoints` (stage → source concepts written, and `bytes`: method → its
    file's size then) is kept up to date as the worker reports them, so it still holds after a cancel."""
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
                    checkpoints.setdefault("bytes", {}).update(point.get("bytes") or {})
                return
            tail.append(line)
            del tail[:-40]
            if handle is not None and line.strip():
                await handle.log(line)

        args = [str(interpreter), "-u", str(WORKER), command, str(spec_path)]
        if interpreter == venv_python():
            with worker_running():
                code = await _stream(args, worker_env(network=network), on_line)
        else:
            code = await _stream(args, worker_env(network=network), on_line)
    if code != 0:
        raise WorkerError("\n".join(tail[-15:]) or f"worker {command} exited with {code}")
    return found
