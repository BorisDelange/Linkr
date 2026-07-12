"""Server-owned code for built-in component renders (purpose="render").

A render is a VIEW operation a viewer may trigger, so the code that runs MUST NOT
come from the client — otherwise a viewer could send arbitrary Python under the
weak `project-summary:read` gate (the /execute render hole). Instead the client
sends a structured `spec` (analysis kind + column names + options); the server
holds the static analysis program per kind and injects only the validated spec.

Each builder returns the Python to run AFTER the dataset-injection preamble (which
binds `dataset`), mirroring what the frontend `*-server.ts` builders used to emit.
The spec is embedded as a JSON string parsed with `_json.loads` — data, never
spliced into Python source (same discipline as injection.py).
"""

from collections.abc import Callable

from app.services.execution.render import table1

# kind → (spec validator/normalizer, python builder). Add one entry per migrated
# analysis. A kind absent here is rejected by the route (unknown render kind).
_BUILDERS: dict[str, tuple[Callable[[dict], dict], Callable[[dict], str]]] = {
    "table1": (table1.validate_spec, table1.build_code),
}


def is_known_kind(kind: str) -> bool:
    return kind in _BUILDERS


def build_render_code(kind: str, spec: dict) -> str:
    """Validate the client spec for `kind` and return the Python to run (excluding
    the dataset preamble, which the caller prepends). Raises ValueError on an
    unknown kind or an invalid spec."""
    entry = _BUILDERS.get(kind)
    if entry is None:
        raise ValueError(f"unknown render kind: {kind}")
    validate, build = entry
    return build(validate(spec))
