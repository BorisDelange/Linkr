from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.patient_dashboard import (
    PatientDashboard,
    PatientDashboardTab,
    PatientDashboardWidget,
)
from app.schemas.patient_dashboard import (
    PatientDashboardCreate,
    PatientDashboardTabCreate,
    PatientDashboardTabUpdate,
    PatientDashboardUpdate,
    PatientDashboardWidgetCreate,
    PatientDashboardWidgetUpdate,
)


# --- Boards -----------------------------------------------------------------


async def list_for_project(db: AsyncSession, project_uid: str) -> list[PatientDashboard]:
    result = await db.execute(
        select(PatientDashboard).where(PatientDashboard.project_uid == project_uid)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, dashboard_id: str) -> PatientDashboard | None:
    return await db.get(PatientDashboard, dashboard_id)


async def create(db: AsyncSession, data: PatientDashboardCreate) -> PatientDashboard:
    dashboard = PatientDashboard(**data.model_dump(exclude_unset=True))
    db.add(dashboard)
    await db.commit()
    await db.refresh(dashboard)
    return dashboard


async def update(
    db: AsyncSession, dashboard: PatientDashboard, data: PatientDashboardUpdate
) -> PatientDashboard:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(dashboard, key, value)
    await db.commit()
    await db.refresh(dashboard)
    return dashboard


async def delete(db: AsyncSession, dashboard: PatientDashboard) -> None:
    await db.delete(dashboard)
    await db.commit()


async def delete_for_project(db: AsyncSession, project_uid: str) -> None:
    await db.execute(
        sa_delete(PatientDashboard).where(PatientDashboard.project_uid == project_uid)
    )
    await db.commit()


# --- Tabs -------------------------------------------------------------------


async def list_tabs(
    db: AsyncSession, patient_dashboard_id: str
) -> list[PatientDashboardTab]:
    result = await db.execute(
        select(PatientDashboardTab).where(
            PatientDashboardTab.patient_dashboard_id == patient_dashboard_id
        )
    )
    return list(result.scalars().all())


async def get_tab(db: AsyncSession, tab_id: str) -> PatientDashboardTab | None:
    return await db.get(PatientDashboardTab, tab_id)


async def create_tab(
    db: AsyncSession, data: PatientDashboardTabCreate
) -> PatientDashboardTab:
    tab = PatientDashboardTab(**data.model_dump(exclude_unset=True))
    db.add(tab)
    await db.commit()
    await db.refresh(tab)
    return tab


async def update_tab(
    db: AsyncSession, tab: PatientDashboardTab, data: PatientDashboardTabUpdate
) -> PatientDashboardTab:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(tab, key, value)
    await db.commit()
    await db.refresh(tab)
    return tab


async def delete_tab(db: AsyncSession, tab: PatientDashboardTab) -> None:
    await db.delete(tab)
    await db.commit()


async def delete_tabs_for_dashboard(
    db: AsyncSession, patient_dashboard_id: str
) -> None:
    await db.execute(
        sa_delete(PatientDashboardTab).where(
            PatientDashboardTab.patient_dashboard_id == patient_dashboard_id
        )
    )
    await db.commit()


# --- Widgets ----------------------------------------------------------------


async def list_widgets(db: AsyncSession, tab_id: str) -> list[PatientDashboardWidget]:
    result = await db.execute(
        select(PatientDashboardWidget).where(PatientDashboardWidget.tab_id == tab_id)
    )
    return list(result.scalars().all())


async def get_widget(
    db: AsyncSession, widget_id: str
) -> PatientDashboardWidget | None:
    return await db.get(PatientDashboardWidget, widget_id)


async def create_widget(
    db: AsyncSession, data: PatientDashboardWidgetCreate
) -> PatientDashboardWidget:
    widget = PatientDashboardWidget(**data.model_dump(exclude_unset=True))
    db.add(widget)
    await db.commit()
    await db.refresh(widget)
    return widget


async def update_widget(
    db: AsyncSession,
    widget: PatientDashboardWidget,
    data: PatientDashboardWidgetUpdate,
) -> PatientDashboardWidget:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(widget, key, value)
    await db.commit()
    await db.refresh(widget)
    return widget


async def delete_widget(db: AsyncSession, widget: PatientDashboardWidget) -> None:
    await db.delete(widget)
    await db.commit()


async def delete_widgets_for_tab(db: AsyncSession, tab_id: str) -> None:
    await db.execute(
        sa_delete(PatientDashboardWidget).where(PatientDashboardWidget.tab_id == tab_id)
    )
    await db.commit()
