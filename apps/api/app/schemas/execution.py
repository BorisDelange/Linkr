from app.schemas.base import CamelModel


class ExecuteRequest(CamelModel):
    language: str  # 'python' | 'r'
    code: str


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
