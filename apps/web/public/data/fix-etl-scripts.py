#!/usr/bin/env python3
"""
Fix two issues in mimic-iv-etl-scripts.json:
1. Rename old OMOP column names to OMOP 5.4 names (in SELECT aliases and table references)
2. Add DELETE FROM before every INSERT INTO for OMOP target tables
"""

import json
import re
import sys

INPUT_FILE = "mimic-iv-etl-scripts.json"
OUTPUT_FILE = "mimic-iv-etl-scripts.json"

# OMOP target tables that should get DELETE FROM before INSERT
OMOP_TABLES = {
    "location", "care_site", "person", "death",
    "visit_occurrence", "visit_detail",
    "condition_occurrence", "procedure_occurrence",
    "drug_exposure", "measurement", "observation",
    "observation_period", "specimen", "device_exposure",
    "condition_era", "drug_era", "dose_era",
    "fact_relationship", "note", "note_nlp",
}

# Column name replacements (old -> new OMOP 5.4)
COLUMN_RENAMES = {
    "admitting_source_concept_id": "admitted_from_concept_id",
    "admitting_source_value": "admitted_from_source_value",
    "discharge_to_concept_id": "discharged_to_concept_id",
    "discharge_to_source_value": "discharged_to_source_value",
    "visit_detail_parent_id": "parent_visit_detail_id",
}


def fix_column_names(content: str) -> str:
    """Replace old column names with OMOP 5.4 names in SQL content."""
    for old_name, new_name in COLUMN_RENAMES.items():
        # Replace AS aliases (e.g., "AS admitting_source_concept_id")
        content = content.replace(f"AS {old_name}", f"AS {new_name}")
        # Replace table.column references (e.g., "vis.admitting_source_value")
        # Use word-boundary-aware replacement
        content = re.sub(
            r'(\w+)\.' + re.escape(old_name) + r'(?=\b)',
            lambda m: f"{m.group(1)}.{new_name}",
            content,
        )
        # Replace bare column names in INSERT column lists (just in case)
        # These are already correct per our analysis, but do it defensively
        # Only match if preceded by comma/space/( and followed by comma/space/)
        content = re.sub(
            r'(?<=[\s,(])' + re.escape(old_name) + r'(?=[\s,)])',
            new_name,
            content,
        )
    return content


def add_delete_before_inserts(content: str) -> str:
    """Add DELETE FROM <table> before the first INSERT INTO <table> for each OMOP target table.

    Rules:
    - Only for OMOP target tables (not tmp_* tables)
    - Only add DELETE before the FIRST INSERT into each table within a script
      (subsequent INSERTs into the same table are appending, not replacing)
    - Don't add if a DELETE FROM for that table already exists anywhere earlier
      in the script (e.g., 10_observation_period.sql already has DELETE FROM person)
    """
    lines = content.split("\n")
    result = []

    # Track which OMOP tables already have a DELETE FROM in this script
    # (either pre-existing in the original, or added by us)
    tables_with_delete = set()

    # First pass: find all tables that already have DELETE FROM in the original
    for line in lines:
        stripped = line.strip()
        delete_match = re.match(
            r'^DELETE\s+FROM\s+(\S+)\s*;', stripped, re.IGNORECASE
        )
        if delete_match:
            table_name = delete_match.group(1).lower()
            if table_name in OMOP_TABLES:
                tables_with_delete.add(table_name)

    # Second pass: add DELETE before first INSERT for each OMOP table
    for i, line in enumerate(lines):
        stripped = line.strip()

        # Check if this line starts an INSERT INTO statement
        insert_match = re.match(r'^INSERT\s+INTO\s+(\S+)', stripped, re.IGNORECASE)

        if insert_match:
            table_name = insert_match.group(1).lower()
            # Remove parenthesis if table name includes it
            table_name = table_name.split("(")[0].rstrip()

            if (
                table_name in OMOP_TABLES
                and not table_name.startswith("tmp_")
                and table_name not in tables_with_delete
            ):
                result.append(f"DELETE FROM {table_name};")
                tables_with_delete.add(table_name)

        result.append(line)

    return "\n".join(result)


def main():
    with open(INPUT_FILE, "r") as f:
        data = json.load(f)

    print(f"Loaded {len(data)} scripts")

    for i, script in enumerate(data):
        name = script["name"]
        original = script["content"]

        # Fix 1: Column names
        fixed = fix_column_names(original)

        # Fix 2: Add DELETE FROM before INSERT INTO
        fixed = add_delete_before_inserts(fixed)

        if fixed != original:
            print(f"  Modified: {name}")
            # Show diffs
            orig_lines = set(original.split("\n"))
            new_lines = set(fixed.split("\n"))
            added = new_lines - orig_lines
            removed = orig_lines - new_lines
            for r in sorted(removed):
                if r.strip():
                    print(f"    - {r.strip()[:120]}")
            for a in sorted(added):
                if a.strip():
                    print(f"    + {a.strip()[:120]}")

        script["content"] = fixed

    # Write output
    with open(OUTPUT_FILE, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # Validate JSON
    with open(OUTPUT_FILE, "r") as f:
        validated = json.load(f)

    print(f"\nValidation: OK ({len(validated)} scripts)")

    # Final check: no old column names remain
    remaining_old = []
    for script in validated:
        for old_name in COLUMN_RENAMES:
            if old_name in script["content"]:
                remaining_old.append(f"  {script['name']}: still contains '{old_name}'")

    if remaining_old:
        print("\nWARNING: Old column names still found:")
        for r in remaining_old:
            print(r)
        sys.exit(1)
    else:
        print("All old column names successfully replaced.")

    # Check DELETE FROM counts
    delete_count = 0
    insert_count = 0
    for script in validated:
        content = script["content"]
        for m in re.finditer(r'DELETE FROM\s+(\S+)', content):
            table = m.group(1).rstrip(";").lower()
            if table in OMOP_TABLES:
                delete_count += 1
        for m in re.finditer(r'INSERT INTO\s+(\S+)', content):
            table = m.group(1).split("(")[0].rstrip().lower()
            if table in OMOP_TABLES:
                insert_count += 1

    print(f"OMOP table INSERT count: {insert_count}")
    print(f"OMOP table DELETE count: {delete_count}")


if __name__ == "__main__":
    main()
