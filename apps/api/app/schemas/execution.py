from datetime import datetime

from pydantic import field_validator

from app.schemas.base import CamelModel
from app.services.execution.package_spec import (
    InvalidPackageSpec,
    validate_package_specs,
)


class ExecuteRequest(CamelModel):
    language: str  # 'python' | 'r'
    code: str
    # Persistent-kernel routing. When project_uid is given, the run reuses a
    # long-lived kernel for (project, language, session) so variables persist
    # between runs. Without it, a stateless one-shot run is used.
    project_uid: str | None = None
    session_id: str = "default"
    # When set, the dataset's Parquet is loaded into the kernel as a `dataset`
    # DataFrame before the code runs (data stays server-side).
    dataset_file_id: str | None = None
    # Dashboard filters (resolved client-side to concrete predicates keyed by
    # columnId) applied to `dataset` before the code runs.
    dataset_filters: list[dict] | None = None
    # When set, sql_query() in the code runs against this data source (its id).
    connection_id: str | None = None
    # Why the code runs → which permission it needs:
    #   "dashboards"   → code-backed dashboard widget → dashboards:execute (editor+)
    #   "datasets"     → code-backed dataset analysis → datasets:execute (editor+)
    #   "patient-data" → code-backed patient-data widget → patient-data:execute
    #   "ide"          → arbitrary code in the IDE → ide:execute
    # Defaults to "ide" (strict). NOTE: built-in component renders do NOT come here —
    # they carry no free-form code and go through POST /execute/render (see
    # RenderRequest). "render" is rejected on this endpoint.
    purpose: str = "ide"
    # Optional human label for a run-as-job (POST /execute/run-as-job); ignored by
    # the interactive /execute path. E.g. the file name being run.
    label: str | None = None
    # When set, the run uses a FRESH, isolated ephemeral process (from the warm
    # pool) instead of the caller's persistent (project, language, session) kernel
    # — so dashboard widgets run in parallel, never sharing a namespace or a lock.
    ephemeral: bool = False


class PrewarmRequest(CamelModel):
    """Pre-start the warm pool for a project's language so the first ephemeral
    widget run pays no interpreter/import startup. Fire-and-forget (background)."""

    project_uid: str
    language: str  # 'python' | 'r'
    # How many warm processes to pre-start (typically the page's code-widget count).
    # Clamped server-side to [pool_size, max_concurrency].
    count: int | None = None
    # True → warm the app-interpreter pool used by built-in component renders
    # (/execute/render, environment=None), instead of the project's managed env
    # used by code widgets. The two use different pool buckets.
    app_env: bool = False


class RenderRequest(CamelModel):
    """A built-in component render (viewer-visible). Unlike ExecuteRequest it
    carries NO free-form `code`: the server owns the analysis program per `kind`
    and injects only the validated `spec`, so a viewer can't run arbitrary code."""

    kind: str  # analysis kind (table1, ...) — must be a server-known render builder
    spec: dict  # structured, per-kind config (column names + options); validated server-side
    project_uid: str | None = None
    session_id: str = "default"
    dataset_file_id: str | None = None
    dataset_filters: list[dict] | None = None


class RestartKernelRequest(CamelModel):
    language: str
    project_uid: str
    session_id: str = "default"


class RuntimeFigureResponse(CamelModel):
    id: str
    type: str  # 'svg' | 'png'
    data: str
    label: str


class RuntimeTableResponse(CamelModel):
    headers: list[str]
    rows: list[list[str]]


class ExecuteResponse(CamelModel):
    stdout: str
    stderr: str
    figures: list[RuntimeFigureResponse]
    table: RuntimeTableResponse | None
    html: str | None
    # The code raised — as opposed to merely writing to stderr, which R does for
    # warnings and messages too.
    failed: bool = False


class EnvironmentResponse(CamelModel):
    id: str
    project_uid: str
    language: str  # 'python' | 'r'
    kind: str  # 'system' | 'managed'
    status: str  # draft | building | ready | error
    interpreter_path: str | None


class PackageResponse(CamelModel):
    name: str
    spec: str  # version constraint as declared ("==2.1.4", ">=1", or "")
    # A kernel infra package (jsonlite/base64enc/svglite) in the shared kernel
    # library — shown but not removable (only updatable). User packages: False.
    system: bool = False


class AddPackagesRequest(CamelModel):
    packages: list[str]  # requirement strings, e.g. ["pandas", "numpy==1.26"]

    @field_validator("packages")
    @classmethod
    def _safe_packages(cls, v: list[str]) -> list[str]:
        # Package refs are fed to uv/renv (R via `Rscript -e` source — a raw value
        # is an injection/RCE vector). Reject anything outside the safe allowlist.
        try:
            return validate_package_specs(v)
        except InvalidPackageSpec as e:
            raise ValueError(str(e)) from e


class EnvSpecFile(CamelModel):
    name: str  # base filename, e.g. "renv.lock" / "pyproject.toml"
    content: str  # UTF-8 text of the spec file


class ImportEnvSpecRequest(CamelModel):
    """Restore a managed environment's declarative spec (manifest + lockfile) on
    disk during a project import/clone — so the versioned env travels with the
    project. Only the spec is written; the venv/library is rebuilt on demand."""

    files: list[EnvSpecFile]


class JobResponse(CamelModel):
    id: str
    project_uid: str
    kind: str  # 'build' | 'run' | …
    label: str
    status: str  # queued | running | done | error | cancelled
    progress: int
    log_tail: str
    # A 'run' job's collected artifacts: {"figures": [...], "table": {...}, "html"}.
    # None for other kinds / before completion.
    result: dict | None = None
    created_at: datetime
