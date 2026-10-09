"""Code completion for the IDE editors: asks the user's live kernel (which knows
the session's variables) and, for Python, falls back to a static jedi pass over
the text when no kernel is running or it is busy with a run.

Items share one shape for both languages: ``label`` (shown), ``insert`` (text
that replaces the typed part), ``kind`` and ``typed`` (how many characters
before the cursor the insertion replaces)."""

from __future__ import annotations

import asyncio
import os
import sys
import sysconfig
import threading
from concurrent.futures import ThreadPoolExecutor
from functools import cache

from app.services.execution.kernel import Kernel

_MAX_ITEMS = 300


def _python_items(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        return []
    return [
        {"label": it["label"], "insert": it["label"], "kind": it.get("kind", ""), "typed": int(it.get("typed", 0))}
        for it in raw
        if isinstance(it, dict) and isinstance(it.get("label"), str)
    ]


# `df$col`, `pkg::fn`, `obj@slot`: R completes the whole token, but the list
# should show only what follows the accessor.
_R_ACCESSORS = (":::", "::", "$", "@")


def _r_label(completion: str) -> str:
    cut = max((completion.rfind(a) + len(a) for a in _R_ACCESSORS if a in completion), default=0)
    return completion[cut:] or completion


def _r_items(raw: object) -> list[dict]:
    if not isinstance(raw, dict):
        return []
    token = raw.get("token") or ""
    comps = raw.get("completions") or []
    if isinstance(comps, str):
        comps = [comps]
    if not isinstance(token, str) or not isinstance(comps, list):
        return []
    items = []
    for c in comps:
        if not isinstance(c, str):
            continue
        kind = "argument" if c.endswith("=") else "function" if c.endswith("(") else ""
        items.append({"label": _r_label(c), "insert": c, "kind": kind, "typed": len(token)})
    return items


@cache
def _static_jedi():
    """jedi in a subprocess of the base interpreter, seeing only the standard
    library: the API's own process and environment (its packages, the `app`
    package, any compiled module installed there) stay out of the user's reach.
    None outside a venv, where the base interpreter is the API's own."""
    if sys.prefix == sys.base_prefix:
        return None
    try:
        import jedi

        env = jedi.create_environment(
            sys._base_executable, safe=False,
            env_vars={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONNOUSERSITE": "1"},
        )
    except Exception:  # noqa: BLE001 — jedi missing or the base interpreter unusable: no static pass
        return None
    stdlib = sysconfig.get_paths(vars={"base": sys.base_prefix, "platbase": sys.base_prefix,
                                       "installed_base": sys.base_prefix,
                                       "installed_platbase": sys.base_prefix})
    sys_path = sorted({stdlib["stdlib"], stdlib["platstdlib"], os.path.join(stdlib["platstdlib"], "lib-dynload")})
    return env, jedi.Project(stdlib["stdlib"], sys_path=sys_path, smart_sys_path=False)


# One jedi subprocess serves every request, and its pipe is not thread-safe.
# Held from dispatch to the end of the call: a request arriving meanwhile gets
# nothing rather than queueing behind a slow one. Its own thread, so a slow
# call never holds one of the default executor's (shared with count units).
_static_lock = threading.Lock()
_static_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="jedi-static")
# The first call indexes the standard library, so allow for a cold start.
_STATIC_TIMEOUT_SECONDS = 10.0


def _kill_static_jedi() -> None:
    """End a hung jedi subprocess: the blocked call then fails (and returns
    nothing), and the next one starts a fresh subprocess. Reaches into jedi's
    private API, so any mismatch just leaves the call to finish on its own."""
    setup = _static_jedi()
    subprocess = getattr(setup[0], "_subprocess", None) if setup else None
    kill = getattr(subprocess, "_kill", None)
    if callable(kill):
        kill()


# Twins: `_complete` in kernel.py (live kernel) and completePython in
# apps/web/src/lib/runtimes/pyodide-engine.ts.
def _python_static(code: str, cursor: int) -> list[dict]:
    setup = _static_jedi()
    if setup is None:
        return []
    import jedi

    env, project = setup
    before = code[:cursor]
    line = before.count("\n") + 1
    col = len(before) - (before.rfind("\n") + 1)
    try:
        found = jedi.Script(code, environment=env, project=project).complete(line, col)[:_MAX_ITEMS]
    except Exception:  # noqa: BLE001 — jedi raises on odd input; no completion then
        return []
    return [
        {"label": c.name, "insert": c.name, "kind": c.type, "typed": len(c.name) - len(c.complete)}
        for c in found
    ]


async def _python_static_if_idle(code: str, cursor: int) -> list[dict]:
    if not _static_lock.acquire(blocking=False):
        return []
    try:
        future = _static_executor.submit(_python_static, code, cursor)
    except BaseException:
        _static_lock.release()
        raise
    # A done callback, not a `finally` in the worker: a call cancelled before the
    # worker starts never runs it, and would keep the lock forever.
    future.add_done_callback(lambda _: _static_lock.release())
    try:
        return await asyncio.wait_for(asyncio.wrap_future(future), _STATIC_TIMEOUT_SECONDS)
    except TimeoutError:
        _kill_static_jedi()
        return []


async def complete(kernel: Kernel | None, language: str, code: str, cursor: int) -> list[dict]:
    cursor = max(0, min(cursor, len(code)))
    raw = await kernel.complete(code, cursor) if kernel is not None else None
    if language == "python":
        if raw is not None:
            return _python_items(raw)[:_MAX_ITEMS]
        return await _python_static_if_idle(code, cursor)
    if language == "r" and raw is not None:
        return _r_items(raw)[:_MAX_ITEMS]
    return []
