#!/usr/bin/env python3
"""
compute_scores.py — Script 2/2: computes syntactic and semantic similarity scores
between a project's source concepts and OMOP target concepts.

Usage:
    python compute_scores.py \\
        --source /path/to/source-concepts.csv \\
        --concept /path/to/CONCEPT.parquet \\
        --embeddings /path/to/concept_embeddings.parquet \\
        [options]

Output:
    similarity-scores.parquet — long format:
        source_vocabulary_id | source_concept_code | concept_id | method | score
        | equivalence | comment | created_at

    For syntactic/* and semantic/* methods, equivalence is always
    "skos:exactMatch" and comment is null. The equivalence column exists so
    AI-generated rows (method = "ai/<model-id>") can use the full SKOS range
    (closeMatch, broadMatch, narrowMatch, relatedMatch) and provide a comment.

    Methods computed (all by default):
        syntactic/jaro-winkler   Jaro-Winkler on normalized name
        syntactic/token-sort     Token Sort Ratio (better for multi-word names)
        syntactic/ngram-idf      Character bigram IDF-cosine (Usagi's method)
        semantic/biolord         Cosine similarity on BioLORD embeddings

Supports incremental writing and resume: if the output file already exists,
already-scored (source_vocabulary_id, source_concept_code) pairs are skipped
automatically. Safe to interrupt and restart at any time.

The output is loaded by the Linkr frontend to populate the Suggestions panel.
Source concept uniqueness key: (source_vocabulary_id, source_concept_code).

Dependencies:
    pip install rapidfuzz pandas pyarrow numpy
    pip install sentence-transformers  # only needed for semantic/biolord
"""

import argparse
import gc
import math
import os
import sys
import time
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

# OpenMP runtime conflict workaround for Apple Silicon: importing FAISS after
# PyTorch (loaded by sentence-transformers) causes segfaults on macOS because
# both ship their own libomp. Set the env var and import FAISS *first*, before
# anything that pulls torch, so the FAISS OpenMP runtime wins the symbol race.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
try:
    import faiss  # noqa: F401  (imported for side effect: lock in libomp)
except ImportError:
    faiss = None  # type: ignore[assignment]

import duckdb
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from rapidfuzz import fuzz as rfuzz
from rapidfuzz.distance import JaroWinkler

TOP_K = 50
FLUSH_EVERY = 100
DEFAULT_OUTPUT = None  # derived from --source path: same folder, similarity-scores.parquet
DEFAULT_EQUIVALENCE = "skos:exactMatch"

PARQUET_SCHEMA = pa.schema([
    pa.field("source_vocabulary_id", pa.string()),
    pa.field("source_concept_code",  pa.string()),
    pa.field("concept_id",           pa.int64()),
    pa.field("method",               pa.string()),
    pa.field("score",                pa.float32()),
    pa.field("equivalence",          pa.string()),
    pa.field("comment",              pa.string()),
    pa.field("created_at",           pa.string()),
])


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Text normalization
# ---------------------------------------------------------------------------

def normalize(text: str) -> str:
    """Lowercase + strip diacritics. Mirrors DuckDB strip_accents(LOWER(...))."""
    nfkd = unicodedata.normalize("NFD", text.lower())
    return "".join(c for c in nfkd if not unicodedata.combining(c))


# ---------------------------------------------------------------------------
# Syntactic similarity
# ---------------------------------------------------------------------------

def jaro_winkler_score(a: str, b: str) -> float:
    return JaroWinkler.normalized_similarity(normalize(a), normalize(b))


def token_sort_score(a: str, b: str) -> float:
    return rfuzz.token_sort_ratio(normalize(a), normalize(b)) / 100.0


