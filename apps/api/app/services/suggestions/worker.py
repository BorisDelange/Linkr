"""Suggestion-engine worker: the heavy half of precomputed suggestions, run as a
child process of a job (services/suggestions/jobs.py), never inside uvicorn.

A first semantic index over the non-drug standard concepts peaks at several GB,
and torch may crash on a bad driver: either must take the job down, not the API.
It is therefore standalone — no `app` import — and runs with one of two
interpreters:
  - the API's own (duckdb, numpy) for `score` with syntactic methods only;
  - the embeddings runtime (services/suggestions/runtime.py), which adds
    sentence-transformers + torch, for `probe`, `download`, `embed` and the
    semantic part of `score`.

Usage: python worker.py <command> <spec.json>

Protocol on stdout, one line each: `@@progress <0-100>`, `@@result <json>`,
`@@checkpoint <json>` (`score`: how many source concepts of a stage are written
for good, which is what a paused run resumes from); any other line is log. Errors go to stderr and a non-zero exit.

Index layout (one directory per embedding configuration, one pair of files per
vocabulary): `<dir>/<key>.ids.npy` (int64 concept ids) and `<dir>/<key>.vec.npy`
(float16, L2-normalised rows, so cosine is a dot product). While a vocabulary
is being encoded its chunks sit in `<dir>/<key>.parts/`, which is what lets an
interrupted build resume.
"""

import json
import math
import re
import sys
import time
import unicodedata
from collections import Counter
from pathlib import Path

DEFAULT_EQUIVALENCE = "skos:exactMatch"
# Encoded concepts per chunk file: a crash loses at most one chunk.
CHUNK_CONCEPTS = 20_000
# One matrix product scores SEARCH_SOURCES x SEARCH_TARGETS pairs: about 200 MB
# of float32 scores, plus the target block cast to float32 (150 MB at dim 768).
SEARCH_TARGETS = 50_000
SEARCH_SOURCES = 1024
SYNTACTIC_SOURCES = 64


def progress(pct: float) -> None:
    print(f"@@progress {max(0, min(100, int(pct)))}", flush=True)


def log(line: str) -> None:
    print(line, flush=True)


def result(payload: dict) -> None:
    print("@@result " + json.dumps(payload), flush=True)


def checkpoint(stage: str, done: int, outputs: dict) -> None:
    """The first `done` source concepts of `stage` are on disk: flush first, so a
    kill right after this line cannot lose them."""
    for o in outputs.values():
        o.flush()
    print("@@checkpoint " + json.dumps({"stage": stage, "done": done}), flush=True)


