"""Server-side execution output contract — the counterpart to the browser's
Pyodide / WebR engines (see docs/planning/fullstack-storage-plan.html §06).

The streaming kernels (kernel.py) produce a ``RuntimeOutput`` mirroring the
browser engines' capture contract:

    {stdout, stderr, figures: [{type, data, label}], table: {headers, rows} | null, html}
"""

from dataclasses import dataclass, field


@dataclass
class RuntimeOutput:
    """Mirror of the frontend RuntimeOutput type (lib/runtimes/types.ts)."""

    stdout: str = ""
    stderr: str = ""
    figures: list[dict] = field(default_factory=list)
    table: dict | None = None
    html: str | None = None
    # The code raised. Distinct from a non-empty stderr, which R writes for plain
    # warnings and messages too — a caller that stops a sequence on failure (the
    # notebook's Run all) needs to tell a warning from a real error.
    failed: bool = False


class ExecutionError(Exception):
    """A run could not be carried out (timeout, missing interpreter, harness crash)."""
