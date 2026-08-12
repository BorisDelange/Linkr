#!/usr/bin/env python3
"""
update_project_stats.py — Recomputes <project_dir>/project.json `stats` from mappings.json.

Linkr shows a mapping project's counters (list page, Progress tab) straight from
`project.json.stats`. In the app those counters are refreshed by
`recomputeProjectStats` on every write; a skill session that appends to
`mappings.json` out-of-band must refresh them too, or the re-imported project
displays stale numbers.

Mirrors `mapping_project_service.compute_project_stats` (server) and
`IDBConceptMappingStorage.getStats` (client): dedup by (sourceVocabularyId,
sourceConceptCode) using the effective, review-derived status.

Usage:
    python update_project_stats.py --project-dir /path/to/project [--quiet]

Options:
    --project-dir   Required. Folder containing project.json and mappings.json.
    --dry-run       Print what would change, write nothing.

Reads:  project.json, mappings.json, source-concepts.csv (for the total)
Writes: project.json (only the `stats` object)
"""

import argparse
import csv
import json
import sys
from pathlib import Path

# Statuses that count as a decision; 'unchecked' / 'suggested' are pending states.
DECISIVE = ("approved", "rejected", "flagged", "ignored", "invalid")


def effective_status(mapping: dict) -> str:
    """Stored status, unless reviewers voted: one decisive status wins, several → 'disputed'."""
    reviews = mapping.get("reviews") or []
    stored = mapping.get("status") or "unchecked"
    if not reviews:
        return stored
    present = [s for s in DECISIVE if any(r.get("status") == s for r in reviews)]
    if not present:
        return stored
    if len(present) > 1:
        return "disputed"
    return present[0]


def source_key(mapping: dict) -> str:
    vocab = mapping.get("sourceVocabularyId") or ""
    code = mapping.get("sourceConceptCode") or ""
    return f"{vocab}\0{code}"


def count_source_concepts(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            return sum(1 for _ in csv.DictReader(f))
    except Exception as e:
        print(f"  warning: cannot read source CSV: {e}", file=sys.stderr)
        return 0


def compute_stats(mappings: list, total_source_concepts: int) -> dict:
    ignored: set[str] = set()
    mapped: set[str] = set()
    approved: set[str] = set()
    flagged: set[str] = set()
    for m in mappings:
        if not isinstance(m, dict):
            continue
        eff = effective_status(m)
        key = source_key(m)
        if eff == "ignored":
            ignored.add(key)
            continue
        mapped.add(key)
        if eff == "approved":
            approved.add(key)
        elif eff == "flagged":
            flagged.add(key)
    return {
        "totalSourceConcepts": total_source_concepts,
        "mappedCount": len(mapped),
        "approvedCount": len(approved),
        "flaggedCount": len(flagged),
        "ignoredCount": len(ignored),
        "unmappedCount": max(0, total_source_concepts - len(mapped)),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Recompute project.json stats from mappings.json"
    )
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    project_dir = Path(args.project_dir).expanduser().resolve()
    project_path = project_dir / "project.json"
    mappings_path = project_dir / "mappings.json"

    if not project_path.exists():
        print(f"Error: project.json not found in {project_dir}", file=sys.stderr)
        sys.exit(1)

    with open(project_path, "r", encoding="utf-8") as f:
        project = json.load(f)

    mappings = []
    if mappings_path.exists():
        with open(mappings_path, "r", encoding="utf-8") as f:
            mappings = json.load(f)
        if not isinstance(mappings, list):
            print("Error: mappings.json is not a JSON array", file=sys.stderr)
            sys.exit(1)

    previous = project.get("stats") or {}
    # The app derives the total from the source query, not from mappings. Trust its
    # recorded values first; the CSV row count is only a last resort (the file may
    # be absent, or filtered down to the batch being worked on).
    total = (
        previous.get("totalSourceConcepts")
        or (project.get("fileSourceData") or {}).get("totalRowCount")
        or count_source_concepts(project_dir / "source-concepts.csv")
    )

    stats = compute_stats(mappings, total)

    if args.dry_run:
        print(f"[dry-run] {project_path}")
        print(f"  before: {json.dumps(previous, ensure_ascii=False)}")
        print(f"  after:  {json.dumps(stats, ensure_ascii=False)}")
        return

    project["stats"] = stats
    with open(project_path, "w", encoding="utf-8") as f:
        json.dump(project, f, indent=2, ensure_ascii=False)
        f.write("\n")

    if not args.quiet:
        print(f"[stats] {project_path}")
        print(f"  source concepts: {stats['totalSourceConcepts']:,}")
        print(f"  mapped:          {stats['mappedCount']:,}")
        print(f"  approved:        {stats['approvedCount']:,}")
        print(f"  flagged:         {stats['flaggedCount']:,}")
        print(f"  ignored:         {stats['ignoredCount']:,}")
        print(f"  unmapped:        {stats['unmappedCount']:,}")


if __name__ == "__main__":
    main()
