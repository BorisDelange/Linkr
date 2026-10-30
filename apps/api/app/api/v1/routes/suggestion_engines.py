"""Suggestion engines: the embeddings runtime, a workspace's embedding models and
configurations with their indexes, and computing a mapping project's
precomputed suggestions (syntactic and semantic scores). See
services/suggestions/.
"""

import asyncio
from functools import partial
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.job import Job
from app.models.user import User
from app.schemas.base import CamelModel
from app.schemas.execution import JobResponse
from app.services import fs_browser
from app.services import mapping_project_service as mapping_svc
from app.services.execution import jobs
from app.services.suggestions import registry, runtime, tasks

router = APIRouter(tags=["suggestion-engines"])

_WS = "/workspaces/{workspace_id}/suggestion-engines"


class TargetFilters(CamelModel):
    only_standard: bool = True
    only_valid: bool = True
    domains: list[str] = Field(default_factory=list)
    vocabularies: list[str] = Field(default_factory=list)
    concept_classes: list[str] = Field(default_factory=list)


def _filters_dict(f: TargetFilters) -> dict:
    return {
        "onlyStandard": f.only_standard, "onlyValid": f.only_valid, "domains": f.domains,
        "vocabularies": f.vocabularies, "conceptClasses": f.concept_classes,
    }


async def _launch(db: AsyncSession, user: User, workspace_id: str, kind: str, label: str, body, *, key: str, lane: str):
    running = tasks.running_job(key)
    if running:
        raise HTTPException(status.HTTP_409_CONFLICT, "Already running")
    job = await jobs.create(db, None, user.id, kind, label, workspace_id=workspace_id)
    tasks.claim(key, job.id)
    jobs.launch(job.id, body, lane=lane)
    return JobResponse.model_validate(job, from_attributes=True)


def _model_view(workspace_id: str, model: dict) -> dict:
    return {
        **model,
        "ready": registry.model_ready(workspace_id, model),
        "jobId": tasks.running_job(f"model:{model['id']}"),
    }


def _config_view(workspace_id: str, config: dict, inventory: list[dict]) -> dict:
    return {
        **config,
        "method": registry.method_for(config),
        "index": registry.index_state(workspace_id, config, inventory),
        "jobId": tasks.running_job(f"index:{config['id']}"),
    }


@router.get(_WS)
async def get_engines(
    workspace_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Everything the Models and configurations dialog shows: the runtime, the models,
    the configurations with the state of their index per vocabulary."""
    await check_workspace_permission(db, workspace_id, user, "concept-mapping:read")
    async with registry.lock(workspace_id):
        data = registry.load(workspace_id)
    inventory = await tasks.library_inventory(workspace_id)
    return {
        "runtime": {
            "installed": runtime.is_installed(),
            "probe": runtime.probe(),
            "jobId": tasks.running_job("runtime"),
            "torchBackend": settings.embeddings_torch_backend,
        },
        "models": [_model_view(workspace_id, m) for m in data["models"]],
        "configs": [_config_view(workspace_id, c, inventory) for c in data["configs"]],
        "vocabularies": [v["vocabularyId"] for v in inventory],
        "conceptClasses": await asyncio.to_thread(tasks.concept_classes, workspace_id),
        "defaultModel": {"repoId": registry.BIOLORD_REPO},
        "setupJobId": tasks.running_job(f"setup:{workspace_id}"),
    }


@router.post(_WS + "/runtime/install", response_model=JobResponse)
async def install_runtime(
    workspace_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """(Re)install the embeddings runtime. It is shared by the whole instance."""
    await check_workspace_permission(db, workspace_id, user, "workspace-settings:write")
    return await _launch(
        db, user, workspace_id, "embeddings-runtime", "Install the embeddings runtime",
        tasks.install_runtime, key="runtime", lane="build",
    )


@router.post(_WS + "/setup-default", response_model=JobResponse)
async def setup_default(
    workspace_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """One click: the runtime if needed, BioLORD-2023-M and its configuration."""
    await check_workspace_permission(db, workspace_id, user, "workspace-settings:write")
    if tasks.running_job("runtime"):
        raise HTTPException(status.HTTP_409_CONFLICT, "The runtime is being installed")
    return await _launch(
        db, user, workspace_id, "embeddings-setup", "Set up BioLORD-2023-M",
        partial(tasks.setup_default, workspace_id=workspace_id), key=f"setup:{workspace_id}", lane="build",
    )


# --- Models ------------------------------------------------------------------


class ModelCreate(CamelModel):
    source: Literal["huggingface", "server"]
    name: str | None = None
    repo_id: str | None = None
    server_path: str | None = None


@router.post(_WS + "/models")
async def create_model(
    workspace_id: str,
    body: ModelCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add a model: a Hugging Face id (downloaded by a job, whose id comes back)
    or a folder already on the server, read in place."""
    await check_workspace_permission(db, workspace_id, user, "workspace-settings:write")
    model = {"id": registry.new_id(), "source": body.source, "createdAt": registry.now()}
    if body.source == "huggingface":
        repo = (body.repo_id or "").strip()
        if not registry.valid_repo_id(repo):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A Hugging Face id is owner/name")
        model.update(repoId=repo, name=(body.name or repo.split("/")[-1]).strip())
    else:
        path = (body.server_path or "").strip()
        try:
            fs_browser.validate_source_path(path, await fs_browser.import_scope(db, None, user))
        except fs_browser.FsBrowseError as e:
            raise HTTPException(e.status_code, str(e)) from e
        model.update(serverPath=path, name=(body.name or Path(path).name).strip())
        if not registry.model_ready(workspace_id, model):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Not a sentence-transformers model folder (no modules.json or config.json)",
            )
        model["installedAt"] = registry.now()
    async with registry.lock(workspace_id):
        data = registry.load(workspace_id)
        if body.source == "huggingface" and any(m.get("repoId") == model["repoId"] for m in data["models"]):
            raise HTTPException(status.HTTP_409_CONFLICT, "This model is already in the workspace")
        data["models"].append(model)
        registry.save(workspace_id, data)
    job = None
    if body.source == "huggingface":
        job = await _start_download(db, user, workspace_id, model)
    return {"model": _model_view(workspace_id, model), "job": job}


