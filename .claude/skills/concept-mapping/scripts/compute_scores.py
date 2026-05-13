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
    scores.parquet  — long format:
        source_vocabulary_id | source_concept_code | concept_id | method | score

    Methods computed (all by default):
        syntactic/jaro-winkler   Jaro-Winkler on normalized name
        syntactic/token-sort     Token Sort Ratio (better for multi-word names)
        syntactic/ngram-idf      Character bigram IDF-cosine (Usagi's method)
        semantic/biolord         Cosine similarity on BioLORD embeddings

The output is loaded by the Linkr frontend to populate the Suggestions panel.
Source concept uniqueness key: (source_vocabulary_id, source_concept_code).

Dependencies:
    pip install rapidfuzz pandas pyarrow numpy tqdm
    pip install sentence-transformers  # only needed for semantic/biolord
"""

import argparse
import math
import sys
import unicodedata
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from rapidfuzz import fuzz as rfuzz
from rapidfuzz.distance import JaroWinkler
from tqdm import tqdm

TOP_K = 50
DEFAULT_OUTPUT = "scores.parquet"


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
        for name in names:
            grams = self._ngrams(name)
            counts = Counter(grams)
            df_counts.update(counts.keys())
            self._doc_vecs.append(counts)

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
    """Returns (N×D matrix, concept_id series, model_id)."""
    table = pq.read_table(str(path))
    df = table.to_pandas()
    matrix = np.vstack(df["embedding"].tolist()).astype(np.float32)
    return matrix, df["concept_id"], df["model_id"].iloc[0]


# ---------------------------------------------------------------------------
# Semantic scores
# ---------------------------------------------------------------------------

def compute_semantic_scores(source_df: pd.DataFrame, emb_matrix: np.ndarray,
                             emb_concept_ids: pd.Series, model_id: str,
                             k: int) -> list[dict]:
    from sentence_transformers import SentenceTransformer

    print(f"  Loading model {model_id} ...")
    model = SentenceTransformer(model_id)

    texts = source_df["source_concept_name"].tolist()
    print(f"  Encoding {len(texts)} source concepts ...")
    query_vecs = model.encode(texts, batch_size=64, show_progress_bar=True,
                              convert_to_numpy=True, normalize_embeddings=True)

    # emb_matrix is already L2-normalized (embed_concepts.py uses normalize_embeddings=True)
    # so cosine similarity = dot product
    print(f"  Computing cosine similarity ({len(texts)} x {len(emb_concept_ids)}) ...")
    scores_matrix = query_vecs @ emb_matrix.T  # shape: (n_source, n_omop)

    rows = []
    concept_ids_arr = emb_concept_ids.to_numpy()

    for i, src_row in enumerate(source_df.itertuples(index=False)):
        sims = scores_matrix[i]
        top_idx = np.argpartition(sims, -k)[-k:]
        top_idx = top_idx[np.argsort(sims[top_idx])[::-1]]
        for idx in top_idx:
            rows.append({
                "source_vocabulary_id": src_row.source_vocabulary_id,
                "source_concept_code":  src_row.source_concept_code,
                "concept_id":           int(concept_ids_arr[idx]),
                "method":               "semantic/biolord",
                "score":                float(round(float(sims[idx]), 5)),
            })
    return rows


# ---------------------------------------------------------------------------
# Syntactic scores
# ---------------------------------------------------------------------------

def compute_syntactic_scores(source_df: pd.DataFrame, concept_df: pd.DataFrame,
                             k: int, methods: list[str]) -> list[dict]:
    concept_names = concept_df["concept_name"].tolist()
    concept_ids = concept_df["concept_id"].tolist()
    rows = []

    use_jw = "syntactic/jaro-winkler" in methods
    use_ts = "syntactic/token-sort" in methods
    use_ng = "syntactic/ngram-idf" in methods

    ngram_index = None
    if use_ng:
        print("  Building n-gram IDF index ...")
        ngram_index = NgramIdfIndex(concept_names, n=2)

    for src_row in tqdm(source_df.itertuples(index=False), total=len(source_df),
                        desc="Source concepts", unit="concept"):
        query = src_row.source_concept_name
        vocab_id = src_row.source_vocabulary_id
        code = src_row.source_concept_code

        if use_jw:
            jw_scores = [(jaro_winkler_score(query, name), cid)
                         for name, cid in zip(concept_names, concept_ids)]
            jw_scores.sort(reverse=True)
            for score, cid in jw_scores[:k]:
                rows.append({
                    "source_vocabulary_id": vocab_id,
                    "source_concept_code":  code,
                    "concept_id":           cid,
                    "method":               "syntactic/jaro-winkler",
                    "score":                round(score, 5),
                })

        if use_ts:
            ts_scores = [(token_sort_score(query, name), cid)
                         for name, cid in zip(concept_names, concept_ids)]
            ts_scores.sort(reverse=True)
            for score, cid in ts_scores[:k]:
                rows.append({
                    "source_vocabulary_id": vocab_id,
                    "source_concept_code":  code,
                    "concept_id":           cid,
                    "method":               "syntactic/token-sort",
                    "score":                round(score, 5),
                })

        if use_ng and ngram_index is not None:
            for idx, score in ngram_index.top_k(query, k):
                rows.append({
                    "source_vocabulary_id": vocab_id,
                    "source_concept_code":  code,
                    "concept_id":           concept_ids[idx],
                    "method":               "syntactic/ngram-idf",
                    "score":                round(score, 5),
                })

    return rows


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
    parser.add_argument("--output", default=DEFAULT_OUTPUT,
                        help=f"Output file (default: {DEFAULT_OUTPUT})")
    parser.add_argument("--top-k", type=int, default=TOP_K,
                        help=f"Candidates to keep per source concept per method (default: {TOP_K})")
    parser.add_argument("--methods", nargs="+",
                        default=["syntactic/jaro-winkler", "syntactic/token-sort",
                                 "syntactic/ngram-idf", "semantic/biolord"],
                        help="Methods to compute (default: all)")
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
    output_path = Path(args.output)

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
    print(f"  -> {len(source_df)} unique source concepts")

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

    all_rows: list[dict] = []

    if syntactic_methods:
        print(f"\nComputing syntactic scores ({', '.join(syntactic_methods)}) ...")
        syn_rows = compute_syntactic_scores(source_df, concept_df, args.top_k, syntactic_methods)
        print(f"  -> {len(syn_rows):,} syntactic scores")
        all_rows.extend(syn_rows)

    if has_semantic and emb_path is not None:
        print(f"\nComputing semantic scores from {emb_path} ...")
        emb_matrix, emb_ids, model_id = load_embeddings(emb_path)
        sem_rows = compute_semantic_scores(source_df, emb_matrix, emb_ids, model_id, args.top_k)
        print(f"  -> {len(sem_rows):,} semantic scores")
        all_rows.extend(sem_rows)

    if not all_rows:
        print("No scores computed.", file=sys.stderr)
        sys.exit(1)

    print(f"\nWriting to {output_path} ...")
    result_df = pd.DataFrame(all_rows)
    table = pa.Table.from_pandas(result_df, preserve_index=False)
    pq.write_table(table, str(output_path), compression="snappy")

    size_kb = output_path.stat().st_size / 1024
    print(f"  -> {len(result_df):,} rows, "
          f"{result_df['source_concept_code'].nunique()} source concepts, "
          f"{size_kb:.0f} KB")
    print("Done.")


if __name__ == "__main__":
    main()
