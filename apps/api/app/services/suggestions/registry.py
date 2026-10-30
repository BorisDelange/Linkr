"""A workspace's embedding models and configurations (server side).

Machine-local, like the vocabulary library they encode: weights and indexes are
gigabytes and are never exported. Everything sits under
``data_dir/embeddings/<workspace>/``:

    registry.json                 models + configurations
    models/<model id>/            weights downloaded from the Hugging Face Hub
    indexes/<config id>/          manifest.json + <vocab key>.ids.npy / .vec.npy

A *model* is a set of weights: downloaded (``source: huggingface``) or a folder
already on the server (``source: server``, read in place — the way to bring one
into an offline SPE). A *configuration* says what to encode with it: the text
template and the target scope. It owns one index per vocabulary of the library,
and the method ``semantic/<slug>`` its scores are written under. Changing what an
index depends on (model, template, scope) drops the index.

Not inside ``data_dir/vocabularies/<workspace>/``: the library data source reads
every Parquet file under that folder as a table.
"""

import asyncio
import json
import re
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path

from app.config import settings

BIOLORD_REPO = "FremyCompany/BioLORD-2023-M"
TEMPLATES = ("name_class", "name")
DEVICES = ("auto", "cpu", "cuda", "mps")
# What an index is computed from; changing one of them invalidates it.
INDEX_FIELDS = ("modelId", "template", "filters")

FILTER_LISTS = ("domains", "vocabularies", "conceptClasses")

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,39}$")
_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")

_locks: dict[str, asyncio.Lock] = {}


def lock(workspace_id: str) -> asyncio.Lock:
    return _locks.setdefault(workspace_id, asyncio.Lock())


def root(workspace_id: str) -> Path:
    return settings.data_path / "embeddings" / workspace_id


def _registry_path(workspace_id: str) -> Path:
    return root(workspace_id) / "registry.json"


def load(workspace_id: str) -> dict:
    path = _registry_path(workspace_id)
    if not path.is_file():
        return {"models": [], "configs": []}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {"models": data.get("models") or [], "configs": data.get("configs") or []}


def save(workspace_id: str, data: dict) -> None:
    path = _registry_path(workspace_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def now() -> str:
    return datetime.now(UTC).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())


def valid_slug(slug: str) -> bool:
    return bool(_SLUG_RE.fullmatch(slug))


def valid_repo_id(repo_id: str) -> bool:
    return bool(_REPO_RE.fullmatch(repo_id))


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9._-]+", "-", text.lower()).strip("-._")[:40]
    return slug or "model"


def find(items: list[dict], item_id: str) -> dict | None:
    return next((i for i in items if i["id"] == item_id), None)


# --- Models ------------------------------------------------------------------


def model_dir(workspace_id: str, model_id: str) -> Path:
    return root(workspace_id) / "models" / model_id


def model_path(workspace_id: str, model: dict) -> Path:
    if model["source"] == "server":
        return Path(model["serverPath"])
    return model_dir(workspace_id, model["id"])


def model_ready(workspace_id: str, model: dict) -> bool:
    """A sentence-transformers folder: `modules.json`, or at least a transformer's
    `config.json` (sentence-transformers then adds mean pooling)."""
    path = model_path(workspace_id, model)
    return (path / "modules.json").is_file() or (path / "config.json").is_file()


def remove_model_files(workspace_id: str, model: dict) -> None:
    # A server folder belongs to whoever put it there: only downloads are ours.
    if model["source"] == "huggingface":
        shutil.rmtree(model_dir(workspace_id, model["id"]), ignore_errors=True)


# --- Configurations and their indexes ----------------------------------------


def method_for(config: dict) -> str:
    return f"semantic/{config['slug']}"


def index_dir(workspace_id: str, config_id: str) -> Path:
    return root(workspace_id) / "indexes" / config_id


def _manifest_path(workspace_id: str, config_id: str) -> Path:
    return index_dir(workspace_id, config_id) / "manifest.json"


def load_manifest(workspace_id: str, config_id: str) -> dict:
    path = _manifest_path(workspace_id, config_id)
    if not path.is_file():
        return {"vocabularies": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def save_manifest(workspace_id: str, config_id: str, manifest: dict) -> None:
    path = _manifest_path(workspace_id, config_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    tmp.replace(path)


def drop_index(workspace_id: str, config_id: str) -> None:
    shutil.rmtree(index_dir(workspace_id, config_id), ignore_errors=True)


def index_files(workspace_id: str, config_id: str, key: str) -> tuple[Path, Path]:
    d = index_dir(workspace_id, config_id)
    return d / f"{key}.ids.npy", d / f"{key}.vec.npy"


def index_inputs(config: dict) -> dict:
    """What the index of a configuration is computed from, a missing filter list
    read as empty (configurations saved before it existed)."""
    inputs = {k: config.get(k) for k in INDEX_FIELDS}
    filters = dict(inputs.get("filters") or {})
    for key in FILTER_LISTS:
        filters[key] = filters.get(key) or []
    inputs["filters"] = filters
    return inputs


def config_vocabularies(config: dict, inventory: list[dict]) -> list[dict]:
    """The library vocabularies a configuration encodes: those it names, or all."""
    wanted = set((config.get("filters") or {}).get("vocabularies") or [])
    return [v for v in inventory if not wanted or v["vocabularyId"] in wanted]


def index_state(workspace_id: str, config: dict, inventory: list[dict]) -> list[dict]:
    """Per vocabulary: `built`, `stale` (the vocabulary was re-imported since) or
    `missing`, with the number of concepts encoded."""
    from app.services import vocabulary_library as lib

    built = load_manifest(workspace_id, config["id"]).get("vocabularies") or {}
    out = []
    for v in config_vocabularies(config, inventory):
        entry = built.get(v["vocabularyId"])
        ids_path, vec_path = index_files(workspace_id, config["id"], lib.file_key(v["vocabularyId"]))
        if entry is None or (entry.get("count") and not (ids_path.is_file() and vec_path.is_file())):
            status = "missing"
        elif entry.get("importedAt") != v.get("importedAt"):
            status = "stale"
        else:
            status = "built"
        out.append({
            "vocabularyId": v["vocabularyId"],
            "status": status,
            "count": entry.get("count") if entry else None,
            "builtAt": entry.get("builtAt") if entry else None,
        })
    return out


def usable_index_files(workspace_id: str, config: dict, inventory: list[dict]) -> list[dict]:
    """The index files a search may read: built or stale vocabularies (a stale one
    still answers, it only misses what the re-import added)."""
    from app.services import vocabulary_library as lib

    out = []
    for state in index_state(workspace_id, config, inventory):
        if state["status"] == "missing" or not state["count"]:
            continue
        ids_path, vec_path = index_files(workspace_id, config["id"], lib.file_key(state["vocabularyId"]))
        out.append({"ids": str(ids_path), "vectors": str(vec_path)})
    return out
