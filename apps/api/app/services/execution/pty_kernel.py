"""Interactive shell sessions backed by a real pseudo-terminal (PTY).

The R/Python kernels (kernel.py) speak a request/response protocol: one code
blob in, one structured result out. A Bash terminal is different in kind — it is
a continuous interactive session where the client sends raw keystrokes and the
shell streams raw bytes back (echo, line editing, colors, prompts, ncurses apps
like top all handled by the terminal, not us). So a shell gets a PTY, not the
kernel loop: `bash -i` attached to a pseudo-terminal, exactly the RStudio/Jupyter
"Terminal" tab model.

This exposes an arbitrary shell with the server process's own privileges. That is
intentional and matches Jupyter/RStudio; access is gated by Linkr's application
permissions (who may open a project terminal), not by hiding the feature. The PTY
runs with the project directory as cwd (storage plan §05) so scripts/ and
datasets/ are reachable by readable relative paths.
"""

import asyncio
import fcntl
import os
import signal
import struct
import termios

from app.services import project_fs


class PtyShell:
    """A `bash -i` session behind a PTY. Raw bytes in (keystrokes), raw bytes out
    (terminal output). Unlike Kernel there is no per-command lock or framing: the
    shell owns the interaction, we just pump bytes."""

    def __init__(self, cwd: str):
        self._cwd = cwd
        self._pid: int | None = None
        self._fd: int | None = None

    @property
    def alive(self) -> bool:
        if self._pid is None:
            return False
        try:
            pid, _ = os.waitpid(self._pid, os.WNOHANG)
        except ChildProcessError:
            return False
        return pid == 0  # 0 -> still running

    def start(self) -> None:
        if self._pid is not None:
            return
        pid, fd = os.forkpty()
        if pid == 0:
            # Child: become the shell. os.forkpty already made the PTY our
            # controlling terminal and wired std{in,out,err} to it.
            try:
                os.chdir(self._cwd)
            except OSError:
                pass
            os.environ["TERM"] = "xterm-256color"
            # -i for an interactive shell (prompt, job control); exec replaces
            # this child so the shell is reaped directly.
            os.execvp("bash", ["bash", "-i"])
            os._exit(127)  # unreachable unless exec fails
        self._pid = pid
        self._fd = fd
        os.set_blocking(fd, False)

    def write(self, data: bytes) -> None:
        """Feed raw keystrokes to the shell. Ctrl+C is just byte 0x03 in `data` —
        the PTY line discipline turns it into SIGINT, so interruption is native."""
        if self._fd is not None:
            os.write(self._fd, data)

    def resize(self, rows: int, cols: int) -> None:
        """Match the shell's window size to the browser terminal so line wrapping
        and full-screen apps render correctly."""
        if self._fd is None:
            return
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(self._fd, termios.TIOCSWINSZ, winsize)

    async def read(self) -> bytes:
        """Await the next burst of output bytes. Returns b"" at EOF (shell exit)."""
        if self._fd is None:
            return b""
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[bytes] = loop.create_future()

        def _on_readable() -> None:
            loop.remove_reader(self._fd)
            if fut.done():
                return
            try:
                data = os.read(self._fd, 65536)
            except OSError:
                data = b""  # PTY closed (shell exited)
            fut.set_result(data)

        loop.add_reader(self._fd, _on_readable)
        try:
            return await fut
        finally:
            # Reader may already be gone if the future resolved; removing twice is safe.
            loop.remove_reader(self._fd)

    def shutdown(self) -> None:
        if self._pid is not None:
            try:
                os.kill(self._pid, signal.SIGKILL)
                os.waitpid(self._pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
            self._pid = None
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None


class PtyManager:
    """Live PTY shells keyed by (project_uid, session_id). A shell is a stateful
    interactive session, so each WebSocket connection gets its own — no sharing,
    unlike the code kernels whose whole point is a shared namespace."""

    def __init__(self):
        self._shells: dict[tuple[str, str], PtyShell] = {}

    def create(self, project_uid: str, session_id: str) -> PtyShell:
        cwd = str(project_fs.project_dir(project_uid))
        shell = PtyShell(cwd)
        shell.start()
        self._shells[(project_uid, session_id)] = shell
        return shell

    def close(self, project_uid: str, session_id: str) -> None:
        shell = self._shells.pop((project_uid, session_id), None)
        if shell is not None:
            shell.shutdown()

    def shutdown_all(self) -> None:
        for shell in self._shells.values():
            shell.shutdown()
        self._shells.clear()


manager = PtyManager()
