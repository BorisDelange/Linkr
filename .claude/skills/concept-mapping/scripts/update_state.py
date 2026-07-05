#!/usr/bin/env python3
"""
update_state.py — Recomputes <project_dir>/state.json from the project files.

The state file is the shared source of truth between the concept-mapping skill
and the review/ web app. It is idempotent: running this script always produces
the same output for the same inputs (it does not accumulate history beyond what
already exists in state.json).

Usage:
    python update_state.py --project-dir /path/to/project [options]

Options:
    --project-dir   Required. Folder containing source-concepts.csv, mappings.json, ...
    --vocab-dir     Optional. Used to detect concept_embeddings.parquet co-location.
    --session       Optional JSON string. Appends an entry to state.sessions.
                    Example: '{"subSkill":"concept-mapping-ai","concepts":["REA/x"],"outcomes":{"accepted":1}}'
    --methods-event Optional. One of: "embed_done", "scores_done". Updates state.methods accordingly.

Reads (when present):
    project.json, source-concepts.csv, mappings.json,
    similarity-scores.parquet, source_embeddings.parquet,
    <vocab_dir>/concept_embeddings.parquet

Writes:
    <project_dir>/state.json
"""

import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import pyarrow.parquet as pq  # type: ignore
    HAS_PYARROW = True
except ImportError:
    HAS_PYARROW = False


SCHEMA_VERSION = 1


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_read_json(path: Path):
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"  warning: cannot read {path.name}: {e}", file=sys.stderr)
        return None


def count_source_concepts(path: Path) -> tuple[int, list[str]]:
    """Returns (count, sample of vocabulary_ids). Reads only what's needed."""
    if not path.exists():
        return 0, []
    vocab_set: set[str] = set()
    count = 0
    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            vocab_col = next((c for c in reader.fieldnames or []
                              if c.lower() in ("terminology", "terminology_code", "vocab",
                                               "vocabulary", "source_vocab", "vocabulary_id")), None)
            for row in reader:
                count += 1
                if vocab_col:
                    v = (row.get(vocab_col) or "").strip()
                    if v:
                        vocab_set.add(v)
    except Exception as e:
        print(f"  warning: cannot read source CSV: {e}", file=sys.stderr)
    return count, sorted(vocab_set)


def count_mappings_by_status(path: Path) -> tuple[int, dict[str, int]]:
    """Returns (total, {status: count})."""
    data = safe_read_json(path)
    if not isinstance(data, list):
        return 0, {}
    counts: dict[str, int] = {}
    for m in data:
        s = (m.get("status") or "unchecked") if isinstance(m, dict) else "unchecked"
        counts[s] = counts.get(s, 0) + 1
    return len(data), counts


def inspect_parquet(path: Path) -> dict | None:
    """Returns {rows, columns, sample_methods?} or None if unavailable."""
    if not path.exists():
        return None
    if not HAS_PYARROW:
        return {"rows": None, "columns": None, "note": "pyarrow not installed"}
    try:
        pf = pq.ParquetFile(str(path))
        info = {
            "rows": pf.metadata.num_rows,
            "columns": [f.name for f in pf.schema_arrow],
            "sizeBytes": path.stat().st_size,
        }
        if "method" in info["columns"]:
            tbl = pq.read_table(str(path), columns=["method"])
            methods = sorted(set(tbl.column("method").to_pylist()))
            info["methods"] = methods
        return info
    except Exception as e:
        print(f"  warning: cannot inspect {path.name}: {e}", file=sys.stderr)
        return None


def count_unique_source_pairs_in_scores(path: Path) -> int:
    if not path.exists() or not HAS_PYARROW:
        return 0
    try:
        tbl = pq.read_table(str(path), columns=["source_vocabulary_id", "source_concept_code"])
        df = tbl.to_pandas().drop_duplicates()
        return len(df)
    except Exception:
        return 0


def count_unique_source_pairs_per_method(path: Path) -> dict[str, int]:
    """Returns {method: n_distinct_source_pairs_with_at_least_one_score}."""
    if not path.exists() or not HAS_PYARROW:
        return {}
    try:
        tbl = pq.read_table(
            str(path),
            columns=["source_vocabulary_id", "source_concept_code", "method"],
        )
        df = tbl.to_pandas().drop_duplicates(
            subset=["source_vocabulary_id", "source_concept_code", "method"]
        )
        return df.groupby("method").size().astype(int).to_dict()
    except Exception:
        return {}


