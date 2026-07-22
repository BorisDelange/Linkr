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


class ExecutionError(Exception):
    """A run could not be carried out (timeout, missing interpreter, harness crash)."""