class NgramIdfIndex:
    """Character bigram + IDF-cosine index. Replicates Usagi's scoring method."""

    def __init__(self, names: list[str], n: int = 2):
        self.n = n
        self.names = names
        self._build(names)

    def _ngrams(self, s: str) -> list[str]:
        s = normalize(s)
        return [s[i : i + self.n] for i in range(len(s) - self.n + 1)] if len(s) >= self.n else [s]

    def _build(self, names: list[str]) -> None:
        N = len(names)
        df_counts: Counter = Counter()
        self._doc_vecs: list[dict[str, float]] = []
        t_start = time.time()
        for i, name in enumerate(names):
            grams = self._ngrams(name)
            counts = Counter(grams)
            df_counts.update(counts.keys())
            self._doc_vecs.append(counts)
            if (i + 1) % 500_000 == 0 or (i + 1) == N:
                elapsed = time.time() - t_start
                pct = (i + 1) / N * 100
                speed = (i + 1) / elapsed if elapsed > 0 else 0
                eta = (N - i - 1) / speed if speed > 0 else 0
                eta_min, eta_sec = divmod(int(eta), 60)
                print(
                    f"[index] {i + 1:,}/{N:,} concepts ({pct:.1f}%) — "
                    f"{speed:,.0f} concepts/s — ETA {eta_min}m{eta_sec:02d}s",
                    flush=True,
                )

        # IDF = log(N / df), matching Usagi's formula
        self._idf: dict[str, float] = {
            gram: math.log(N / cnt) for gram, cnt in df_counts.items() if cnt > 0
        }

        self._doc_norms: list[float] = []
        for vec in self._doc_vecs:
            norm = math.sqrt(sum((cnt * self._idf.get(g, 0)) ** 2 for g, cnt in vec.items()))
            self._doc_norms.append(norm if norm > 0 else 1.0)

    def query_vector(self, text: str) -> tuple[dict[str, float], float]:
        grams = self._ngrams(text)
        counts = Counter(grams)
        vec = {g: cnt * self._idf.get(g, 0) for g, cnt in counts.items()}
        norm = math.sqrt(sum(v ** 2 for v in vec.values()))
        return vec, norm if norm > 0 else 1.0

    def top_k(self, query: str, k: int) -> list[tuple[int, float]]:
        """Returns the top-k (index, cosine_score) pairs from self.names."""
        qvec, qnorm = self.query_vector(query)
        scores = []
        for idx, (dvec, dnorm) in enumerate(zip(self._doc_vecs, self._doc_norms)):
            dot = sum(qvec.get(g, 0) * w for g, w in
                      ((g, cnt * self._idf.get(g, 0)) for g, cnt in dvec.items()))
            scores.append((idx, dot / (qnorm * dnorm)))
        scores.sort(key=lambda x: -x[1])
        return scores[:k]


# ---------------------------------------------------------------------------
# Incremental parquet I/O
# ---------------------------------------------------------------------------

def load_already_scored(output_path: Path) -> set[tuple[str, str]]:
    """Returns set of (source_vocabulary_id, source_concept_code) already in output."""
    if not output_path.exists():
        return set()
    try:
        existing = pq.read_table(
            str(output_path),
            columns=["source_vocabulary_id", "source_concept_code"],
        )
        df = existing.to_pandas().drop_duplicates()
        done = set(zip(df["source_vocabulary_id"], df["source_concept_code"]))
        print(f"  -> resuming: {len(done):,} source concepts already scored, skipping them")
        return done
    except Exception as e:
        print(f"  -> warning: could not read existing output ({e}), starting fresh")
        return set()


