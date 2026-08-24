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

from app.services.execution.render import (
    correlation_matrix,
    cox,
    kaplan_meier,
    key_indicator,
    map as map_,
    plot_builder,
    regression,
    sankey,
    statistical_tests,
    survey_question,
    table1,
)

# kind → (spec validator/normalizer, python builder). One entry per built-in
# analysis. A kind absent here is rejected by the route (unknown render kind).
# The kind strings match what the frontend components send to renderOnServer().
_BUILDERS: dict[str, tuple[Callable[[dict], dict], Callable[[dict], str]]] = {
    "table1": (table1.validate_spec, table1.build_code),
    "correlation-matrix": (correlation_matrix.validate_spec, correlation_matrix.build_code),
    "map": (map_.validate_spec, map_.build_code),
    "kaplan-meier": (kaplan_meier.validate_spec, kaplan_meier.build_code),
    "cox": (cox.validate_spec, cox.build_code),
    "sankey": (sankey.validate_spec, sankey.build_code),
    "key-indicator": (key_indicator.validate_spec, key_indicator.build_code),
    "regression": (regression.validate_spec, regression.build_code),
    "plot-builder": (plot_builder.validate_spec, plot_builder.build_code),
    "statistical-tests": (statistical_tests.validate_spec, statistical_tests.build_code),
    "survey-question": (survey_question.validate_spec, survey_question.build_code),
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
