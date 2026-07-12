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
    # Why the code runs. "ide" = author running code in the IDE → needs
    # ide:execute. "widget" = rendering a dashboard/patient-data widget (the code
    # is author-defined, not typed at view time) → a viewer must be able to see it,
    # so it only needs read access to the project. Defaults to "ide" (strict).
    purpose: str = "ide"


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