async def _start_download(db: AsyncSession, user: User, workspace_id: str, model: dict) -> JobResponse:
    return await _launch(
        db, user, workspace_id, "embeddings-model", f"Download {model['repoId']}",
        partial(tasks.download_model, workspace_id=workspace_id, model_id=model["id"]),
        key=f"model:{model['id']}", lane="build",
    )


@router.post(_WS + "/models/{model_id}/download", response_model=JobResponse)
async def download_model(
    workspace_id: str,
    model_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "workspace-settings:write")
    model = registry.find(registry.load(workspace_id)["models"], model_id)
    if model is None or model["source"] != "huggingface":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Model not found")
    return await _start_download(db, user, workspace_id, model)


@router.delete(_WS + "/models/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_model(
    workspace_id: str,
    model_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "workspace-settings:write")
    if tasks.running_job(f"model:{model_id}"):
        raise HTTPException(status.HTTP_409_CONFLICT, "The model is being downloaded")
    async with registry.lock(workspace_id):
        data = registry.load(workspace_id)
        model = registry.find(data["models"], model_id)
        if model is None:
            return
        used = [c["name"] for c in data["configs"] if c["modelId"] == model_id]
        if used:
            raise HTTPException(status.HTTP_409_CONFLICT, f"Used by: {', '.join(used)}")
        data["models"] = [m for m in data["models"] if m["id"] != model_id]
        registry.save(workspace_id, data)
    await asyncio.to_thread(registry.remove_model_files, workspace_id, model)


# --- Configurations ------------------------------------------------------------


class ConfigBody(CamelModel):
    name: str | None = None
    slug: str | None = None
    model_id: str | None = None
    template: Literal["name_class", "name"] | None = None
    filters: TargetFilters | None = None
    device: Literal["auto", "cpu", "cuda", "mps"] | None = None
    batch_size: int | None = Field(None, ge=1, le=4096)


def _check_slug(data: dict, slug: str, config_id: str | None) -> None:
    if not registry.valid_slug(slug):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "The identifier is lowercase letters, digits, '.', '_' or '-' (40 at most)",
        )
    if any(c["slug"] == slug and c["id"] != config_id for c in data["configs"]):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Another configuration already writes semantic/{slug}")


@router.post(_WS + "/configs")
async def create_config(
    workspace_id: str,
    body: ConfigBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "workspace-settings:write")
    async with registry.lock(workspace_id):
        data = registry.load(workspace_id)
        model = registry.find(data["models"], body.model_id or "")
        if model is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown model")
        name = (body.name or model["name"]).strip()
        slug = body.slug or registry.slugify(name)
        _check_slug(data, slug, None)
        config = {
            "id": registry.new_id(),
            "name": name,
            "slug": slug,
            "modelId": model["id"],
            "template": body.template or "name_class",
            "filters": _filters_dict(body.filters or TargetFilters()),
            "device": body.device or "auto",
            "batchSize": body.batch_size or 256,
            "createdAt": registry.now(),
        }
        data["configs"].append(config)
        registry.save(workspace_id, data)
    return _config_view(workspace_id, config, await tasks.library_inventory(workspace_id))