def summarize_ai_suggestions(path: Path) -> dict:
    """AI suggestions = rows whose method starts with 'ai/'.

    Returns per-source-concept and per-equivalence breakdowns, plus how many are
    aligned onto a data dictionary (concept_set_uid non-null). Distinct from
    authored mappings (mappings.json): a source concept can have several AI
    suggestions and zero authored mappings.
    """
    empty = {
        "concepts": 0,
        "rows": 0,
        "byEquivalence": {},
        "models": [],
        "dictionaryConcepts": 0,
        "dictionarySets": 0,
        "dictionaryRepos": [],
    }
    if not path.exists() or not HAS_PYARROW:
        return empty
    try:
        pf = pq.ParquetFile(str(path))
        cols = [f.name for f in pf.schema_arrow]
        want = [c for c in (
            "source_vocabulary_id", "source_concept_code", "method",
            "equivalence", "concept_set_uid", "concept_set_source_repo",
        ) if c in cols]
        df = pq.read_table(str(path), columns=want).to_pandas()
        ai = df[df["method"].astype(str).str.startswith("ai/")]
        if ai.empty:
            return empty
        pair = ["source_vocabulary_id", "source_concept_code"]
        by_equiv = {}
        if "equivalence" in ai.columns:
            by_equiv = (
                ai.dropna(subset=["equivalence"])
                .groupby("equivalence").size().astype(int).to_dict()
            )
        dict_concepts, dict_sets, dict_repos = 0, 0, []
        if "concept_set_uid" in ai.columns:
            dict_rows = ai[ai["concept_set_uid"].notna()]
            dict_concepts = len(dict_rows.drop_duplicates(subset=pair))
            dict_sets = dict_rows["concept_set_uid"].nunique()
            if "concept_set_source_repo" in dict_rows.columns:
                dict_repos = sorted(
                    r for r in dict_rows["concept_set_source_repo"].dropna().unique()
                )
        return {
            "concepts": len(ai.drop_duplicates(subset=pair)),
            "rows": len(ai),
            "byEquivalence": by_equiv,
            "models": sorted(ai["method"].unique().tolist()),
            "dictionaryConcepts": int(dict_concepts),
            "dictionarySets": int(dict_sets),
            "dictionaryRepos": dict_repos,
        }
    except Exception as e:
        print(f"  warning: cannot summarize AI suggestions: {e}", file=sys.stderr)
        return empty


def count_source_embeddings(path: Path) -> int:
    if not path.exists() or not HAS_PYARROW:
        return 0
    try:
        return pq.ParquetFile(str(path)).metadata.num_rows
    except Exception:
        return 0


def count_omop_embeddings(path: Path) -> int:
    if not path.exists() or not HAS_PYARROW:
        return 0
    try:
        return pq.ParquetFile(str(path)).metadata.num_rows
    except Exception:
        return 0


def inspect_omop_embeddings(path: Path) -> dict | None:
    """Returns {rows, model_ids, sizeBytes} or None if unavailable."""
    if not path.exists():
        return None
    if not HAS_PYARROW:
        return {"rows": None, "model_ids": None, "note": "pyarrow not installed"}
    try:
        pf = pq.ParquetFile(str(path))
        info: dict = {
            "rows": pf.metadata.num_rows,
            "sizeBytes": path.stat().st_size,
        }
        cols = [f.name for f in pf.schema_arrow]
        if "model_id" in cols:
            tbl = pq.read_table(str(path), columns=["model_id"])
            info["model_ids"] = sorted(set(tbl.column("model_id").to_pylist()))
        return info
    except Exception as e:
        print(f"  warning: cannot inspect {path.name}: {e}", file=sys.stderr)
        return None


def count_omop_concepts_total(path: Path) -> int:
    """Row count of CONCEPT.parquet — the denominator for OMOP embedding coverage."""
    if not path.exists() or not HAS_PYARROW:
        return 0
    try:
        return pq.ParquetFile(str(path)).metadata.num_rows
    except Exception:
        return 0