def flush_to_parquet(output_path: Path, buf: list[dict]) -> None:
    table = pa.table(
        {
            "source_vocabulary_id": pa.array([r["source_vocabulary_id"] for r in buf], type=pa.string()),
            "source_concept_code":  pa.array([r["source_concept_code"]  for r in buf], type=pa.string()),
            "concept_id":           pa.array([r["concept_id"]           for r in buf], type=pa.int64()),
            "method":               pa.array([r["method"]               for r in buf], type=pa.string()),
            "score":                pa.array([r["score"]                for r in buf], type=pa.float32()),
            "equivalence":          pa.array([r["equivalence"]          for r in buf], type=pa.string()),
            "comment":              pa.array([r["comment"]              for r in buf], type=pa.string()),
            "created_at":           pa.array([r["created_at"]           for r in buf], type=pa.string()),
        },
        schema=PARQUET_SCHEMA,
    )
    if output_path.exists():
        existing = pq.read_table(str(output_path))
        # Coerce existing schema to PARQUET_SCHEMA — earlier runs may have
        # written `comment` as type `null` (when all rows had None), which
        # is incompatible with the new `string` column.
        if existing.schema != PARQUET_SCHEMA:
            existing = existing.cast(PARQUET_SCHEMA)
        combined = pa.concat_tables([existing, table])
        pq.write_table(combined, str(output_path), compression="snappy")
    else:
        pq.write_table(table, str(output_path), compression="snappy")


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_source_concepts(path: Path) -> pd.DataFrame:
    df = pd.read_csv(str(path), low_memory=False)
    required = {"terminology", "concept_code", "concept_name"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Missing columns in source-concepts.csv: {missing}")
    df = df.rename(columns={"terminology": "source_vocabulary_id",
                             "concept_code": "source_concept_code",
                             "concept_name": "source_concept_name"})
    df["source_vocabulary_id"] = df["source_vocabulary_id"].fillna("").astype(str)
    df["source_concept_code"] = df["source_concept_code"].fillna("").astype(str)
    df["source_concept_name"] = df["source_concept_name"].fillna("").astype(str)
    return df[["source_vocabulary_id", "source_concept_code", "source_concept_name"]].drop_duplicates(
        subset=["source_vocabulary_id", "source_concept_code"]
    )


def load_concept_table(path: Path) -> pd.DataFrame:
    cols = ["concept_id", "concept_name", "vocabulary_id", "domain_id",
            "concept_class_id", "standard_concept", "invalid_reason"]
    p = str(path)
    if p.endswith(".parquet"):
        df = pd.read_parquet(p, columns=cols)
    else:
        df = pd.read_csv(p, usecols=cols, low_memory=False)
    df["concept_id"] = df["concept_id"].astype(int)
    df["concept_name"] = df["concept_name"].fillna("").astype(str)
    return df


def load_embeddings(path: Path) -> tuple[np.ndarray, pd.Series, str]:
    """Returns (N×D matrix, concept_id series, model_id).

    Streams the parquet row-group by row-group into a single contiguous
    float32 array. Avoids the previous `np.vstack(df["embedding"].tolist())`
    pattern which materialized millions of Python lists at once.
    """
    pf = pq.ParquetFile(str(path))
    n_total = pf.metadata.num_rows
    # Peek at one batch to discover the embedding dimension.
    first = next(pf.iter_batches(batch_size=1, columns=["embedding"]))
    dim = len(first.column("embedding")[0])

    matrix = np.empty((n_total, dim), dtype=np.float32)
    ids = np.empty(n_total, dtype=np.int64)
    model_id: str | None = None
    row = 0
    t_start = time.time()
    for batch in pf.iter_batches(
        batch_size=50_000,
        columns=["concept_id", "embedding", "model_id"],
    ):
        n = batch.num_rows
        # to_numpy(zero_copy_only=False) on a ListArray of float32 returns an
        # object array of numpy arrays — fast to stack into one contiguous block.
        arr = np.stack(batch.column("embedding").to_numpy(zero_copy_only=False)).astype(
            np.float32, copy=False
        )
        matrix[row : row + n] = arr
        ids[row : row + n] = batch.column("concept_id").to_numpy()
        if model_id is None:
            model_id = batch.column("model_id")[0].as_py()
        row += n
        if row % 500_000 < 50_000 or row == n_total:
            elapsed = time.time() - t_start
            speed = row / elapsed if elapsed > 0 else 0
            print(
                f"[embed-load] {row:,}/{n_total:,} ({row / n_total * 100:.1f}%) — "
                f"{speed:,.0f} rows/s",
                flush=True,
            )
    assert model_id is not None
    return matrix, pd.Series(ids), model_id


# ---------------------------------------------------------------------------
# Semantic scores
# ---------------------------------------------------------------------------

def compute_semantic_scores(
    source_df: pd.DataFrame,
    emb_matrix: np.ndarray,
    emb_concept_ids: pd.Series,
    model_id: str,
    k: int,
    output_path: Path,
    flush_every: int,
    already_done: set[tuple[str, str]],
    n_already_flushed: int,
    source_embeddings_path: Path | None = None,
) -> int:
    """Returns total number of source concepts scored (including previously flushed)."""
    from sentence_transformers import SentenceTransformer

    remaining = source_df[
        ~source_df.apply(lambda r: (r["source_vocabulary_id"], r["source_concept_code"]) in already_done, axis=1)
    ].reset_index(drop=True)

    if remaining.empty:
        print("  [semantic] all source concepts already scored, skipping")
        return n_already_flushed

    # Resume optimization: if source embeddings for the remaining concepts are
    # already on disk (e.g. previous run encoded everything then crashed during
    # FAISS index build), reload them instead of re-encoding.
    query_vecs = None
    existing_src_df: pd.DataFrame | None = None
    if source_embeddings_path is not None and source_embeddings_path.exists():
        try:
            existing_src_df = pq.read_table(str(source_embeddings_path)).to_pandas()
            existing_keys = set(zip(
                existing_src_df["source_vocabulary_id"],
                existing_src_df["source_concept_code"],
            ))
            remaining_keys = set(zip(
                remaining["source_vocabulary_id"],
                remaining["source_concept_code"],
            ))
            if remaining_keys.issubset(existing_keys):
                idx_df = existing_src_df.set_index(["source_vocabulary_id", "source_concept_code"])
                ordered = idx_df.loc[list(remaining_keys.intersection(existing_keys))]
                # Re-order to match `remaining` row order
                ordered = idx_df.loc[[
                    (v, c) for v, c in zip(
                        remaining["source_vocabulary_id"],
                        remaining["source_concept_code"],
                    )
                ]]
                query_vecs = np.stack(ordered["embedding"].tolist()).astype(np.float32, copy=False)
                model_id = ordered["model_id"].iloc[0]
                print(
                    f"  [semantic] reusing {len(query_vecs)} source embeddings from "
                    f"{source_embeddings_path}",
                    flush=True,
                )
                del existing_src_df, idx_df, ordered
                gc.collect()
        except Exception as e:
            print(f"  warning: could not reuse source embeddings ({e}), re-encoding", file=sys.stderr)
            query_vecs = None

    if query_vecs is None:
        print(f"  Loading model {model_id} ...")
        model = SentenceTransformer(model_id)

        texts = remaining["source_concept_name"].tolist()
        print(f"  Encoding {len(texts)} source concepts ...", flush=True)
        query_vecs = model.encode(texts, batch_size=64, show_progress_bar=False,
                                  convert_to_numpy=True, normalize_embeddings=True)
        print(f"  [semantic] source concepts encoded", flush=True)
        del texts, model
        gc.collect()

        if source_embeddings_path is not None:
            src_table = pa.table({
                "source_vocabulary_id": pa.array(remaining["source_vocabulary_id"].tolist(), type=pa.string()),
                "source_concept_code":  pa.array(remaining["source_concept_code"].tolist(),  type=pa.string()),
                "source_concept_name":  pa.array(remaining["source_concept_name"].tolist(),  type=pa.string()),
                "model_id":             pa.array([model_id] * len(remaining),                type=pa.string()),
                "embedding":            pa.array([v.tolist() for v in query_vecs],
                                                 type=pa.list_(pa.float32())),
            })
            if source_embeddings_path.exists():
                existing_src = pq.read_table(str(source_embeddings_path))
                src_table = pa.concat_tables([existing_src, src_table])
            pq.write_table(src_table, str(source_embeddings_path), compression="snappy")
            print(f"  [semantic] source embeddings saved to {source_embeddings_path}", flush=True)

    # FAISS IndexFlatIP fuses GEMM + top-K → no n_source × n_omop materialization.
    # Both query and reference vectors must be contiguous float32 and L2-normalized
    # (cosine = dot product). `normalize_embeddings=True` was used above and
    # embed_concepts.py normalizes too — we still re-normalize defensively.
    # FAISS is imported at module top to lock in its libomp before torch loads.
    if faiss is None:
        print("Error: faiss is not installed. Run `pip install faiss-cpu`.",
              file=sys.stderr)
        sys.exit(1)

    n_omop, dim = emb_matrix.shape
    print(
        f"  Building FAISS IndexFlatIP ({n_omop:,} × {dim}, "
        f"{emb_matrix.nbytes / 1e9:.1f} GB) ...",
        flush=True,
    )
    if not emb_matrix.flags["C_CONTIGUOUS"] or emb_matrix.dtype != np.float32:
        emb_matrix = np.ascontiguousarray(emb_matrix, dtype=np.float32)
    try:
        faiss.omp_set_num_threads(min(4, max(1, faiss.omp_get_max_threads())))
    except Exception:
        pass

    # Normalize and add by chunks to avoid OpenMP-related segfaults and to keep
    # the working set small on machines with limited RAM.
    ADD_CHUNK = 100_000
    index = faiss.IndexFlatIP(dim)
    t_add = time.time()
    for start in range(0, n_omop, ADD_CHUNK):
        end = min(start + ADD_CHUNK, n_omop)
        chunk = np.ascontiguousarray(emb_matrix[start:end])
        faiss.normalize_L2(chunk)
        index.add(chunk)
        if (start // ADD_CHUNK) % 5 == 0 or end == n_omop:
            elapsed = time.time() - t_add
            speed = end / elapsed if elapsed > 0 else 0
            print(
                f"[index-add] {end:,}/{n_omop:,} ({end / n_omop * 100:.1f}%) — "
                f"{speed:,.0f} vec/s",
                flush=True,
            )
    # Free the source matrix — FAISS holds its own copy inside the index.
    # Drops peak RAM from ~2× emb_matrix to ~1× during the search phase.
    del emb_matrix
    gc.collect()
    print(f"  [semantic] FAISS index ready ({index.ntotal:,} vectors)", flush=True)

    if not query_vecs.flags["C_CONTIGUOUS"] or query_vecs.dtype != np.float32:
        query_vecs = np.ascontiguousarray(query_vecs, dtype=np.float32)
    faiss.normalize_L2(query_vecs)

    concept_ids_arr = emb_concept_ids.to_numpy()
    total = len(remaining)
    t_start = time.time()
    buf: list[dict] = []
    SEARCH_BATCH = 256

    for batch_start in range(0, total, SEARCH_BATCH):
        batch_end = min(batch_start + SEARCH_BATCH, total)
        D, I = index.search(query_vecs[batch_start:batch_end], k)

        for offset in range(batch_end - batch_start):
            i = batch_start + offset
            src_row = remaining.iloc[i]
            created_at = now_iso()
            for rank in range(k):
                idx = int(I[offset, rank])
                if idx < 0:
                    continue
                buf.append({
                    "source_vocabulary_id": src_row["source_vocabulary_id"],
                    "source_concept_code":  src_row["source_concept_code"],
                    "concept_id":           int(concept_ids_arr[idx]),
                    "method":               "semantic/biolord",
                    "score":                round(float(D[offset, rank]), 3),
                    "equivalence":          DEFAULT_EQUIVALENCE,
                    "comment":              None,
                    "created_at":           created_at,
                })

            done = i + 1
            if done % flush_every == 0 or done == total:
                flush_to_parquet(output_path, buf)
                total_written = n_already_flushed + done
                print(f"[flush] {total_written:,} source concepts saved to {output_path}", flush=True)
                buf = []

        done = batch_end
        elapsed = time.time() - t_start
        pct = done / total * 100
        speed = done / elapsed if elapsed > 0 else 0
        eta = (total - done) / speed if speed > 0 else 0
        eta_min, eta_sec = divmod(int(eta), 60)
        print(
            f"[semantic] {done}/{total} concepts ({pct:.1f}%) — "
            f"{speed:.1f} concepts/s — ETA {eta_min}m{eta_sec:02d}s",
            flush=True,
        )

    if buf:
        flush_to_parquet(output_path, buf)
        print(f"[flush] {n_already_flushed + total:,} source concepts saved to {output_path}", flush=True)

    return n_already_flushed + total


# ---------------------------------------------------------------------------
# Syntactic scores
# ---------------------------------------------------------------------------

def compute_syntactic_scores(
    source_df: pd.DataFrame,
    concept_df: pd.DataFrame,
    k: int,
    methods: list[str],
    output_path: Path,
    flush_every: int,
    already_done: set[tuple[str, str]],
    n_already_flushed: int,
) -> int:
    """Returns total number of source concepts scored (including previously flushed).

    Uses DuckDB's native jaro_winkler_similarity for the heavy lifting. The OMOP
    concept names are normalized once into a temporary DuckDB table; each source
    concept then runs a single SQL query with ORDER BY ... LIMIT k.
    """
    remaining = source_df[
        ~source_df.apply(lambda r: (r["source_vocabulary_id"], r["source_concept_code"]) in already_done, axis=1)
    ].reset_index(drop=True)

    if remaining.empty:
        print("  [syntactic] all source concepts already scored, skipping")
        return n_already_flushed

    use_jw = "syntactic/jaro-winkler" in methods
    use_ts = "syntactic/token-sort" in methods
    use_ng = "syntactic/ngram-idf" in methods

    ngram_index = None
    if use_ng:
        print("  Building n-gram IDF index ...", flush=True)
        ngram_index = NgramIdfIndex(concept_df["concept_name"].tolist(), n=2)
        print("  [syntactic] n-gram IDF index ready", flush=True)

    con = duckdb.connect()
    try:
        con.execute("PRAGMA threads=8")
    except Exception:
        pass

    if use_jw or use_ts:
        print("  Preparing DuckDB concept table (normalize once) ...", flush=True)
        con.register("concept_df", concept_df[["concept_id", "concept_name"]])
        con.execute("""
            CREATE TEMP TABLE concept_norm AS
            SELECT
                concept_id,
                strip_accents(LOWER(concept_name)) AS name_norm
            FROM concept_df
        """)
        con.unregister("concept_df")
        n_omop = con.execute("SELECT COUNT(*) FROM concept_norm").fetchone()[0]
        print(f"  [syntactic] {n_omop:,} OMOP concept names normalized", flush=True)

    total = len(remaining)
    t_start = time.time()
    buf: list[dict] = []
    ngram_concept_ids = concept_df["concept_id"].tolist() if use_ng else None

    for i, src_row in enumerate(remaining.itertuples(index=False)):
        query = src_row.source_concept_name
        vocab_id = src_row.source_vocabulary_id
        code = src_row.source_concept_code
        created_at = now_iso()
        query_norm = normalize(query)

        if use_jw:
            rows = con.execute(
                """
                SELECT concept_id,
                       jaro_winkler_similarity(?, name_norm) AS score
                FROM concept_norm
                ORDER BY score DESC
                LIMIT ?
                """,
                [query_norm, k],
            ).fetchall()
            for cid, score in rows:
                buf.append({
                    "source_vocabulary_id": vocab_id,
                    "source_concept_code":  code,
                    "concept_id":           int(cid),
                    "method":               "syntactic/jaro-winkler",
                    "score":                round(float(score), 3),
                    "equivalence":          DEFAULT_EQUIVALENCE,
                    "comment":              None,
                    "created_at":           created_at,
                })

        if use_ts:
            # token-sort: sort whitespace-separated tokens then compare with Jaro-Winkler.
            # We sort source side in Python; OMOP side is sorted in SQL via list_sort(string_split).
            query_ts = " ".join(sorted(query_norm.split()))
            rows = con.execute(
                """
                SELECT concept_id,
                       jaro_winkler_similarity(
                           ?,
                           array_to_string(list_sort(string_split(name_norm, ' ')), ' ')
                       ) AS score
                FROM concept_norm
                ORDER BY score DESC
                LIMIT ?
                """,
                [query_ts, k],
            ).fetchall()
            for cid, score in rows:
                buf.append({
                    "source_vocabulary_id": vocab_id,
                    "source_concept_code":  code,
                    "concept_id":           int(cid),
                    "method":               "syntactic/token-sort",
                    "score":                round(float(score), 3),
                    "equivalence":          DEFAULT_EQUIVALENCE,
                    "comment":              None,
                    "created_at":           created_at,
                })

        if use_ng and ngram_index is not None and ngram_concept_ids is not None:
            for idx, score in ngram_index.top_k(query, k):
                buf.append({
                    "source_vocabulary_id": vocab_id,
                    "source_concept_code":  code,
                    "concept_id":           ngram_concept_ids[idx],
                    "method":               "syntactic/ngram-idf",
                    "score":                round(score, 3),
                    "equivalence":          DEFAULT_EQUIVALENCE,
                    "comment":              None,
                    "created_at":           created_at,
                })

        done = i + 1
        if done % flush_every == 0 or done == total:
            flush_to_parquet(output_path, buf)
            total_written = n_already_flushed + done
            print(f"[flush] {total_written:,} source concepts saved to {output_path}", flush=True)
            buf = []

        if done % 100 == 0 or done == total:
            elapsed = time.time() - t_start
            pct = done / total * 100
            speed = done / elapsed if elapsed > 0 else 0
            eta = (total - done) / speed if speed > 0 else 0
            eta_min, eta_sec = divmod(int(eta), 60)
            print(
                f"[syntactic] {done}/{total} concepts ({pct:.1f}%) — "
                f"{speed:.1f} concepts/s — ETA {eta_min}m{eta_sec:02d}s",
                flush=True,
            )

    con.close()
    return n_already_flushed + total


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compute syntactic and semantic similarity scores for a mapping project."
    )
    parser.add_argument("--source", required=True,
                        help="source-concepts.csv from the Linkr mapping project")
    parser.add_argument("--concept", required=True,
                        help="CONCEPT.parquet or CONCEPT.csv (OMOP vocabularies)")
    parser.add_argument("--embeddings",
                        help="concept_embeddings.parquet from embed_concepts.py. "
                             "If absent, semantic scores are skipped.")
    parser.add_argument("--output", default=None,
                        help="Output file (default: similarity-scores.parquet next to --source)")
    parser.add_argument("--source-embeddings", default=None,
                        help="Where to save source concept embeddings "
                             "(default: source_embeddings.parquet next to --source)")
    parser.add_argument("--top-k", type=int, default=TOP_K,
                        help=f"Candidates to keep per source concept per method (default: {TOP_K})")
    parser.add_argument("--flush-every", type=int, default=FLUSH_EVERY,
                        help=f"Append to parquet every N source concepts (default: {FLUSH_EVERY})")
    parser.add_argument("--methods", nargs="+",
                        default=["syntactic/jaro-winkler", "semantic/biolord"],
                        help="Methods to compute (default: jaro-winkler + biolord)")
    parser.add_argument("--only-standard", action="store_true",
                        help="Restrict target concepts to standard concepts (standard_concept='S')")
    parser.add_argument("--only-valid", action="store_true",
                        help="Exclude invalid target concepts (non-empty invalid_reason)")
    parser.add_argument("--domain", nargs="+",
                        help="Filter target concepts by domain_id")
    parser.add_argument("--vocabulary", nargs="+",
                        help="Filter target concepts by vocabulary_id")
    args = parser.parse_args()

    source_path = Path(args.source)
    concept_path = Path(args.concept)
    output_path = Path(args.output) if args.output else source_path.parent / "similarity-scores.parquet"
    source_embeddings_path = (
        Path(args.source_embeddings) if args.source_embeddings
        else source_path.parent / "source_embeddings.parquet"
    )
    print(f"Output scores:            {output_path}")
    print(f"Output source embeddings: {source_embeddings_path}")

    for p in [source_path, concept_path]:
        if not p.exists():
            print(f"Error: file not found: {p}", file=sys.stderr)
            sys.exit(1)

    has_semantic = "semantic/biolord" in args.methods
    emb_path = Path(args.embeddings) if args.embeddings else None
    if has_semantic and (emb_path is None or not emb_path.exists()):
        print("Warning: --embeddings missing or not found. Semantic scores will be skipped.",
              file=sys.stderr)
        has_semantic = False

    syntactic_methods = [m for m in args.methods if m.startswith("syntactic/")]

    print(f"Loading source concepts from {source_path} ...")
    source_df = load_source_concepts(source_path)
    print(f"  -> {len(source_df):,} unique source concepts")

    print(f"Loading CONCEPT from {concept_path} ...")
    concept_df = load_concept_table(concept_path)
    total = len(concept_df)

    if args.only_standard:
        concept_df = concept_df[concept_df["standard_concept"] == "S"]
        print(f"  -> standard filter: {len(concept_df):,} / {total:,}")
    if args.only_valid:
        concept_df = concept_df[concept_df["invalid_reason"].fillna("") == ""]
        print(f"  -> valid filter:    {len(concept_df):,}")
    if args.domain:
        concept_df = concept_df[concept_df["domain_id"].isin(args.domain)]
        print(f"  -> domain filter:   {len(concept_df):,}")
    if args.vocabulary:
        concept_df = concept_df[concept_df["vocabulary_id"].isin(args.vocabulary)]
        print(f"  -> vocab filter:    {len(concept_df):,}")

    if concept_df.empty:
        print("No target concepts remaining after filtering.", file=sys.stderr)
        sys.exit(1)

    # Resume: find already-scored (vocab_id, concept_code) pairs across all methods.
    # A pair is considered done only if ALL requested methods are present for it.
    already_done: set[tuple[str, str]] = set()
    if output_path.exists():
        try:
            existing = pq.read_table(
                str(output_path),
                columns=["source_vocabulary_id", "source_concept_code", "method"],
            ).to_pandas()
            requested_methods = set(syntactic_methods + (["semantic/biolord"] if has_semantic else []))
            grouped = existing.groupby(["source_vocabulary_id", "source_concept_code"])["method"].apply(set)
            already_done = {
                (vid, code)
                for (vid, code), methods_present in grouped.items()
                if requested_methods.issubset(methods_present)
            }
            if already_done:
                print(f"  -> resuming: {len(already_done):,} source concepts fully scored, skipping them")
        except Exception as e:
            print(f"  -> warning: could not read existing output ({e}), starting fresh")

    n_flushed = len(already_done)

    if syntactic_methods:
        print(f"\nComputing syntactic scores ({', '.join(syntactic_methods)}) ...")
        n_flushed = compute_syntactic_scores(
            source_df, concept_df, args.top_k, syntactic_methods,
            output_path, args.flush_every, already_done, n_flushed,
        )

    if has_semantic and emb_path is not None:
        print(f"\nComputing semantic scores from {emb_path} ...")
        emb_matrix, emb_ids, model_id = load_embeddings(emb_path)
        n_flushed = compute_semantic_scores(
            source_df, emb_matrix, emb_ids, model_id, args.top_k,
            output_path, args.flush_every, already_done, n_flushed,
            source_embeddings_path=source_embeddings_path,
        )

    if not output_path.exists():
        print("No scores computed.", file=sys.stderr)
        sys.exit(1)

    size_kb = output_path.stat().st_size / 1024
    final = pq.read_table(str(output_path))
    n_rows = len(final)
    n_src = len(
        pa.compute.unique(
            pa.chunked_array([final.column("source_concept_code")])
        )
    )
    print(f"\n  -> {n_rows:,} rows, {n_src:,} source concepts, {size_kb:.0f} KB")

    try:
        import subprocess
        script_dir = Path(__file__).resolve().parent
        update_state = script_dir / "update_state.py"
        if update_state.exists():
            subprocess.run(
                [sys.executable, str(update_state),
                 "--project-dir", str(source_path.parent),
                 "--vocab-dir",   str(concept_path.parent),
                 "--methods-event", "scores_done",
                 "--quiet"],
                check=False,
            )
            print(f"[state] updated {source_path.parent / 'state.json'}")
    except Exception as e:
        print(f"  warning: state.json update failed ({e})", file=sys.stderr)

    print("Done.")


if __name__ == "__main__":
    main()
