"""The suggestion-engine jobs: install the runtime, download a model, build a
configuration's index, score a mapping project. Each is a job body (a coroutine
taking a JobHandle, services/execution/jobs.py) whose heavy work runs in the
worker process (worker.py) — cancelling the job kills it.
"""

import asyncio
import json
import shutil
import sys
import tempfile
from pathlib import Path

from sqlalchemy import select

from app.core.database import async_session
from app.models.data_source import DataSource
from app.services import scores_export
from app.services import vocabulary_library as lib
from app.services.data import db_connect, scores_service
from app.services.data.file_source import (
    build_source_concepts_select,
    source_concepts_dedup_partition,
)
from app.services.suggestions import registry, runtime

SYNTACTIC_METHODS = ("syntactic/jaro-winkler", "syntactic/token-sort", "syntactic/ngram-idf")

# One job per thing at a time: a second build of the same index, or a second
# run on the same project, would write the same files.
_running: dict[str, str] = {}


def running_job(key: str) -> str | None:
    from app.services.execution import jobs

    job_id = _running.get(key)
    return job_id if job_id and jobs.is_running(job_id) else None


def claim(key: str, job_id: str) -> None:
    _running[key] = job_id


async def library_inventory(workspace_id: str) -> list[dict]:
    """The vocabularies of the workspace library (`connectionConfig.vocabularies`)."""
    async with async_session() as db:
        res = await db.execute(
            select(DataSource).where(
                DataSource.workspace_id == workspace_id, DataSource.is_vocabulary_reference.is_(True)
            )
        )
        for ds in res.scalars().all():
            config = ds.connection_config or {}
            if config.get("vocabularyLibrary"):
                return list(config.get("vocabularies") or [])
    return []


def concept_paths(workspace_id: str, inventory: list[dict]) -> list[str]:
    paths = [lib.partition_path(workspace_id, "concept", v["vocabularyId"]) for v in inventory]
    return [str(p) for p in paths if p.is_file()]


def concept_details(paths: list[str], ids: list[int]) -> dict[int, dict]:
    """Name, code, vocabulary, domain and class of each concept id."""
    if not paths or not ids:
        return {}
    import duckdb

    con = duckdb.connect()
    try:
        rows = con.execute(
            "SELECT concept_id, concept_name, concept_code, vocabulary_id, domain_id, concept_class_id, "
            "standard_concept FROM read_parquet(?, union_by_name = true) WHERE concept_id IN "
            f"({', '.join(str(int(i)) for i in ids)})",
            [paths],
        ).fetchall()
    finally:
        con.close()
    keys = ("conceptName", "conceptCode", "vocabularyId", "domainId", "conceptClassId", "standardConcept")
    return {int(r[0]): dict(zip(keys, r[1:])) for r in rows}


def concept_classes(workspace_id: str) -> list[str]:
    """Every concept class of the workspace library (ATHENA's `concept_class`
    table), the options of a target scope's class filter."""
    path = lib.library_dir(workspace_id) / "concept_class" / lib.SHARED_FILE
    if not path.is_file():
        return []
    import duckdb

    con = duckdb.connect()
    try:
        rows = con.execute("SELECT concept_class_id FROM read_parquet(?) ORDER BY 1", [str(path)]).fetchall()
    finally:
        con.close()
    return [r[0] for r in rows if r[0]]


# --- Runtime and models ------------------------------------------------------


async def install_runtime(handle) -> None:
    found = await runtime.install(handle)
    await handle.set_result(found)


async def download_model(handle, workspace_id: str, model_id: str) -> None:
    async with registry.lock(workspace_id):
        model = registry.find(registry.load(workspace_id)["models"], model_id)
    if model is None or model["source"] != "huggingface":
        raise ValueError("Model not found")
    dest = registry.model_dir(workspace_id, model_id)
    found = await runtime.run_worker(
        "download", {"repoId": model["repoId"], "dest": str(dest)}, handle=handle, network=True,
    )
    async with registry.lock(workspace_id):
        data = registry.load(workspace_id)
        current = registry.find(data["models"], model_id)
        if current is None:
            registry.remove_model_files(workspace_id, model)
            return
        current.update(dimension=found.get("dimension"), sizeBytes=found.get("sizeBytes"), installedAt=registry.now())
        registry.save(workspace_id, data)
    await handle.set_result(found)