def sql_literal(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def sql_list(values: list[str]) -> str:
    return ", ".join(sql_literal(v) for v in values)


# --- Targets -----------------------------------------------------------------


def target_where(filters: dict) -> str:
    """WHERE clause over the OMOP `concept` columns for a target scope:
    `onlyStandard`, `onlyValid`, `domains`, `vocabularies`, `conceptClasses`
    (empty = all)."""
    clauses = ["concept_name IS NOT NULL", "concept_name <> ''"]
    if filters.get("onlyStandard"):
        clauses.append("standard_concept = 'S'")
    if filters.get("onlyValid"):
        clauses.append("(invalid_reason IS NULL OR invalid_reason = '')")
    if filters.get("domains"):
        clauses.append(f"domain_id IN ({sql_list(filters['domains'])})")
    if filters.get("vocabularies"):
        clauses.append(f"vocabulary_id IN ({sql_list(filters['vocabularies'])})")
    if filters.get("conceptClasses"):
        clauses.append(f"concept_class_id IN ({sql_list(filters['conceptClasses'])})")
    return " AND ".join(clauses)


def concept_reader(paths: list[str]) -> str:
    return f"read_parquet([{sql_list(paths)}], union_by_name = true)"


def encoded_text(template: str, name: str, vocabulary: str, concept_class: str) -> str:
    """The string a target concept is encoded as. `name_class` gives the model the
    vocabulary and class (`Heart rate [LOINC / Clinical Observation]`), which
    separates homonyms across vocabularies; `name` is the bare label."""
    if template == "name" or not vocabulary:
        return name
    label = f"{vocabulary} / {concept_class}" if concept_class else vocabulary
    return f"{name} [{label}]"


# --- Text normalisation (syntactic) -----------------------------------------


def normalize(text: str) -> str:
    """Lowercase + strip diacritics; mirrors DuckDB strip_accents(lower(...))."""
    nfkd = unicodedata.normalize("NFD", text.lower())
    return "".join(c for c in nfkd if not unicodedata.combining(c))


class NgramIdfIndex:
    """Character-bigram IDF-cosine (Usagi's method). Pure Python and slow: about
    an hour of CPU over the 4 million OMOP concepts."""

    def __init__(self, names: list[str], n: int = 2):
        self.n = n
        df_counts: Counter = Counter()
        self.docs: list[Counter] = []
        for name in names:
            counts = Counter(self._grams(name))
            df_counts.update(counts.keys())
            self.docs.append(counts)
        total = len(names) or 1
        self.idf = {g: math.log(total / c) for g, c in df_counts.items() if c > 0}
        self.norms = []
        for doc in self.docs:
            norm = math.sqrt(sum((c * self.idf.get(g, 0)) ** 2 for g, c in doc.items()))
            self.norms.append(norm or 1.0)

    def _grams(self, s: str) -> list[str]:
        s = normalize(s)
        return [s[i:i + self.n] for i in range(len(s) - self.n + 1)] if len(s) >= self.n else [s]

    def top_k(self, query: str, k: int) -> list[tuple[int, float]]:
        q = {g: c * self.idf.get(g, 0) for g, c in Counter(self._grams(query)).items()}
        qnorm = math.sqrt(sum(v * v for v in q.values())) or 1.0
        scores = []
        for idx, (doc, dnorm) in enumerate(zip(self.docs, self.norms)):
            dot = sum(q.get(g, 0) * c * self.idf.get(g, 0) for g, c in doc.items())
            if dot > 0:
                scores.append((idx, dot / (qnorm * dnorm)))
        scores.sort(key=lambda x: -x[1])
        return scores[:k]


# --- Score output ------------------------------------------------------------


CSV_HEADER = "source_vocabulary_id,source_concept_code,concept_id,score,equivalence,comment,created_at\n"


def csv_field(value) -> str:
    if value is None:
        return ""
    text = str(value)
    if any(c in text for c in ',"\n\r'):
        return '"' + text.replace('"', '""') + '"'
    return text


class MethodCsv:
    """One method's rows, in the CSV layout scores_service.merge_method_csvs reads."""

    def __init__(self, path: Path):
        self.path = path
        self.rows = 0
        self.handle = path.open("w", encoding="utf-8", newline="")
        self.handle.write(CSV_HEADER)
        self.created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def add(self, vocabulary: str, code: str, concept_id: int, score: float) -> None:
        self.handle.write(
            ",".join([
                csv_field(vocabulary), csv_field(code), str(int(concept_id)), f"{score:.3f}",
                DEFAULT_EQUIVALENCE, "", self.created_at,
            ]) + "\n"
        )
        self.rows += 1

    def flush(self) -> None:
        self.handle.flush()

    def close(self) -> None:
        self.handle.close()


def method_file_name(method: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", method) + ".csv"


# --- Commands ----------------------------------------------------------------


def cmd_probe(_spec: dict) -> None:
    """Versions and devices of the embeddings runtime."""
    import sentence_transformers
    import torch

    devices = ["cpu"]
    gpu = None
    if torch.cuda.is_available():
        devices.append("cuda")
        gpu = torch.cuda.get_device_name(0)
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        devices.append("mps")
    result({
        "torch": torch.__version__,
        "sentenceTransformers": sentence_transformers.__version__,
        "devices": devices,
        "gpu": gpu,
    })


def cmd_download(spec: dict) -> None:
    """Fetch a model from the Hugging Face Hub (or the mirror HF_ENDPOINT names)
    into `dest`, then load it once to check it is a sentence-transformers model."""
    from huggingface_hub import HfApi, snapshot_download

    dest = Path(spec["dest"])
    dest.mkdir(parents=True, exist_ok=True)
    files = HfApi().list_repo_files(spec["repoId"])
    # A repo often carries the same weights in several formats (PyTorch, ONNX,
    # OpenVINO, TensorFlow): take the safetensors alone when there are some.
    ignore = ["*.h5", "*.msgpack", "*.ot", "onnx/*", "openvino/*", "*.onnx"]
    if any(f.endswith(".safetensors") for f in files):
        ignore.append("*.bin")
    log(f"Downloading {spec['repoId']} …")
    progress(5)
    snapshot_download(repo_id=spec["repoId"], local_dir=str(dest), ignore_patterns=ignore)
    progress(90)
    log("Checking the model loads …")
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(str(dest), device="cpu")
    dim = _dimension(model)
    size = sum(p.stat().st_size for p in dest.rglob("*") if p.is_file())
    result({"dimension": dim, "sizeBytes": size})


def _dimension(model) -> int:
    # sentence-transformers 5 renamed it; the runtime may hold either version.
    getter = getattr(model, "get_embedding_dimension", None) or model.get_sentence_embedding_dimension
    return getter()


def resolve_device(requested: str) -> str:
    import torch

    if requested and requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model(spec: dict):
    from sentence_transformers import SentenceTransformer

    device = resolve_device(spec.get("device") or "auto")
    log(f"Loading the model on {device} …")
    return SentenceTransformer(spec["modelPath"], device=device)


def cmd_embed(spec: dict) -> None:
    """Encode the target concepts of each vocabulary partition into the config's
    index directory. Resumes from the chunks a stopped run left."""
    import duckdb
    import numpy as np

    out_dir = Path(spec["outDir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    where = target_where(spec.get("filters") or {})
    template = spec.get("template") or "name_class"
    batch_size = int(spec.get("batchSize") or 256)
    partitions = spec["partitions"]

    con = duckdb.connect()
    plans = []
    for p in partitions:
        rows = con.execute(
            f"SELECT concept_id, concept_name, vocabulary_id, coalesce(concept_class_id, '') "
            f"FROM read_parquet({sql_literal(p['conceptPath'])}) WHERE {where} ORDER BY concept_id"
        ).fetchall()
        plans.append((p, rows))
    con.close()
    total = sum(len(rows) for _, rows in plans) or 1
    log(f"{total:,} concepts to encode in {len(plans)} vocabularies")

    model = None
    done = 0
    built = []
    for p, rows in plans:
        key = p["key"]
        parts = out_dir / f"{key}.parts"
        if not rows:
            built.append({"vocabularyId": p["vocabularyId"], "count": 0})
            for suffix in (".ids.npy", ".vec.npy"):
                (out_dir / f"{key}{suffix}").unlink(missing_ok=True)
            continue
        parts.mkdir(exist_ok=True)
        encoded: set[int] = set()
        for f in sorted(parts.glob("*.ids.npy")):
            encoded.update(int(i) for i in np.load(f))
        todo = [r for r in rows if int(r[0]) not in encoded]
        done += len(rows) - len(todo)
        if encoded:
            log(f"{p['vocabularyId']}: resuming, {len(encoded):,} already encoded")
        seq = len(list(parts.glob("*.ids.npy")))
        for start in range(0, len(todo), CHUNK_CONCEPTS):
            if model is None:
                model = load_model(spec)
            chunk = todo[start:start + CHUNK_CONCEPTS]
            texts = [encoded_text(template, r[1], r[2], r[3]) for r in chunk]
            vectors = model.encode(
                texts, batch_size=batch_size, show_progress_bar=False,
                convert_to_numpy=True, normalize_embeddings=True,
            ).astype(np.float16)
            seq += 1
            np.save(parts / f"{seq:06d}.vec.npy", vectors)
            # ids last: a chunk counts as encoded only once both files exist.
            np.save(parts / f"{seq:06d}.ids.npy", np.array([int(r[0]) for r in chunk], dtype=np.int64))
            done += len(chunk)
            progress(done / total * 100)
            log(f"{p['vocabularyId']}: {done:,}/{total:,}")
        ids = [np.load(f) for f in sorted(parts.glob("*.ids.npy"))]
        vecs = [np.load(parts / f.name.replace(".ids.npy", ".vec.npy")) for f in sorted(parts.glob("*.ids.npy"))]
        np.save(out_dir / f"{key}.vec.npy", np.concatenate(vecs))
        np.save(out_dir / f"{key}.ids.npy", np.concatenate(ids))
        for f in parts.iterdir():
            f.unlink()
        parts.rmdir()
        built.append({"vocabularyId": p["vocabularyId"], "count": sum(len(i) for i in ids)})
    result({"vocabularies": built, "dimension": _dimension(model) if model else None})


def read_sources(path: str) -> list[tuple[str, str, str]]:
    import duckdb

    con = duckdb.connect()
    try:
        return [
            (str(v or ""), str(c or ""), str(n or ""))
            for v, c, n in con.execute(
                f"SELECT vocabulary_id, concept_code, concept_name FROM read_parquet({sql_literal(path)})"
            ).fetchall()
        ]
    finally:
        con.close()


def score_syntactic(spec: dict, sources, out_dir: Path, report) -> dict[str, MethodCsv]:
    import duckdb

    methods = [m for m in spec["methods"] if m.startswith("syntactic/")]
    k = int(spec.get("topK") or 20)
    outputs = {m: MethodCsv(out_dir / method_file_name(m)) for m in methods}
    con = duckdb.connect()
    try:
        con.execute(
            "CREATE TEMP TABLE target AS SELECT concept_id, strip_accents(lower(concept_name)) AS name_norm, "
            "array_to_string(list_sort(string_split(strip_accents(lower(concept_name)), ' ')), ' ') AS name_sorted, "
            f"concept_name FROM {concept_reader(spec['conceptPaths'])} WHERE {target_where(spec.get('filters') or {})}"
        )
        n_targets = con.execute("SELECT count(*) FROM target").fetchone()[0]
        log(f"Syntactic: {len(sources):,} source concepts against {n_targets:,} targets")
        if n_targets == 0:
            return outputs
        sql_of = {
            "syntactic/jaro-winkler": "jaro_winkler_similarity(s.q, t.name_norm)",
            "syntactic/token-sort": "jaro_winkler_similarity(s.q_sorted, t.name_sorted)",
        }
        ngram = None
        if "syntactic/ngram-idf" in methods:
            log("Building the n-gram IDF index …")
            ids_names = con.execute("SELECT concept_id, concept_name FROM target").fetchall()
            ngram = (NgramIdfIndex([n for _, n in ids_names]), [i for i, _ in ids_names])
        for start in range(0, len(sources), SYNTACTIC_SOURCES):
            chunk = sources[start:start + SYNTACTIC_SOURCES]
            con.execute("CREATE OR REPLACE TEMP TABLE src (i INTEGER, q VARCHAR, q_sorted VARCHAR)")
            con.executemany(
                "INSERT INTO src VALUES (?, ?, ?)",
                [(i, normalize(n), " ".join(sorted(normalize(n).split()))) for i, (_, _, n) in enumerate(chunk)],
            )
            for method, expr in sql_of.items():
                if method not in outputs:
                    continue
                rows = con.execute(
                    f"SELECT s.i, t.concept_id, {expr} AS score FROM src s CROSS JOIN target t "
                    f"QUALIFY row_number() OVER (PARTITION BY s.i ORDER BY score DESC, t.concept_id) <= {k}"
                ).fetchall()
                for i, concept_id, score in rows:
                    v, c, _ = chunk[i]
                    outputs[method].add(v, c, concept_id, float(score))
            if ngram is not None:
                index, ids = ngram
                for v, c, n in chunk:
                    for idx, score in index.top_k(n, k):
                        outputs["syntactic/ngram-idf"].add(v, c, ids[idx], score)
            done = min(len(sources), start + SYNTACTIC_SOURCES)
            checkpoint("syntactic", done, outputs)
            report(done, "syntactic")
    finally:
        con.close()
    return outputs


def top_k_merge(best_scores, best_ids, scores, ids, k: int):
    """Merge a block of candidate scores (sources x targets) into the running
    top-k per source. Rows stay unsorted until the end."""
    import numpy as np

    take = min(k, scores.shape[1])
    if take == 0:
        return best_scores, best_ids
    part = np.argpartition(-scores, take - 1, axis=1)[:, :take]
    block_scores = np.take_along_axis(scores, part, axis=1)
    block_ids = ids[part]
    all_scores = np.concatenate([best_scores, block_scores], axis=1)
    all_ids = np.concatenate([best_ids, block_ids], axis=1)
    keep = min(k, all_scores.shape[1])
    sel = np.argpartition(-all_scores, keep - 1, axis=1)[:, :keep]
    return np.take_along_axis(all_scores, sel, axis=1), np.take_along_axis(all_ids, sel, axis=1)


def allowed_target_ids(spec: dict):
    """Concept ids the score-time filters keep, or None when they keep the whole
    index (no filter beyond what the index was built with)."""
    filters = spec.get("filters") or {}
    if not any(filters.get(f) for f in ("onlyStandard", "onlyValid", "domains", "vocabularies")):
        return None
    import duckdb
    import numpy as np

    con = duckdb.connect()
    try:
        rows = con.execute(
            f"SELECT concept_id FROM {concept_reader(spec['conceptPaths'])} WHERE {target_where(filters)}"
        ).fetchnumpy()
        return np.sort(rows["concept_id"].astype(np.int64))
    finally:
        con.close()


def search_index(index_files: list[tuple[str, str]], queries, k: int, allowed, report=None):
    """Top-k (scores, ids) per query row over the memory-mapped index files."""
    import numpy as np

    n = queries.shape[0]
    best_scores = np.full((n, 0), -np.inf, dtype=np.float32)
    best_ids = np.zeros((n, 0), dtype=np.int64)
    total = 0
    pairs = []
    for ids_path, vec_path in index_files:
        ids = np.load(ids_path, mmap_mode="r")
        vecs = np.load(vec_path, mmap_mode="r")
        pairs.append((ids, vecs))
        total += len(ids)
    seen = 0
    for ids, vecs in pairs:
        for start in range(0, len(ids), SEARCH_TARGETS):
            block_ids = np.asarray(ids[start:start + SEARCH_TARGETS])
            block = np.asarray(vecs[start:start + SEARCH_TARGETS], dtype=np.float32)
            if allowed is not None:
                keep = np.isin(block_ids, allowed, assume_unique=False)
                block_ids, block = block_ids[keep], block[keep]
            if len(block_ids):
                scores = queries @ block.T
                best_scores, best_ids = top_k_merge(best_scores, best_ids, scores, block_ids, k)
            seen += min(SEARCH_TARGETS, len(ids) - start)
            if report:
                report(seen / max(total, 1))
    order = np.argsort(-best_scores, axis=1)
    return np.take_along_axis(best_scores, order, axis=1), np.take_along_axis(best_ids, order, axis=1)


def score_semantic(spec: dict, sources, out_dir: Path, report) -> dict[str, MethodCsv]:
    import numpy as np

    sem = spec["semantic"]
    method = sem["method"]
    k = int(spec.get("topK") or 20)
    output = MethodCsv(out_dir / method_file_name(method))
    model = load_model(sem)
    log(f"Encoding {len(sources):,} source concepts …")
    queries = model.encode(
        [n for _, _, n in sources], batch_size=int(sem.get("batchSize") or 256),
        show_progress_bar=False, convert_to_numpy=True, normalize_embeddings=True,
    ).astype(np.float32)
    allowed = allowed_target_ids(spec)
    files = [(f["ids"], f["vectors"]) for f in sem["indexFiles"]]
    for start in range(0, len(sources), SEARCH_SOURCES):
        block = queries[start:start + SEARCH_SOURCES]
        scores, ids = search_index(files, block, k, allowed)
        for row in range(block.shape[0]):
            v, c, _ = sources[start + row]
            for score, concept_id in zip(scores[row], ids[row]):
                if np.isfinite(score):
                    output.add(v, c, int(concept_id), float(score))
        done = min(len(sources), start + block.shape[0])
        checkpoint("semantic", done, {method: output})
        report(done, "semantic")
    return {method: output}


def cmd_score(spec: dict) -> None:
    """Score a project's source concepts; one CSV per method in `outDir`. A resumed
    run gives the semantic stage its own list (`semanticSourcesPath`): the two
    stages may have stopped at different places."""
    out_dir = Path(spec["outDir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    sources = read_sources(spec["sourcesPath"])
    semantic_sources = read_sources(spec["semanticSourcesPath"]) if spec.get("semanticSourcesPath") else sources
    stages = [s for s in ("syntactic", "semantic") if (s == "semantic" and spec.get("semantic") and semantic_sources)
              or (s == "syntactic" and sources and any(m.startswith("syntactic/") for m in spec["methods"]))]
    totals = {"syntactic": len(sources), "semantic": len(semantic_sources)}
    # Progress counts units (one source concept through one stage); a resumed run
    # starts from the units its paused run had finished (`progress.done` of `.total`).
    base = spec.get("progress") or {}
    before = int(base.get("done") or 0)
    overall = int(base.get("total") or 0) or sum(totals[s] for s in stages)

    def report(done: int, stage: str) -> None:
        finished = sum(totals[s] for s in stages[:stages.index(stage)])
        progress((before + finished + done) / max(overall, 1) * 100)

    outputs: dict[str, MethodCsv] = {}
    if "syntactic" in stages:
        outputs.update(score_syntactic(spec, sources, out_dir, report))
    if "semantic" in stages:
        outputs.update(score_semantic(spec, semantic_sources, out_dir, report))
    for o in outputs.values():
        o.close()
    result({"methods": {m: {"path": str(o.path), "rows": o.rows} for m, o in outputs.items()}})


def cmd_search(spec: dict) -> None:
    """Semantic search of free texts against one configuration's index."""
    import numpy as np

    model = load_model(spec)
    queries = model.encode(
        spec["texts"], show_progress_bar=False, convert_to_numpy=True, normalize_embeddings=True,
    ).astype(np.float32)
    allowed = allowed_target_ids(spec)
    files = [(f["ids"], f["vectors"]) for f in spec["indexFiles"]]
    scores, ids = search_index(files, queries, int(spec.get("topK") or 20), allowed)
    result({
        "matches": [
            [{"conceptId": int(i), "score": round(float(s), 4)} for s, i in zip(scores[r], ids[r]) if np.isfinite(s)]
            for r in range(len(spec["texts"]))
        ]
    })


COMMANDS = {
    "probe": cmd_probe,
    "download": cmd_download,
    "embed": cmd_embed,
    "score": cmd_score,
    "search": cmd_search,
}


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in COMMANDS:
        print(f"usage: worker.py {{{'|'.join(COMMANDS)}}} <spec.json>", file=sys.stderr)
        return 2
    spec = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    COMMANDS[sys.argv[1]](spec)
    return 0


if __name__ == "__main__":
    sys.exit(main())
