import shutil

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import path_ids
from app.core.permissions import global_grant_role
from app.models.project import Project
from app.models.user import User
from app.models.workspace import Workspace
from app.models.workspace_member import WorkspaceMember
from app.schemas.workspace import WorkspaceCreate, WorkspaceUpdate
from app.services import author_provenance, blob_cleanup, git_secret, project_fs
from app.services.execution import env_options


async def list_for_user(db: AsyncSession, user: User) -> list[Workspace]:
    """Workspaces the user is a member of (admins see all; a global
    all-workspaces grant sees all too)."""
    if user.role == "admin" or await global_grant_role(db, user, "all-workspaces"):
        result = await db.execute(select(Workspace))
        return list(result.scalars().all())

    result = await db.execute(
        select(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, workspace_id: str) -> Workspace | None:
    return await db.get(Workspace, workspace_id)


async def create(db: AsyncSession, data: WorkspaceCreate, owner: User) -> Workspace:
    payload = data.model_dump(exclude_none=True)
    # A foreign instance's created_by_id is meaningless here — never persist it;
    # stamp_creator derives the right local id (ORCID/email match, or NULL).
    payload.pop("created_by_id", None)
    workspace = Workspace(owner_id=owner.id)
    git_secret.apply_to_entity(workspace, payload)
    for key, value in payload.items():
        setattr(workspace, key, value)
    await author_provenance.stamp_creator(db, workspace, payload, owner)
    db.add(workspace)
    await db.flush()  # assign id before adding the membership row
    db.add(
        WorkspaceMember(workspace_id=workspace.id, user_id=owner.id, role="owner")
    )
    await db.commit()
    await db.refresh(workspace)
    return workspace


async def update(
    db: AsyncSession, workspace: Workspace, data: WorkspaceUpdate
) -> Workspace:
    changes = data.model_dump(exclude_unset=True)
    if "default_env_options" in changes:
        changes["default_env_options"] = env_options.keep_masked_workspace(
            changes["default_env_options"], workspace.default_env_options
        )
    git_secret.apply_to_entity(workspace, changes)
    for key, value in changes.items():
        setattr(workspace, key, value)
    await author_provenance.relink_creator_on_update(db, workspace, changes)
    await db.commit()
    await db.refresh(workspace)
    return workspace


async def delete(db: AsyncSession, workspace: Workspace) -> None:
    from app.models.data_catalog import DataCatalog
    from app.models.data_source import DataSource
    from app.models.dq_rule_set import DqRuleSet
    from app.models.etl_pipeline import EtlPipeline
    from app.models.job import Job
    from app.models.mapping_project import MappingProject
    from app.models.schema_preset import SchemaPreset
    from app.models.sql_script import SqlScriptCollection
    from app.models.user_plugin import UserPlugin
    from app.services import (
        data_source_service,
        git_service,
        scores_export,
        stats_cache_service,
    )
    from app.services.data import query_jobs
    from app.services.suggestions import registry as embeddings_registry

    workspace_id = workspace.id
    result = await db.execute(
        select(Project.uid).where(Project.workspace_id == workspace_id)
    )
    project_uids = [uid for (uid,) in result.all()]
    # Mapping projects have their own on-disk versioning working tree
    # (mapping-projects/<id>/versioning); collect their ids before the cascade
    # delete so we can remove those dirs too.
    mp_result = await db.execute(
        select(MappingProject.id).where(MappingProject.workspace_id == workspace_id)
    )
    mapping_project_ids = [mp_id for (mp_id,) in mp_result.all()]

    shas: set[str] = set()
    for project_uid in project_uids:
        shas |= await blob_cleanup.collect_project_blob_shas(db, project_uid)
    shas |= await blob_cleanup.collect_workspace_blob_shas(db, workspace_id)

    catalog_ids = (await db.scalars(select(DataCatalog.id).where(DataCatalog.workspace_id == workspace_id))).all()
    pipeline_ids = (await db.scalars(select(EtlPipeline.id).where(EtlPipeline.workspace_id == workspace_id))).all()
    versioned = {
        "data-catalogs": catalog_ids,
        "etl-pipelines": pipeline_ids,
        "dq-rule-sets": (await db.scalars(select(DqRuleSet.id).where(DqRuleSet.workspace_id == workspace_id))).all(),
        "sql-collections": (await db.scalars(
            select(SqlScriptCollection.id).where(SqlScriptCollection.workspace_id == workspace_id)
        )).all(),
        "user-plugins": (await db.scalars(select(UserPlugin.id).where(UserPlugin.workspace_id == workspace_id))).all(),
        "schema-presets": [
            key
            for row in (await db.execute(
                select(SchemaPreset.id, SchemaPreset.preset_id).where(SchemaPreset.workspace_id == workspace_id)
            )).all()
            for key in row if key
        ],
    }
    job_ids = (await db.scalars(select(Job.id).where(
        or_(Job.workspace_id == workspace_id, Job.project_uid.in_(project_uids))
    ))).all()
    # One by one rather than left to the FK cascade: a database's files and caches
    # are keyed by its id, with no row that a cascade would reach.
    sources = (await db.scalars(select(DataSource).where(DataSource.workspace_id == workspace_id))).all()
    for source in sources:
        await data_source_service.delete(db, source)

    await db.delete(workspace)
    await db.commit()

    for catalog_id in catalog_ids:
        await stats_cache_service.delete(db, "catalog", catalog_id)
    for pipeline_id in pipeline_ids:
        await stats_cache_service.delete(db, "etl-quality", pipeline_id)
    for job_id in job_ids:
        query_jobs.drop_results(job_id)

    # Disk cleanup after the DB commit — see project_service.delete for the
    # same reasoning (per-project dirs are never shared; blobs may be).
    for project_uid in project_uids:
        if path_ids.is_safe_segment(project_uid):
            shutil.rmtree(project_fs.project_dir(project_uid), ignore_errors=True)
    # Remove the versioning working trees that would otherwise be orphaned: the
    # workspace's own, and each of its mapping projects'.
    git_service.remove_repo("workspaces", workspace_id)
    for mp_id in mapping_project_ids:
        git_service.remove_repo("mapping-projects", mp_id)
        scores_export.drop_csv_cache(mp_id)
    for kind, entity_ids in versioned.items():
        for entity_id in entity_ids:
            git_service.remove_repo(kind, entity_id)
    # The vocabulary library's partitions are the workspace's own files.
    from app.services import vocabulary_library

    if path_ids.is_safe_segment(workspace_id):
        shutil.rmtree(vocabulary_library.library_dir(workspace_id), ignore_errors=True)
        shutil.rmtree(embeddings_registry.root(workspace_id), ignore_errors=True)
    await blob_cleanup.deref_blobs(db, shas)
