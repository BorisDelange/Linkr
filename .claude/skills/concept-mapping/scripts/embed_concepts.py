#!/usr/bin/env python3
"""
embed_concepts.py — Script 1/2: generates BioLORD embeddings for OMOP concepts.

Usage:
    python embed_concepts.py --concept /path/to/CONCEPT.parquet [options]

Output:
    concept_embeddings.parquet  (concept_id, embedding, model_id, encoded_text)

This script is slow (30-120 min depending on concept count and hardware).
Run it once per OMOP vocabulary release. The output is reused by
compute_scores.py for all mapping projects.

Dependencies:
    pip install sentence-transformers pandas pyarrow tqdm
"""

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from sentence_transformers import SentenceTransformer
from tqdm import tqdm

MODEL_ID = "FremyCompany/BioLORD-2023-M"
BATCH_SIZE = 512
DEFAULT_OUTPUT = "concept_embeddings.parquet"


def load_concept_table(path: Path) -> pd.DataFrame:
    p = str(path)
    if p.endswith(".parquet"):
        df = pd.read_parquet(p, columns=["concept_id", "concept_name", "vocabulary_id",
                                         "concept_class_id", "standard_concept", "invalid_reason"])
    elif p.endswith(".csv"):
        df = pd.read_csv(p, usecols=["concept_id", "concept_name", "vocabulary_id",
                                     "concept_class_id", "standard_concept", "invalid_reason"],
                         low_memory=False)
    else:
        raise ValueError(f"Unsupported format: {path}. Expected .parquet or .csv")

    df["concept_id"] = df["concept_id"].astype(int)
    df["concept_name"] = df["concept_name"].fillna("").astype(str)
    df["vocabulary_id"] = df["vocabulary_id"].fillna("").astype(str)
    df["concept_class_id"] = df["concept_class_id"].fillna("").astype(str)
    df["standard_concept"] = df["standard_concept"].fillna("").astype(str)
    df["invalid_reason"] = df["invalid_reason"].fillna("").astype(str)
    return df


def build_encoded_text(row: pd.Series) -> str:
    # "Heart rate [LOINC / Clinical Observation]"
    parts = [row["concept_name"]]
    if row["vocabulary_id"]:
        label = row["vocabulary_id"]
        if row["concept_class_id"]:
            label += f" / {row['concept_class_id']}"
        parts.append(f"[{label}]")
    return " ".join(parts)


def encode_in_batches(model: SentenceTransformer, texts: list[str],
                      batch_size: int) -> np.ndarray:
    all_vecs = []
    for i in tqdm(range(0, len(texts), batch_size), desc="Encoding", unit="batch"):
        batch = texts[i : i + batch_size]
        vecs = model.encode(batch, batch_size=batch_size, show_progress_bar=False,
                            convert_to_numpy=True, normalize_embeddings=True)
        all_vecs.append(vecs)
    return np.vstack(all_vecs)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate BioLORD embeddings for CONCEPT.parquet")
    parser.add_argument("--concept", required=True,
                        help="Path to CONCEPT.parquet or CONCEPT.csv")
    parser.add_argument("--output", default=DEFAULT_OUTPUT,
                        help=f"Output file (default: {DEFAULT_OUTPUT})")
    parser.add_argument("--model", default=MODEL_ID,
                        help=f"sentence-transformers model (default: {MODEL_ID})")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE,
                        help=f"Encoding batch size (default: {BATCH_SIZE})")
    parser.add_argument("--only-standard", action="store_true",
                        help="Only process standard concepts (standard_concept = 'S')")
    parser.add_argument("--only-valid", action="store_true",
                        help="Exclude invalid concepts (non-empty invalid_reason)")
    parser.add_argument("--domain", nargs="+",
                        help="Filter by domain_id (e.g. --domain Measurement Condition)")
    parser.add_argument("--vocabulary", nargs="+",
                        help="Filter by vocabulary_id (e.g. --vocabulary LOINC SNOMED)")
    args = parser.parse_args()

    concept_path = Path(args.concept)
    if not concept_path.exists():
        print(f"Error: file not found: {concept_path}", file=sys.stderr)
        sys.exit(1)

    output_path = Path(args.output)

    print(f"Loading {concept_path} ...")
    df = load_concept_table(concept_path)
    total_loaded = len(df)

    if args.only_standard:
        df = df[df["standard_concept"] == "S"]
        print(f"  -> standard filter: {len(df):,} concepts (/{total_loaded:,})")

    if args.only_valid:
        df = df[df["invalid_reason"] == ""]
        print(f"  -> valid filter:    {len(df):,} concepts")

    if args.domain or args.vocabulary:
        if args.domain and "domain_id" not in df.columns:
            p = str(concept_path)
            domain_col = pd.read_parquet(p, columns=["concept_id", "domain_id"]) \
                if p.endswith(".parquet") else \
                pd.read_csv(p, usecols=["concept_id", "domain_id"], low_memory=False)
            df = df.merge(domain_col, on="concept_id", how="left")

        if args.domain:
            df = df[df["domain_id"].isin(args.domain)]
            print(f"  -> domain filter:  {len(df):,} concepts")

        if args.vocabulary:
            df = df[df["vocabulary_id"].isin(args.vocabulary)]
            print(f"  -> vocab filter:   {len(df):,} concepts")

    if df.empty:
        print("No concepts remaining after filtering. Check your filters.", file=sys.stderr)
        sys.exit(1)

    print(f"\n{len(df):,} concepts to encode with {args.model}")
    print("Loading model ...")
    model = SentenceTransformer(args.model)
    dim = model.get_sentence_embedding_dimension()
    print(f"  -> embedding dimension: {dim}")

    df["encoded_text"] = df.apply(build_encoded_text, axis=1)
    texts = df["encoded_text"].tolist()

    t0 = time.time()
    embeddings = encode_in_batches(model, texts, args.batch_size)
    elapsed = time.time() - t0
    print(f"\nEncoding done in {elapsed:.0f}s ({len(texts) / elapsed:.0f} concepts/s)")

    print(f"Writing to {output_path} ...")
    table = pa.table({
        "concept_id":   pa.array(df["concept_id"].tolist(), type=pa.int64()),
        "encoded_text": pa.array(df["encoded_text"].tolist(), type=pa.string()),
        "model_id":     pa.array([args.model] * len(df), type=pa.string()),
        "embedding":    pa.array([e.tolist() for e in embeddings],
                                 type=pa.list_(pa.float32())),
    })
    pq.write_table(table, str(output_path), compression="snappy")

    size_mb = output_path.stat().st_size / 1_048_576
    print(f"  -> {len(df):,} embeddings written ({size_mb:.0f} MB)")
    print("Done.")


if __name__ == "__main__":
    main()