def build_state(
    project_dir: Path,
    vocab_dir: Path | None,
    previous: dict | None,
    session_json: str | None,
    methods_event: str | None,
) -> dict:
    project_json = safe_read_json(project_dir / "project.json") or {}
    # name may be an i18n object {"en": "…", "fr": "…"} — resolve to a string
    raw_name = project_json.get("name")
    if isinstance(raw_name, dict):
        project_name = raw_name.get("en") or next(iter(raw_name.values()), None) or project_dir.name
    else:
        project_name = raw_name or project_dir.name

    source_csv = project_dir / "source-concepts.csv"
    n_source, vocab_ids = count_source_concepts(source_csv)

    mappings_path = project_dir / "mappings.json"
    n_mapped, status_counts = count_mappings_by_status(mappings_path)

    scores_path = project_dir / "similarity-scores.parquet"
    scores_info = inspect_parquet(scores_path)
    n_with_scores = count_unique_source_pairs_in_scores(scores_path)
    scored_methods = (scores_info or {}).get("methods", []) if scores_info else []
    per_method_coverage = count_unique_source_pairs_per_method(scores_path)
    ai_suggestions = summarize_ai_suggestions(scores_path)

    src_emb_path = project_dir / "source_embeddings.parquet"
    n_src_embeddings = count_source_embeddings(src_emb_path)

    omop_emb_path = (vocab_dir / "concept_embeddings.parquet") if vocab_dir else None
    n_omop_embeddings = count_omop_embeddings(omop_emb_path) if omop_emb_path else 0
    omop_emb_info = inspect_omop_embeddings(omop_emb_path) if omop_emb_path else None

    omop_concept_path = (vocab_dir / "CONCEPT.parquet") if vocab_dir else None
    n_omop_concepts_total = count_omop_concepts_total(omop_concept_path) if omop_concept_path else 0

    known_methods = [
        "syntactic/jaro-winkler",
        "syntactic/token-sort",
        "syntactic/ngram-idf",
        "semantic/biolord",
    ]
    # AI suggestions (method 'ai/*') are surfaced in their own section, not the
    # syntactic/semantic methods table — keep them out of the extras here.
    extra_methods = [
        m for m in scored_methods
        if m not in known_methods and not str(m).startswith("ai/")
    ]
    methods = {
        name: {
            "computed": name in scored_methods,
            "coverage": per_method_coverage.get(name, 0),
        }
        for name in known_methods + extra_methods
    }

    sessions = (previous or {}).get("sessions", []) if isinstance(previous, dict) else []
    if session_json:
        try:
            entry = json.loads(session_json)
            entry.setdefault("recordedAt", iso_now())
            sessions = sessions + [entry]
        except Exception as e:
            print(f"  warning: --session not valid JSON ({e})", file=sys.stderr)

    events = (previous or {}).get("events", []) if isinstance(previous, dict) else []
    if methods_event:
        events = events + [{"type": methods_event, "at": iso_now()}]

    state = {
        "schemaVersion": SCHEMA_VERSION,
        "projectName": project_name,
        "projectId": project_json.get("id"),
        "projectDir": str(project_dir),
        "vocabDir": str(vocab_dir) if vocab_dir else None,
        "lastUpdatedAt": iso_now(),
        "files": {
            "projectJson":         (project_dir / "project.json").exists(),
            "sourceConceptsCsv":   source_csv.exists(),
            "mappingsJson":        mappings_path.exists(),
            "similarityScores":    scores_path.exists(),
            "sourceEmbeddings":    src_emb_path.exists(),
            "omopEmbeddings":      bool(omop_emb_path and omop_emb_path.exists()),
        },
        "counts": {
            "sourceConceptsTotal":   n_source,
            "sourceVocabularies":    vocab_ids,
            "withSourceEmbeddings":  n_src_embeddings,
            "withScores":            n_with_scores,
            "omopEmbeddings":        n_omop_embeddings,
            "omopConceptsTotal":     n_omop_concepts_total,
            "mapped": {
                "total":      n_mapped,
                "byStatus":   status_counts,
            },
            "remaining": max(n_source - n_mapped, 0),
        },
        "methods":  methods,
        "aiSuggestions": ai_suggestions,
        "scoresInfo": scores_info,
        "omopEmbeddingsInfo": omop_emb_info,
        "sessions": sessions[-50:],
        "events":   events[-50:],
    }
    return state


def main() -> None:
    parser = argparse.ArgumentParser(description="Recompute state.json for a concept-mapping project")
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--vocab-dir",   default=None)
    parser.add_argument("--session",     default=None,
                        help="JSON string appended to state.sessions")
    parser.add_argument("--methods-event", default=None,
                        choices=["embed_done", "scores_done"],
                        help="Appended to state.events")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    project_dir = Path(args.project_dir).expanduser().resolve()
    if not project_dir.is_dir():
        print(f"Error: project dir not found: {project_dir}", file=sys.stderr)
        sys.exit(1)
    vocab_dir = Path(args.vocab_dir).expanduser().resolve() if args.vocab_dir else None

    state_path = project_dir / "state.json"
    previous = safe_read_json(state_path)
    state = build_state(project_dir, vocab_dir, previous, args.session, args.methods_event)

    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)

    if not args.quiet:
        c = state["counts"]
        m = c["mapped"]
        print(f"[state] {state_path}")
        print(f"  source concepts:    {c['sourceConceptsTotal']:,}")
        print(f"  with scores:        {c['withScores']:,}")
        print(f"  source embeddings:  {c['withSourceEmbeddings']:,}")
        print(f"  authored mappings:  {m['total']:,}  by status: {m['byStatus']}")
        ai = state["aiSuggestions"]
        ai_extra = f" ({ai['dictionaryConcepts']:,} dictionary-aligned)" if ai["dictionaryConcepts"] else ""
        print(f"  AI suggestions:     {ai['concepts']:,} concepts, {ai['rows']:,} rows{ai_extra}")
        methods_on = [k for k, v in state["methods"].items() if v["computed"]]
        print(f"  methods computed:   {', '.join(methods_on) or 'none'}")


if __name__ == "__main__":
    main()
