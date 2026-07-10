from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dashboard import Dashboard, DashboardTab, DashboardWidget
from app.schemas.dashboard import (
    DashboardCreate,
    DashboardTabCreate,
    DashboardTabUpdate,
    DashboardUpdate,
    DashboardWidgetCreate,
    DashboardWidgetUpdate,
)


# --- Dashboards -------------------------------------------------------------


async def list_for_project(db: AsyncSession, project_uid: str) -> list[Dashboard]:
    result = await db.execute(
        select(Dashboard).where(Dashboard.project_uid == project_uid)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, dashboard_id: str) -> Dashboard | None:
    return await db.get(Dashboard, dashboard_id)


async def create(db: AsyncSession, data: DashboardCreate) -> Dashboard:
    dashboard = Dashboard(**data.model_dump(exclude_unset=True))
    db.add(dashboard)
    await db.commit()
    await db.refresh(dashboard)
    return dashboard


async def update(
    db: AsyncSession, dashboard: Dashboard, data: DashboardUpdate
) -> Dashboard:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(dashboard, key, value)
    await db.commit()
    await db.refresh(dashboard)
    return dashboard


async def delete(db: AsyncSession, dashboard: Dashboard) -> None:
    await db.delete(dashboard)
    await db.commit()


async def delete_for_project(db: AsyncSession, project_uid: str) -> None:
    await db.execute(
        sa_delete(Dashboard).where(Dashboard.project_uid == project_uid)
    )
    await db.commit()


# --- Tabs -------------------------------------------------------------------


async def list_tabs(db: AsyncSession, dashboard_id: str) -> list[DashboardTab]:
    result = await db.execute(
        select(DashboardTab).where(DashboardTab.dashboard_id == dashboard_id)
    )
    return list(result.scalars().all())


async def get_tab(db: AsyncSession, tab_id: str) -> DashboardTab | None:
    return await db.get(DashboardTab, tab_id)


async def create_tab(db: AsyncSession, data: DashboardTabCreate) -> DashboardTab:
    tab = DashboardTab(**data.model_dump(exclude_unset=True))
    db.add(tab)
    await db.commit()
    await db.refresh(tab)
    return tab


async def update_tab(
    db: AsyncSession, tab: DashboardTab, data: DashboardTabUpdate
) -> DashboardTab:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(tab, key, value)
    await db.commit()
    await db.refresh(tab)
    return tab


async def delete_tab(db: AsyncSession, tab: DashboardTab) -> None:
    await db.delete(tab)
    await db.commit()


async def delete_tabs_for_dashboard(db: AsyncSession, dashboard_id: str) -> None:
    await db.execute(
        sa_delete(DashboardTab).where(DashboardTab.dashboard_id == dashboard_id)
    )
    await db.commit()


# --- Widgets ----------------------------------------------------------------


async def list_widgets(db: AsyncSession, tab_id: str) -> list[DashboardWidget]:
    result = await db.execute(
        select(DashboardWidget).where(DashboardWidget.tab_id == tab_id)
    )
    return list(result.scalars().all())


async def get_widget(db: AsyncSession, widget_id: str) -> DashboardWidget | None:
    return await db.get(DashboardWidget, widget_id)


async def create_widget(
    db: AsyncSession, data: DashboardWidgetCreate
) -> DashboardWidget:
    widget = DashboardWidget(**data.model_dump(exclude_unset=True))
    db.add(widget)
    await db.commit()
    await db.refresh(widget)
    return widget


async def update_widget(
    db: AsyncSession, widget: DashboardWidget, data: DashboardWidgetUpdate
) -> DashboardWidget:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(widget, key, value)
    await db.commit()
    await db.refresh(widget)
    return widget


async def delete_widget(db: AsyncSession, widget: DashboardWidget) -> None:
    await db.delete(widget)
    await db.commit()


async def delete_widgets_for_tab(db: AsyncSession, tab_id: str) -> None:
    await db.execute(
        sa_delete(DashboardWidget).where(DashboardWidget.tab_id == tab_id)
    )
    await db.commit()