@router.patch(_WS + "/configs/{config_id}")
async def update_config(
    workspace_id: str,
    config_id: str,
    body: ConfigBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Edit a configuration. Changing its model, template or scope drops its
    index, which has to be built again."""
    await check_workspace_permission(db, workspace_id, user, "workspace-settings:write")
    if tasks.running_job(f"index:{config_id}"):
        raise HTTPException(status.HTTP_409_CONFLICT, "The index is being built")
    async with registry.lock(workspace_id):
        data = registry.load(workspace_id)
        config = registry.find(data["configs"], config_id)
        if config is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Configuration not found")
        before = registry.index_inputs(config)
        if body.model_id is not None:
            if registry.find(data["models"], body.model_id) is None:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown model")
            config["modelId"] = body.model_id
        if body.slug is not None:
            _check_slug(data, body.slug, config_id)
            config["slug"] = body.slug
        if body.name is not None:
            config["name"] = body.name.strip() or config["name"]
        if body.template is not None:
            config["template"] = body.template
        if body.filters is not None:
            config["filters"] = _filters_dict(body.filters)
        if body.device is not None:
            config["device"] = body.device
        if body.batch_size is not None:
            config["batchSize"] = body.batch_size
        registry.save(workspace_id, data)
    if registry.index_inputs(config) != before:
        await asyncio.to_thread(registry.drop_index, workspace_id, config_id)
    return _config_view(workspace_id, config, await tasks.library_inventory(workspace_id))


@router.delete(_WS + "/configs/{config_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_config(
    workspace_id: str,
    config_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a configuration and its index. Scores it wrote stay in the projects."""
    await check_workspace_permission(db, workspace_id, user, "workspace-settings:write")
    if tasks.running_job(f"index:{config_id}"):
        raise HTTPException(status.HTTP_409_CONFLICT, "The index is being built")
    async with registry.lock(workspace_id):
        data = registry.load(workspace_id)
        data["configs"] = [c for c in data["configs"] if c["id"] != config_id]
        registry.save(workspace_id, data)
    await asyncio.to_thread(registry.drop_index, workspace_id, config_id)


class BuildBody(CamelModel):
    rebuild: bool = False


@router.post(_WS + "/configs/{config_id}/build", response_model=JobResponse)
async def build_index(
    workspace_id: str,
    config_id: str,
    body: BuildBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Encode the vocabularies the index lacks (stale or missing), or all of them."""
    await check_workspace_permission(db, workspace_id, user, "workspace-settings:write")
    if not runtime.is_installed():
        raise HTTPException(status.HTTP_409_CONFLICT, "The embeddings runtime is not installed")
    config = registry.find(registry.load(workspace_id)["configs"], config_id)
    if config is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Configuration not found")
    return await _launch(
        db, user, workspace_id, "embeddings-index", f"Build the {config['name']} index",
        partial(tasks.build_index, workspace_id=workspace_id, config_id=config_id, rebuild=body.rebuild),
        key=f"index:{config_id}", lane="heavy_query",
    )


class SearchBody(CamelModel):
    texts: list[str] = Field(min_length=1, max_length=50)
    top_k: int = Field(10, ge=1, le=100)
    filters: TargetFilters | None = None


@router.post(_WS + "/configs/{config_id}/search")
async def semantic_search(
    workspace_id: str,
    config_id: str,
    body: SearchBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The concepts of the index closest in meaning to each text, best first, with
    their name, vocabulary, domain and class. Loads the model for each call (a few
    seconds)."""
    await check_workspace_permission(db, workspace_id, user, "concept-mapping:read")
    if not runtime.is_installed():
        raise HTTPException(status.HTTP_409_CONFLICT, "The embeddings runtime is not installed")
    data = registry.load(workspace_id)
    config = registry.find(data["configs"], config_id)
    if config is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Configuration not found")
    model = registry.find(data["models"], config["modelId"])
    if model is None or not registry.model_ready(workspace_id, model):
        raise HTTPException(status.HTTP_409_CONFLICT, "The configuration's model is not installed")
    inventory = await tasks.library_inventory(workspace_id)
    files = registry.usable_index_files(workspace_id, config, inventory)
    if not files:
        raise HTTPException(status.HTTP_409_CONFLICT, "The configuration has no index yet: build it first")
    filters = _filters_dict(body.filters) if body.filters else {}
    try:
        found = await runtime.run_worker("search", {
            "modelPath": str(registry.model_path(workspace_id, model)),
            "device": config.get("device") or "auto",
            "texts": body.texts,
            "topK": body.top_k,
            "indexFiles": files,
            "filters": filters,
            "conceptPaths": tasks.concept_paths(workspace_id, inventory),
        })
    except runtime.WorkerError as e:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(e)) from e
    matches = found.get("matches") or []
    details = await asyncio.to_thread(
        tasks.concept_details, tasks.concept_paths(workspace_id, inventory),
        sorted({m["conceptId"] for row in matches for m in row}),
    )
    return {
        "method": registry.method_for(config),
        "results": [
            {"text": text, "matches": [{**m, **details.get(m["conceptId"], {})} for m in row]}
            for text, row in zip(body.texts, matches)
        ],
    }


# --- Scoring a mapping project ----------------------------------------------


class ComputeScoresBody(CamelModel):
    methods: list[str] = Field(default_factory=list)
    config_id: str | None = None
    filters: TargetFilters = Field(default_factory=TargetFilters)
    top_k: int = Field(20, ge=1, le=200)
    only_missing: bool = False


@router.get("/mapping-projects/{project_id}/scores/compute")
async def running_compute(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The project's scores computation still running, if any — the Compute tab
    follows it again when reopened — and the paused one, if any."""
    project = await mapping_svc.get(db, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, project.workspace_id, user, "concept-mapping:read")
    return {
        "jobId": tasks.running_job(f"scores:{project_id}"),
        "paused": tasks.paused_state(project.workspace_id, project_id),
    }


@router.post("/mapping-projects/{project_id}/scores/compute/pause", status_code=status.HTTP_202_ACCEPTED)
async def pause_compute(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Stop the running computation, keeping what it finished: the job ends
    cancelled once that is written, and the Compute tab offers to resume."""
    project = await mapping_svc.get(db, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, project.workspace_id, user, "concept-mapping:write")
    job_id = tasks.running_job(f"scores:{project_id}")
    job = await db.get(Job, job_id) if job_id else None
    if job is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "No computation is running")
    tasks.request_pause(project_id)
    await jobs.cancel(db, job)
    return {"jobId": job_id}


@router.post("/mapping-projects/{project_id}/scores/compute/resume", response_model=JobResponse)
async def resume_compute(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Resume the paused computation: only the source concepts it had left."""
    project = await mapping_svc.get(db, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, project.workspace_id, user, "concept-mapping:write")
    paused = tasks.paused_state(project.workspace_id, project_id)
    if paused is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "No paused computation")
    if paused["params"].get("configId") and not runtime.is_installed():
        raise HTTPException(status.HTTP_409_CONFLICT, "The embeddings runtime is not installed")
    return await _launch(
        db, user, project.workspace_id, "suggestion-scores", "Compute suggestion scores (resumed)",
        partial(tasks.score_project, project_id=project_id, params=paused["params"], resume=True),
        key=f"scores:{project_id}", lane="heavy_query",
    )


@router.post("/mapping-projects/{project_id}/scores/compute", response_model=JobResponse)
async def compute_scores(
    project_id: str,
    body: ComputeScoresBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Compute precomputed suggestions for the project's source concepts, as a
    job: the syntactic `methods` and/or the semantic scores of `configId`. Each
    method's rows are replaced (or, `onlyMissing`, completed); the other methods
    of the scores file — an agent's suggestions — are kept."""
    project = await mapping_svc.get(db, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, project.workspace_id, user, "concept-mapping:write")
    unknown = [m for m in body.methods if m not in tasks.SYNTACTIC_METHODS]
    if unknown:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown method: {', '.join(unknown)}")
    if not body.methods and not body.config_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No method to compute")
    if body.config_id:
        if not runtime.is_installed():
            raise HTTPException(status.HTTP_409_CONFLICT, "The embeddings runtime is not installed")
        if registry.find(registry.load(project.workspace_id)["configs"], body.config_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown embedding configuration")
    params = {
        "methods": body.methods,
        "configId": body.config_id,
        "filters": _filters_dict(body.filters),
        "topK": body.top_k,
        "onlyMissing": body.only_missing,
    }
    return await _launch(
        db, user, project.workspace_id, "suggestion-scores", "Compute suggestion scores",
        partial(tasks.score_project, project_id=project_id, params=params),
        key=f"scores:{project_id}", lane="heavy_query",
    )
