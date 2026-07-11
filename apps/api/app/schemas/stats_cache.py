from app.schemas.base import CamelModel


class StatsCacheSave(CamelModel):
    computed_at: str
    payload: dict


class StatsCacheResponse(CamelModel):
    computed_at: str
    payload: dict
