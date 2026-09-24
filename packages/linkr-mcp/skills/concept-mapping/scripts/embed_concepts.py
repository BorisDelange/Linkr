#!/usr/bin/env python3
"""
embed_concepts.py — Script 1/2: generates BioLORD embeddings for OMOP concepts.

Usage:
    python embed_concepts.py --concept /path/to/CONCEPT.parquet [options]

Output:
    concept_embeddings.parquet  (concept_id, encoded_text, model_id, embedding)

Supports incremental writing and resume: if the output file already exists,
already-encoded concept_ids are skipped and new rows are appended. Safe to
interrupt and restart at any time.

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

MODEL_ID = "FremyCompany/BioLORD-2023-M"
BATCH_SIZE = 512
DEFAULT_OUTPUT = None  # derived from --concept path: same folder, concept_embeddings.parquet
PROGRESS_EVERY = 10   # print a progress line every N batches
FLUSH_EVERY = 50      # append to parquet every N batches (~25k concepts)


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


def load_already_encoded(output_path: Path) -> set[int]:
    if not output_path.exists():
        return set()
    try:
        existing = pq.read_table(str(output_path), columns=["concept_id"])
        ids = set(existing["concept_id"].to_pylist())
        print(f"  -> resuming: {len(ids):,} concepts already encoded, skipping them")
        return ids
    except Exception as e:
        print(f"  -> warning: could not read existing output ({e}), starting fresh")
        return set()


PARQUET_SCHEMA = pa.schema([
    pa.field("concept_id",   pa.int64()),
    pa.field("encoded_text", pa.string()),
    pa.field("model_id",     pa.string()),
    pa.field("embedding",    pa.list_(pa.float32())),
])


def flush_to_parquet(output_path: Path, buf_ids: list, buf_texts: list,
                     buf_model: list, buf_vecs: list) -> None:
    table = pa.table({
        "concept_id":   pa.array(buf_ids,   type=pa.int64()),
        "encoded_text": pa.array(buf_texts, type=pa.string()),
        "model_id":     pa.array(buf_model, type=pa.string()),
        "embedding":    pa.array([v.tolist() for v in buf_vecs],
                                 type=pa.list_(pa.float32())),
    }, schema=PARQUET_SCHEMA)

    if output_path.exists():
        existing = pq.read_table(str(output_path))
        combined = pa.concat_tables([existing, table])
        pq.write_table(combined, str(output_path), compression="snappy")
    else:
        pq.write_table(table, str(output_path), compression="snappy")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate BioLORD embeddings for CONCEPT.parquet")
    parser.add_argument("--concept", required=True,
                        help="Path to CONCEPT.parquet or CONCEPT.csv")
    parser.add_argument("--output", default=None,
                        help="Output file (default: concept_embeddings.parquet next to --concept)")
    parser.add_argument("--model", default=MODEL_ID,
                        help=f"sentence-transformers model (default: {MODEL_ID})")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE,
                        help=f"Encoding batch size (default: {BATCH_SIZE})")
    parser.add_argument("--flush-every", type=int, default=FLUSH_EVERY,
                        help=f"Append to parquet every N batches (default: {FLUSH_EVERY})")
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

    output_path = Path(args.output) if args.output else concept_path.parent / "concept_embeddings.parquet"
    print(f"Output: {output_path}")

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

    already_done = load_already_encoded(output_path)
    if already_done:
        df = df[~df["concept_id"].isin(already_done)]
        print(f"  -> {len(df):,} concepts remaining to encode")

    if df.empty:
        print("No concepts remaining to encode.")
        sys.exit(0)

    print(f"\n{len(df):,} concepts to encode with {args.model}")
    print("Loading model ...")
    model = SentenceTransformer(args.model)
    dim = model.get_sentence_embedding_dimension()
    print(f"  -> embedding dimension: {dim}")

    df["encoded_text"] = df.apply(build_encoded_text, axis=1)

    concept_ids = df["concept_id"].tolist()
    texts = df["encoded_text"].tolist()
    total = len(texts)
    n_batches = (total + args.batch_size - 1) // args.batch_size

    buf_ids: list = []
    buf_texts: list = []
    buf_model: list = []
    buf_vecs: list = []

    t_start = time.time()

    for batch_idx, i in enumerate(range(0, total, args.batch_size)):
        batch_texts = texts[i : i + args.batch_size]
        batch_ids   = concept_ids[i : i + args.batch_size]
        batch_encoded = df["encoded_text"].tolist()[i : i + args.batch_size]

        vecs = model.encode(batch_texts, batch_size=args.batch_size, show_progress_bar=False,
                            convert_to_numpy=True, normalize_embeddings=True)

        buf_ids.extend(batch_ids)
        buf_texts.extend(batch_encoded)
        buf_model.extend([args.model] * len(batch_ids))
        buf_vecs.extend(vecs)

        done = min(i + args.batch_size, total)
        now = time.time()

        if (batch_idx + 1) % PROGRESS_EVERY == 0 or done == total:
            elapsed = now - t_start
            pct = done / total * 100
            speed = done / elapsed if elapsed > 0 else 0
            eta = (total - done) / speed if speed > 0 else 0
            eta_min, eta_sec = divmod(int(eta), 60)
            print(
                f"[embed] batch {batch_idx + 1}/{n_batches} — "
                f"{done:,}/{total:,} concepts ({pct:.1f}%) — "
                f"{speed:.0f} concepts/s — "
                f"ETA {eta_min}m{eta_sec:02d}s",
                flush=True,
            )

        if (batch_idx + 1) % args.flush_every == 0 or done == total:
            flush_to_parquet(output_path, buf_ids, buf_texts, buf_model, buf_vecs)
            total_written = len(already_done) + done
            print(f"[flush] {total_written:,} embeddings saved to {output_path}", flush=True)
            buf_ids, buf_texts, buf_model, buf_vecs = [], [], [], []

    elapsed = time.time() - t_start
    print(f"\nEncoding done in {elapsed:.0f}s ({total / elapsed:.0f} concepts/s)")
    size_mb = output_path.stat().st_size / 1_048_576
    print(f"  -> {len(already_done) + total:,} total embeddings in file ({size_mb:.0f} MB)")
    print("Done.")


if __name__ == "__main__":
    main()
