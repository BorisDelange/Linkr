"""The server boots on a host without pseudo-terminals (Windows): only the
terminal itself is refused."""

import subprocess
import sys
from pathlib import Path

_WITHOUT_PTY = """
import asyncio, sys
sys.modules.update(fcntl=None, pty=None, termios=None)
import app.main
from app.services.execution import pty_kernel
assert not pty_kernel.SUPPORTED
try:
    asyncio.run(pty_kernel.manager.create("p", "s", 1))
except pty_kernel.TerminalUnsupported:
    print("refused")
"""


def test_api_imports_without_pty_modules():
    out = subprocess.run(
        [sys.executable, "-c", _WITHOUT_PTY],
        cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip().endswith("refused")
