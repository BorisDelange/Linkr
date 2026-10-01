"""Code completion for the IDE editors: asks the user's live kernel (which knows
the session's variables) and, for Python, falls back to a static jedi pass over
the text when no kernel is running or it is busy with a run.

Items share one shape for both languages: ``label`` (shown), ``insert`` (text
that replaces the typed part), ``kind`` and ``typed`` (how many characters
before the cursor the insertion replaces)."""

from __future__ import annotations

import asyncio

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


def _python_static(code: str, cursor: int) -> list[dict]:
    try:
        import jedi
    except ImportError:
        return []
    before = code[:cursor]
    line = before.count("\n") + 1
    col = len(before) - (before.rfind("\n") + 1)
    try:
        # In-process: the default environment would spawn a subprocess per call.
        found = jedi.Script(code, environment=jedi.InterpreterEnvironment()).complete(line, col)[:_MAX_ITEMS]
    except Exception:  # noqa: BLE001 — jedi raises on odd input; no completion then
        return []
    return [
        {"label": c.name, "insert": c.name, "kind": c.type, "typed": len(c.name) - len(c.complete)}
        for c in found
    ]


async def complete(kernel: Kernel | None, language: str, code: str, cursor: int) -> list[dict]:
    cursor = max(0, min(cursor, len(code)))
    raw = await kernel.complete(code, cursor) if kernel is not None else None
    if language == "python":
        if raw is not None:
            return _python_items(raw)[:_MAX_ITEMS]
        return await asyncio.to_thread(_python_static, code, cursor)
    if language == "r" and raw is not None:
        return _r_items(raw)[:_MAX_ITEMS]
    return []
