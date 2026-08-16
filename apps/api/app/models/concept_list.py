from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class ConceptList(Base, TimestampMixin):
    """A project-scoped, user-authored list of concepts.

    Distinct from ConceptSet: a concept *set* is an imported data dictionary
    (workspace-scoped, read-only, carrying an OHDSI expression), whereas a
    concept *list* is hand-built here while browsing and travels with the
    project through export / versioning / import.
    """

    __tablename__ = "concept_lists"

    # Frontend keys concept lists by client-supplied UUID.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_uid: Mapped[str] = mapped_column(
        ForeignKey("projects.uid", ondelete="CASCADE")
    )
    # LocalizedString ({ en, fr, … }) like every other user-authored entity.
    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    description: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    # The concepts themselves, denormalized so a list stays readable even when
    # the source database is detached: [{ conceptId, conceptName, conceptCode,
    # vocabularyId, dictKey }].
    items: Mapped[list] = mapped_column(JSONB_or_JSON, default=list)
    # Which data source the concepts were picked from (informational).
    data_source_id: Mapped[str | None] = mapped_column(String(36))
    version: Mapped[str] = mapped_column(String(20), default="0.1.0", server_default="0.1.0")