async def setup_default(handle, workspace_id: str) -> None:
    """The one-click setup: the runtime when absent, BioLORD-2023-M, and a
    configuration over every standard concept writing `semantic/biolord`.
    The index is left to build: a few hours (about 3.5 million concepts, two
    thirds of them drugs)."""
    if not runtime.is_installed():
        await handle.log("Installing the embeddings runtime …")
        await runtime.install(handle)
    async with registry.lock(workspace_id):
        data = registry.load(workspace_id)
        model = next((m for m in data["models"] if m.get("repoId") == registry.BIOLORD_REPO), None)
        if model is None:
            model = {
                "id": registry.new_id(), "source": "huggingface", "repoId": registry.BIOLORD_REPO,
                "name": registry.BIOLORD_REPO.split("/")[-1], "createdAt": registry.now(),
            }
            data["models"].append(model)
        if not any(c["modelId"] == model["id"] for c in data["configs"]):
            slug = "biolord" if not any(c["slug"] == "biolord" for c in data["configs"]) else f"biolord-{model['id'][:8]}"
            data["configs"].append({
                "id": registry.new_id(), "name": "BioLORD", "slug": slug, "modelId": model["id"],
                "template": "name_class",
                "filters": {"onlyStandard": True, "onlyValid": True, "domains": [], "vocabularies": [], "conceptClasses": []},
                "device": "auto", "batchSize": 256, "createdAt": registry.now(),
            })
        registry.save(workspace_id, data)
    if not registry.model_ready(workspace_id, model):
        await download_model(handle, workspace_id, model["id"])


# --- Indexes -------------------------------------------------------------------


async def build_index(handle, workspace_id: str, config_id: str, rebuild: bool) -> None:
    """Encode the vocabularies the configuration's index lacks (or all, `rebuild`)."""
    async with registry.lock(workspace_id):
        data = registry.load(workspace_id)
    config = registry.find(data["configs"], config_id)
    if config is None:
        raise ValueError("Configuration not found")
    model = registry.find(data["models"], config["modelId"])
    if model is None or not registry.model_ready(workspace_id, model):
        raise ValueError("The configuration's model is not installed")
    inventory = await library_inventory(workspace_id)
    states = {s["vocabularyId"]: s for s in registry.index_state(workspace_id, config, inventory)}
    todo = [
        v for v in registry.config_vocabularies(config, inventory)
        if rebuild or states[v["vocabularyId"]]["status"] != "built"
    ]
    if not todo:
        await handle.log("The index is up to date")
        return
    manifest = registry.load_manifest(workspace_id, config_id)
    pending = manifest.setdefault("pending", {})
    out_dir = registry.index_dir(workspace_id, config_id)
    partitions = []
    for v in todo:
        key = lib.file_key(v["vocabularyId"])
        # Chunks left by a stopped build are only resumed for the same import.
        if rebuild or pending.get(v["vocabularyId"]) != v.get("importedAt"):
            shutil.rmtree(out_dir / f"{key}.parts", ignore_errors=True)
        pending[v["vocabularyId"]] = v.get("importedAt")
        concept = lib.partition_path(workspace_id, "concept", v["vocabularyId"])
        if concept.is_file():
            partitions.append({"vocabularyId": v["vocabularyId"], "key": key, "conceptPath": str(concept)})
    registry.save_manifest(workspace_id, config_id, manifest)
    found = await runtime.run_worker("embed", {
        "modelPath": str(registry.model_path(workspace_id, model)),
        "device": config.get("device") or "auto",
        "batchSize": config.get("batchSize") or 256,
        "template": config.get("template") or "name_class",
        "filters": {k: v for k, v in (config.get("filters") or {}).items() if k != "vocabularies"},
        "outDir": str(out_dir),
        "partitions": partitions,
    }, handle=handle)
    by_id = {v["vocabularyId"]: v for v in todo}
    manifest = registry.load_manifest(workspace_id, config_id)
    for built in found.get("vocabularies") or []:
        vid = built["vocabularyId"]
        manifest.setdefault("vocabularies", {})[vid] = {
            "count": built["count"],
            "importedAt": by_id[vid].get("importedAt"),
            "vocabularyVersion": by_id[vid].get("vocabularyVersion"),
            "builtAt": registry.now(),
        }
        manifest.get("pending", {}).pop(vid, None)
    if found.get("dimension"):
        manifest["dimension"] = found["dimension"]
    registry.save_manifest(workspace_id, config_id, manifest)
    await handle.set_result({"vocabularies": found.get("vocabularies") or []})


