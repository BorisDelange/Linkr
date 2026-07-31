from app.schemas.base import CamelModel


class ExecuteRequest(CamelModel):
    language: str  # 'python' | 'r'
    code: str
    # Persistent-kernel routing. When project_uid is given, the run reuses a
    # long-lived kernel for (project, language, env) so variables persist between
    # runs. Without it, a stateless one-shot run is used.
    project_uid: str | None = None
    env_id: str = "default"
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


class RenderRequest(CamelModel):
    """A built-in component render (viewer-visible). Unlike ExecuteRequest it
    carries NO free-form `code`: the server owns the analysis program per `kind`
    and injects only the validated `spec`, so a viewer can't run arbitrary code."""

    kind: str  # analysis kind (table1, ...) — must be a server-known render builder
    spec: dict  # structured, per-kind config (column names + options); validated server-side
    project_uid: str | None = None
    env_id: str = "default"
    dataset_file_id: str | None = None
    dataset_filters: list[dict] | None = None


class RestartKernelRequest(CamelModel):
    language: str
    project_uid: str
    env_id: str = "default"


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


class AddPackagesRequest(CamelModel):
    packages: list[str]  # requirement strings, e.g. ["pandas", "numpy==1.26"]
