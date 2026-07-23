"""Interactive shell sessions backed by a real pseudo-terminal (PTY).

The R/Python kernels (kernel.py) speak a request/response protocol: one code
blob in, one structured result out. A Bash terminal is different in kind — it is
a continuous interactive session where the client sends raw keystrokes and the
shell streams raw bytes back (echo, line editing, colors, prompts, ncurses apps
like top all handled by the terminal, not us). So a shell gets a PTY, not the
kernel loop: `bash -i` wired to a pseudo-terminal, exactly the RStudio/Jupyter
"Terminal" tab model.

Crucially we do NOT os.forkpty() the server: forking a multi-threaded asyncio
process (uvicorn worker + DB pool + event loop) is a classic deadlock. Instead we
allocate a PTY with pty.openpty() and hand its slave end to bash via
asyncio.create_subprocess_exec, so only /bin/bash is fork/exec'd — the
interpreter is never forked. The master fd is driven with the event loop's
add_reader, staying fully async.

This exposes an arbitrary shell with the server process's own privileges. That is
intentional and matches Jupyter/RStudio; access is gated by Linkr's application
permissions (who may open a project terminal), not by hiding the feature. The PTY
runs with the project directory as cwd (storage plan §05) so scripts/ and
datasets/ are reachable by readable relative paths.
"""

import asyncio
import fcntl
import os
import pty
import struct
import termios

from app.services import project_fs


class PtyShell:
    """A `bash -i` session behind a PTY. Raw bytes in (keystrokes), raw bytes out
    (terminal output). Unlike Kernel there is no per-command lock or framing: the
    shell owns the interaction, we just pump bytes."""

    def __init__(self, cwd: str, extra_env: dict[str, str] | None = None):
        self._cwd = cwd
        self._extra_env = extra_env or {}
        self._proc: asyncio.subprocess.Process | None = None
        self._master_fd: int | None = None

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    async def start(self) -> None:
        if self._proc is not None:
            return
        master_fd, slave_fd = pty.openpty()
        env = dict(os.environ, TERM="xterm-256color", **self._extra_env)
        try:
            # Only bash is fork/exec'd (by asyncio); the server process is never
            # forked. The slave end becomes bash's controlling terminal via
            # start_new_session + stdio wiring.
            self._proc = await asyncio.create_subprocess_exec(
                "bash",
                "-i",
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                cwd=self._cwd,
                env=env,
                start_new_session=True,
            )
        finally:
            # The child holds its own dup of the slave; the parent doesn't need it.
            os.close(slave_fd)
        os.set_blocking(master_fd, False)
        self._master_fd = master_fd

    def write(self, data: bytes) -> None:
        """Feed raw keystrokes to the shell. Ctrl+C is just byte 0x03 in `data` —
        the PTY line discipline turns it into SIGINT, so interruption is native."""
        if self._master_fd is not None:
            try:
                os.write(self._master_fd, data)
            except OSError:
                pass

    def resize(self, rows: int, cols: int) -> None:
        """Match the shell's window size to the browser terminal so line wrapping
        and full-screen apps render correctly."""
        if self._master_fd is None:
            return
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        try:
            fcntl.ioctl(self._master_fd, termios.TIOCSWINSZ, winsize)
        except OSError:
            pass

    async def read(self) -> bytes:
        """Await the next burst of output bytes. Returns b"" at EOF (shell exit)."""
        if self._master_fd is None:
            return b""
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[bytes] = loop.create_future()
        fd = self._master_fd

        def _on_readable() -> None:
            loop.remove_reader(fd)
            if fut.done():
                return
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""  # PTY closed (shell exited)
            fut.set_result(data)

        loop.add_reader(fd, _on_readable)
        try:
            return await fut
        finally:
            loop.remove_reader(fd)

    def shutdown(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            try:
                self._proc.kill()
            except ProcessLookupError:
                pass
        self._proc = None
        if self._master_fd is not None:
            try:
                os.close(self._master_fd)
            except OSError:
                pass
            self._master_fd = None


class SessionLimitReached(Exception):
    """A user has hit max_sessions_per_user concurrent terminal shells."""


class PtyManager:
    """Live PTY shells keyed by (project_uid, session_id). A shell is a stateful
    interactive session, so each WebSocket connection gets its own — no sharing,
    unlike the code kernels whose whole point is a shared namespace.

    Each shell is an OS process; an unbounded number per user would exhaust
    server processes/memory, so concurrent shells are capped per user."""

    def __init__(self):
        self._shells: dict[tuple[str, str], PtyShell] = {}
        self._owner: dict[tuple[str, str], int] = {}

    def _count_for_user(self, user_id: int) -> int:
        return sum(1 for uid in self._owner.values() if uid == user_id)

    async def create(self, project_uid: str, session_id: str, user_id: int) -> PtyShell:
        from app.config import settings

        if self._count_for_user(user_id) >= settings.max_sessions_per_user:
            raise SessionLimitReached(
                f"Terminal session limit reached ({settings.max_sessions_per_user})."
            )
        cwd = str(project_fs.scripts_dir(project_uid))
        shell = PtyShell(cwd, extra_env=project_fs.runtime_env(project_uid))
        await shell.start()
        key = (project_uid, session_id)
        self._shells[key] = shell
        self._owner[key] = user_id
        return shell

    def close(self, project_uid: str, session_id: str) -> None:
        key = (project_uid, session_id)
        shell = self._shells.pop(key, None)
        self._owner.pop(key, None)
        if shell is not None:
            shell.shutdown()

    def shutdown_all(self) -> None:
        for shell in self._shells.values():
            shell.shutdown()
        self._shells.clear()
        self._owner.clear()


manager = PtyManager()