# --- Scoring a mapping project ----------------------------------------------


def _source_rows(project) -> list[tuple[str, str, str]]:
    fsd = project.file_source_data or {}
    column_mapping = fsd.get("columnMapping", {})
    vocabulary = "coalesce(vocabulary_id, '')" if column_mapping.get("terminologyColumn") else "''"
    rows = db_connect.query_file_source(
        str(_blob_path(project.raw_file_sha)),
        project.raw_file_name,
        fsd.get("parseOptions", {}),
        build_source_concepts_select(column_mapping),
        source_concepts_dedup_partition(column_mapping),
        f"SELECT {vocabulary} AS vocabulary_id, coalesce(concept_code, '') AS concept_code, "
        f"coalesce(concept_name, '') AS concept_name FROM source_concepts WHERE coalesce(concept_name, '') <> ''",
        max_rows=None,
    )
    return [(str(r["vocabulary_id"]), str(r["concept_code"]), str(r["concept_name"])) for r in rows]


def _blob_path(sha: str) -> Path:
    from app.services import blob_store

    return blob_store.path_for(sha)


def _scored_keys(project, methods: list[str]) -> set[tuple[str, str]]:
    """Source concepts every one of `methods` already has rows for."""
    if not project.scores_file_sha or not _blob_path(project.scores_file_sha).is_file():
        return set()
    import duckdb

    con = duckdb.connect()
    try:
        rows = con.execute(
            "SELECT source_vocabulary_id, source_concept_code FROM read_parquet(?) WHERE method IN "
            f"({', '.join('?' for _ in methods)}) GROUP BY 1, 2 HAVING count(DISTINCT method) = ?",
            [str(_blob_path(project.scores_file_sha)), *methods, len(methods)],
        ).fetchall()
        return {(str(v or ""), str(c or "")) for v, c in rows}
    finally:
        con.close()


def _write_sources(rows: list[tuple[str, str, str]], path: Path) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq

    pq.write_table(pa.table({
        "vocabulary_id": [r[0] for r in rows],
        "concept_code": [r[1] for r in rows],
        "concept_name": [r[2] for r in rows],
    }), str(path))


# --- Pausing a scoring run --------------------------------------------------
#
# A run over a large project can take a night. Paused, it writes what it has
# finished (the worker's checkpoints say how far each stage got), and leaves
# under `<embeddings root>/paused/` its parameters and, per stage, the source
# concepts still to do; resuming scores only those.

_pause_requested: set[str] = set()
STAGES = ("syntactic", "semantic")


def request_pause(project_id: str) -> None:
    _pause_requested.add(project_id)


def _paused_dir(workspace_id: str) -> Path:
    return registry.root(workspace_id) / "paused"


def _paused_files(workspace_id: str, project_id: str) -> tuple[Path, dict[str, Path]]:
    base = _paused_dir(workspace_id)
    return base / f"{project_id}.json", {st: base / f"{project_id}.{st}.parquet" for st in STAGES}


def paused_state(workspace_id: str, project_id: str) -> dict | None:
    """What the Compute tab shows of a paused run: its parameters, when, and how
    far it got (`done` of `total` units — a unit is one source concept through
    one stage, so a run stopped before its semantic stage is not at 0)."""
    state_path, _ = _paused_files(workspace_id, project_id)
    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def clear_paused(workspace_id: str, project_id: str) -> None:
    state_path, stage_paths = _paused_files(workspace_id, project_id)
    for path in (state_path, *stage_paths.values()):
        path.unlink(missing_ok=True)


def _read_sources(path: Path) -> list[tuple[str, str, str]]:
    if not path.is_file():
        return []
    import pyarrow.parquet as pq

    t = pq.read_table(str(path)).to_pydict()
    return list(zip(t["vocabulary_id"], t["concept_code"], t["concept_name"], strict=True))


