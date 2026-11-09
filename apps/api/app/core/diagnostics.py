"""Thread dumps, for a server stuck where no log reaches: the Python stack of
every thread (file, line, function — never a value), appended to
`data_dir/diagnostics/threads.log`.

Written on `kill -USR1 <pid>` (the worker's pid), and by itself when a query
ignores its interrupt (query_cancel) — a dump taken then shows where it hangs.
"""

import faulthandler
import logging
import signal
from datetime import UTC, datetime
from pathlib import Path
from typing import TextIO

from app.config import settings

logger = logging.getLogger(__name__)

_file: TextIO | None = None


def dump_path() -> Path:
    return settings.data_path / "diagnostics" / "threads.log"


def _open() -> TextIO:
    # Kept open: faulthandler writes to its descriptor from a signal handler.
    global _file
    if _file is None or _file.closed:
        path = dump_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        _file = open(path, "a", buffering=1)  # noqa: SIM115 — must outlive this call
    return _file


def install() -> None:
    """Dump on SIGUSR1 (none on Windows)."""
    if hasattr(signal, "SIGUSR1"):
        faulthandler.register(signal.SIGUSR1, file=_open(), all_threads=True)


def dump(reason: str) -> None:
    """Append every thread's stack, headed by `reason`."""
    try:
        out = _open()
        out.write(f"\n=== {datetime.now(UTC).isoformat()} {reason}\n")
        out.flush()
        faulthandler.dump_traceback(file=out, all_threads=True)
    except OSError as e:
        logger.warning("thread dump failed: %s", e)
