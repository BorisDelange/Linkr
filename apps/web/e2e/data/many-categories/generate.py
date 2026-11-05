"""Writes the OMOP Parquet folder of e2e/client/concept-filter.spec.ts: 6,000
concepts whose domain_id are all distinct (1,200 "Mycologie <n>"), more than a
column dropdown loads, plus the one-row person table a Parquet folder needs to
read as a folder rather than a single file.

Run from apps/api, whose venv has DuckDB:
    .venv/bin/python ../web/e2e/data/many-categories/generate.py
"""

from pathlib import Path

import duckdb

here = Path(__file__).parent
duckdb.execute(f"""
    COPY (
        SELECT range + 1 AS concept_id, 'Concept ' || (range + 1) AS concept_name,
            (['Bactériologie', 'Biochimie', 'Hématologie', 'Mycologie', 'Virologie'])[range % 5 + 1]
                || ' ' || (range // 5) AS domain_id,
            'LOCAL' AS vocabulary_id, 'Lab Test' AS concept_class_id,
            NULL::VARCHAR AS standard_concept, 'C' || (range + 1) AS concept_code,
            DATE '2020-01-01' AS valid_start_date, DATE '2099-12-31' AS valid_end_date,
            NULL::VARCHAR AS invalid_reason
        FROM range(6000)
    ) TO '{here / "concept.parquet"}' (FORMAT PARQUET)
""")
duckdb.execute(f"""
    COPY (SELECT 1::BIGINT AS person_id, 8507 AS gender_concept_id, 1970 AS year_of_birth)
    TO '{here / "person.parquet"}' (FORMAT PARQUET)
""")