def _keep_sources(csv_path: str, keys: list[tuple[str, str, str]], out_path: str) -> None:
    """The rows of a method's CSV whose source concept is among `keys`: what a
    stopped worker wrote past its last checkpoint is dropped."""
    import duckdb

    con = duckdb.connect()
    try:
        con.execute("CREATE TEMP TABLE k (v VARCHAR, c VARCHAR)")
        if keys:
            con.executemany("INSERT INTO k VALUES (?, ?)", [(v, c) for v, c, _ in keys])
        con.execute(
            f"COPY (SELECT r.* FROM read_csv({scores_service._sql_literal(csv_path)}, header=true, all_varchar=true) r "
            "WHERE EXISTS (SELECT 1 FROM k WHERE k.v = coalesce(r.source_vocabulary_id, '') "
            "AND k.c = coalesce(r.source_concept_code, ''))) "
            f"TO {scores_service._sql_literal(out_path)} (FORMAT CSV, HEADER true, DELIMITER ',', QUOTE '\"', "
            "ESCAPE '\"', NULL '')"
        )
    finally:
        con.close()


async def score_project(handle, project_id: str, params: dict, resume: bool = False) -> None:
    """Compute the chosen methods for a project's source concepts and write them
    to its scores file, replacing each method's rows (or adding to them when
    `onlyMissing`). Other methods — an agent's `ai/…` rows — are left alone.

    `resume` picks up a paused run: its own parameters, only the source concepts
    each stage had left, added to what the pause wrote."""
    from app.services import mapping_project_service as svc

    async with async_session() as db:
        project = await svc.get(db, project_id)
        if project is None:
            raise ValueError("Mapping project not found")
        if not project.raw_file_sha or not _blob_path(project.raw_file_sha).is_file():
            raise ValueError("The mapping project has no source concepts yet (import its file or run its extraction)")
        workspace_id = project.workspace_id
        paused = paused_state(workspace_id, project_id)
        if resume:
            if paused is None:
                raise ValueError("No paused computation to resume")
            params = paused["params"]
            _, stage_paths = _paused_files(workspace_id, project_id)
            stage_sources = {st: await asyncio.to_thread(_read_sources, stage_paths[st]) for st in STAGES}
        else:
            clear_paused(workspace_id, project_id)
        methods = [m for m in params.get("methods") or [] if m in SYNTACTIC_METHODS]
        semantic = None
        if params.get("configId"):
            data = registry.load(workspace_id)
            config = registry.find(data["configs"], params["configId"])
            if config is None:
                raise ValueError("Embedding configuration not found")
            model = registry.find(data["models"], config["modelId"])
            if model is None or not registry.model_ready(workspace_id, model):
                raise ValueError("The configuration's model is not installed")
            inventory = await library_inventory(workspace_id)
            files = registry.usable_index_files(workspace_id, config, inventory)
            if not files:
                raise ValueError("The configuration has no index yet: build it first")
            semantic = {
                "method": registry.method_for(config),
                "modelPath": str(registry.model_path(workspace_id, model)),
                "device": config.get("device") or "auto",
                "batchSize": config.get("batchSize") or 256,
                "indexFiles": files,
            }
        else:
            inventory = await library_inventory(workspace_id)
        all_methods = methods + ([semantic["method"]] if semantic else [])
        if not all_methods:
            raise ValueError("No method to compute")
        if not resume:
            sources = await asyncio.to_thread(_source_rows, project)
            if params.get("onlyMissing"):
                done = await asyncio.to_thread(_scored_keys, project, all_methods)
                sources = [s for s in sources if (s[0], s[1]) not in done]
            stage_sources = {"syntactic": sources if methods else [], "semantic": sources if semantic else []}
        existing_scores = (
            str(_blob_path(project.scores_file_sha))
            if project.scores_file_sha and _blob_path(project.scores_file_sha).is_file() else None
        )
    syntactic_sources, semantic_sources = stage_sources["syntactic"], stage_sources["semantic"]
    if not syntactic_sources and not semantic_sources:
        clear_paused(workspace_id, project_id)
        await handle.log("Every source concept already has these scores")
        return
    paths = concept_paths(workspace_id, inventory)
    if not paths:
        raise ValueError("The workspace vocabulary library is empty: import an ATHENA export first")
    total = paused["total"] if resume else len(syntactic_sources) + len(semantic_sources)
    await handle.log(
        f"{max(len(syntactic_sources), len(semantic_sources)):,} source concepts{' left' if resume else ''}, "
        f"methods: {', '.join(all_methods)}"
    )
    # A resumed run, or one limited to the missing concepts, adds to the method's rows.
    extend = resume or bool(params.get("onlyMissing"))

    async def write(csvs: list[tuple[str, str]]) -> None:
        async with scores_export.scores_lock(project_id), async_session() as db:
            project = await svc.get(db, project_id)
            if project is not None:
                await scores_export.replace_methods(db, project, csvs)

    with tempfile.TemporaryDirectory(prefix="linkr-scores-") as tmp:
        tmp_dir = Path(tmp)
        out_dir = tmp_dir / "out"
        sources_path = tmp_dir / "sources.parquet"
        await asyncio.to_thread(_write_sources, syntactic_sources, sources_path)
        spec = {
            "sourcesPath": str(sources_path),
            "conceptPaths": paths,
            "filters": params.get("filters") or {},
            "topK": params.get("topK") or 20,
            "methods": methods if syntactic_sources else [],
            "semantic": semantic if semantic_sources else None,
            "outDir": str(out_dir),
            "progress": {"done": paused["done"] if resume else 0, "total": total},
        }
        if resume:
            await handle.progress(100 * paused["done"] // max(total, 1))
        if semantic_sources is not syntactic_sources:
            semantic_path = tmp_dir / "semantic-sources.parquet"
            await asyncio.to_thread(_write_sources, semantic_sources, semantic_path)
            spec["semanticSourcesPath"] = str(semantic_path)
        # Syntactic methods need nothing beyond the API's own interpreter.
        python = None if spec["semantic"] else Path(sys.executable)
        points: dict[str, int] = {}
        try:
            found = await runtime.run_worker("score", spec, handle=handle, python=python, checkpoints=points)
        except asyncio.CancelledError:
            if project_id in _pause_requested:
                await asyncio.shield(_pause(
                    handle, workspace_id, project_id, params, total, existing_scores, out_dir,
                    {m: "syntactic" for m in spec["methods"]}
                    | ({semantic["method"]: "semantic"} if spec["semantic"] else {}),
                    stage_sources, points, write,
                ))
            raise
        finally:
            _pause_requested.discard(project_id)
        csvs: list[tuple[str, str]] = []
        for method, out in (found.get("methods") or {}).items():
            path = out["path"]
            if extend:
                merged = str(tmp_dir / f"merged-{len(csvs)}.csv")
                await asyncio.to_thread(scores_service.extend_method_csv, existing_scores, method, path, merged)
                path = merged
            csvs.append((method, path))
        if csvs:
            await handle.log("Writing the scores file …")
            await write(csvs)
    clear_paused(workspace_id, project_id)
    await handle.set_result({m: o["rows"] for m, o in (found.get("methods") or {}).items()})


async def _pause(
    handle, workspace_id: str, project_id: str, params: dict, total: int, existing_scores: str | None,
    out_dir: Path, stage_of: dict[str, str], stage_sources: dict[str, list], points: dict[str, int], write,
) -> None:
    """Write what the stopped worker finished, and leave what each stage has to do."""
    from app.services.suggestions import worker

    csvs: list[tuple[str, str]] = []
    for method, stage in stage_of.items():
        done = stage_sources[stage][:points.get(stage, 0)]
        path = out_dir / worker.method_file_name(method)
        if not done or not path.is_file():
            continue
        kept = str(out_dir / f"kept-{len(csvs)}.csv")
        merged = str(out_dir / f"paused-{len(csvs)}.csv")
        await asyncio.to_thread(_keep_sources, str(path), done, kept)
        await asyncio.to_thread(scores_service.extend_method_csv, existing_scores, method, kept, merged)
        csvs.append((method, merged))
    if csvs:
        await write(csvs)
    state_path, stage_paths = _paused_files(workspace_id, project_id)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    left = {st: stage_sources[st][points.get(st, 0):] for st in STAGES}
    for st in STAGES:
        await asyncio.to_thread(_write_sources, left[st], stage_paths[st])
    done = total - len(left["syntactic"]) - len(left["semantic"])
    state_path.write_text(json.dumps({
        "params": params,
        "pausedAt": registry.now(),
        "total": total,
        "done": done,
    }), encoding="utf-8")
    await handle.log(f"Paused at {100 * done // max(total, 1)}%")
