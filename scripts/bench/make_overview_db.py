"""A synthetic OMOP CDM 5.4 database for trying the patient views by hand: few
patients, one of them very heavy (~50 M measurement rows, ICU monitoring at
1 Hz over 49 days), with hospitalisations, ward and ICU stays, labs, drugs,
conditions, procedures and notes. One Parquet folder per table, every column of
the OMOP 5.4 DDL present. Concepts are local (ids above 2 000 000 000, vocabulary
"Linkr synthetic") except the few standard ones the mapping reads (gender,
visit, type). See README.md.

    cd apps/api && .venv/bin/python ../../scripts/bench/make_overview_db.py --out ~/linkr-test-data/omop-heavy-patient
"""

import argparse
import re
import shutil
import time
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
DDL = ROOT / "apps/web/public/data/seed/default/schemas/omop-cdm-5-4/schema.ddl"

WARD, ICU = 1, 2
LOCAL = 2_000_000_000

# (patient, visit start, visit end, [(care site, stay start, stay end), ...])
HEAVY = [
    ("2019-03-10 09:00", "2019-03-25 14:00", [(WARD, "2019-03-10 09:00", "2019-03-25 14:00")]),
    ("2021-06-01 08:00", "2021-08-15 11:00", [
        (WARD, "2021-06-01 08:00", "2021-06-03 02:00"),
        (ICU, "2021-06-03 02:00", "2021-06-28 10:00"),
        (WARD, "2021-06-28 10:00", "2021-07-10 22:00"),
        (ICU, "2021-07-10 22:00", "2021-07-25 16:00"),
        (WARD, "2021-07-25 16:00", "2021-08-15 11:00"),
    ]),
    ("2023-11-02 19:00", "2023-11-20 10:00", [
        (ICU, "2023-11-03 01:00", "2023-11-12 09:00"),
        (WARD, "2023-11-12 09:00", "2023-11-20 10:00"),
    ]),
]

# (code, name, unit, baseline, daily amplitude)
VITALS = [
    ("HR", "Heart rate", "bpm", 82, 12), ("SBP", "Systolic blood pressure", "mmHg", 118, 15),
    ("DBP", "Diastolic blood pressure", "mmHg", 64, 8), ("MAP", "Mean arterial pressure", "mmHg", 82, 10),
    ("SPO2", "Oxygen saturation", "%", 96, 2), ("RR", "Respiratory rate", "/min", 19, 4),
    ("TEMP", "Body temperature", "°C", 37.3, 0.6), ("CVP", "Central venous pressure", "mmHg", 9, 3),
    ("ETCO2", "End-tidal CO2", "mmHg", 37, 4), ("FIO2", "Inspired oxygen fraction", "%", 45, 10),
    ("PEEP", "PEEP", "cmH2O", 8, 2), ("VT", "Tidal volume", "mL", 440, 40),
]
LABS = [
    ("NA", "Sodium", "mmol/L", 139, 3), ("K", "Potassium", "mmol/L", 4.1, 0.4), ("CREAT", "Creatinine", "µmol/L", 110, 40),
    ("GLU", "Glucose", "mmol/L", 7.5, 2), ("HB", "Hemoglobin", "g/dL", 10.5, 1.5), ("WBC", "Leukocytes", "G/L", 12, 4),
    ("PLT", "Platelets", "G/L", 190, 60), ("LACT", "Lactate", "mmol/L", 2.1, 1), ("PH", "Arterial pH", "", 7.37, 0.05),
    ("PAO2", "PaO2", "mmHg", 85, 20), ("PACO2", "PaCO2", "mmHg", 42, 6), ("BILI", "Total bilirubin", "µmol/L", 18, 8),
    ("CRP", "C-reactive protein", "mg/L", 90, 60),
]
ICU_DRUGS = [("NOREPI", "Norepinephrine", "µg/kg/min", 0.2, 0.1), ("PROPOFOL", "Propofol", "mg/h", 150, 50),
             ("MIDAZ", "Midazolam", "mg/h", 5, 2), ("INSULIN", "Insulin", "IU/h", 3, 2), ("FUROS", "Furosemide", "mg/h", 10, 5)]
WARD_DRUGS = [("PARACET", "Paracetamol", "g", 1, 0), ("ENOX", "Enoxaparin", "IU", 4000, 0)]
CONDITIONS = [("SEPSHOCK", "Septic shock"), ("ARDS", "Acute respiratory distress syndrome"), ("AKI", "Acute kidney injury"),
              ("PNEUMO", "Pneumonia"), ("HTA", "Essential hypertension"), ("T2D", "Type 2 diabetes mellitus")]
PROCEDURES = [("MV", "Invasive mechanical ventilation"), ("CVC", "Central venous catheter insertion"), ("HD", "Hemodialysis")]


def concept_rows():
    """Every local concept: (id, code, name, domain, class)."""
    out, n = [], 1
    for domain, cls, items in [("Measurement", "Vital sign", VITALS), ("Measurement", "Lab test", LABS),
                               ("Drug", "Ingredient", ICU_DRUGS + WARD_DRUGS), ("Condition", "Clinical finding", CONDITIONS),
                               ("Procedure", "Procedure", PROCEDURES)]:
        for item in items:
            out.append((LOCAL + n, item[0], item[1], domain, cls))
            n += 1
    return out


def ddl_tables(con) -> dict[str, list[tuple[str, str]]]:
    sql = re.sub(r"^ALTER TABLE.*$", "", DDL.read_text(), flags=re.M).replace("PRIMARY KEY", "").replace("NOT NULL", "")
    con.execute(sql)
    cols: dict[str, list[tuple[str, str]]] = {}
    for table, col, typ in con.execute(
        "SELECT table_name, column_name, data_type FROM information_schema.columns ORDER BY table_name, ordinal_position"
    ).fetchall():
        cols.setdefault(table, []).append((col, typ))
    return cols


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--patients", type=int, default=20, help="patient 1 is the heavy one, the others are light")
    ap.add_argument("--hz", type=float, default=1.0, help="heavy patient's ICU monitoring rate (1 Hz ≈ 51 M rows)")
    ap.add_argument("--unsorted", action="store_true", help="shuffle rows (not in patient order: triggers the layout warning)")
    args = ap.parse_args()

    out = args.out.expanduser().resolve()
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    t0 = time.monotonic()
    con = duckdb.connect(str(out / "_build.duckdb"))
    con.execute(f"SET temp_directory = '{out}/_tmp'")
    cols = ddl_tables(con)

    def write(table: str, select: str, order: str) -> None:
        given = {r[0] for r in con.execute(f"DESCRIBE ({select})").fetchall()}
        exprs = [f"CAST({c if c in given else 'NULL'} AS {t}) AS {c}" for c, t in cols[table]]
        sort = "hash(rowid_)" if args.unsorted else order
        (out / table).mkdir()
        con.execute(f"""COPY (SELECT {', '.join(exprs)} FROM (SELECT *, row_number() OVER () AS rowid_ FROM ({select})) ORDER BY {sort})
            TO '{out}/{table}/data_0.parquet' (FORMAT PARQUET, ROW_GROUP_SIZE 122880, COMPRESSION ZSTD)""")
        n = con.execute(f"SELECT COUNT(*) FROM '{out}/{table}/data_0.parquet'").fetchone()[0]
        print(f"  {table}: {n:,} rows ({time.monotonic() - t0:.0f}s)")

    # ── Stays: patient 1 as above, the others one short hospitalisation each ──
    visits, stays = [], []
    for p in range(1, args.patients + 1):
        plan = HEAVY if p == 1 else [(
            f"2022-01-01 08:00", f"2022-01-06 12:00",
            [(WARD, "2022-01-01 08:00", "2022-01-02 10:00"), (ICU, "2022-01-02 10:00", "2022-01-05 10:00"),
             (WARD, "2022-01-05 10:00", "2022-01-06 12:00")],
        )]
        shift = 0 if p == 1 else (p * 37) % 900  # days: light patients spread over the years
        for vs, ve, details in plan:
            vid = len(visits) + 1
            visits.append((vid, p, vs, ve, shift))
            for site, ds, de in details:
                stays.append((len(stays) + 1, vid, p, site, ds, de, shift))
    con.execute("CREATE TABLE v (vid INT, pid INT, vs TIMESTAMP, ve TIMESTAMP, shift INT)")
    con.executemany("INSERT INTO v VALUES (?, ?, ?, ?, ?)", visits)
    con.execute("CREATE TABLE s (sid INT, vid INT, pid INT, site INT, ds TIMESTAMP, de TIMESTAMP, shift INT)")
    con.executemany("INSERT INTO s VALUES (?, ?, ?, ?, ?, ?, ?)", stays)
    con.execute("UPDATE v SET vs = vs + to_days(shift), ve = ve + to_days(shift)")
    con.execute("UPDATE s SET ds = ds + to_days(shift), de = de + to_days(shift)")

    concepts = concept_rows()
    con.execute("CREATE TABLE c (id INT, code VARCHAR, name VARCHAR, domain VARCHAR, cls VARCHAR)")
    con.executemany("INSERT INTO c VALUES (?, ?, ?, ?, ?)", concepts)
    params = {code: (base, amp, unit) for code, _, unit, base, amp in VITALS + LABS + ICU_DRUGS + WARD_DRUGS}
    con.execute("CREATE TABLE prm (code VARCHAR, base DOUBLE, amp DOUBLE, unit VARCHAR)")
    con.executemany("INSERT INTO prm VALUES (?, ?, ?, ?)", [(k, *v[:2], v[2]) for k, v in params.items()])

    def series(codes, where, step_s, light_step_s):
        """One row per concept per tick over the matching stays, values drifting
        around their baseline (daily cycle + slow trend + noise)."""
        in_list = ", ".join(f"'{c}'" for c in codes)
        return f"""
          SELECT s.pid, s.vid, s.sid, c.id AS cid, c.code, p.unit, t.ts,
            ROUND(p.base + p.amp * (0.6 * sin(2 * pi() * epoch(t.ts) / 86400 + c.id % 100)
              + 0.4 * sin(2 * pi() * epoch(t.ts) / 604800 + (c.id % 100) * 3)
              + 0.5 * ((hash(t.ts, c.id) % 2000) / 1000.0 - 1)), 2) AS val
          FROM s CROSS JOIN c JOIN prm p ON p.code = c.code
          CROSS JOIN LATERAL (SELECT unnest(generate_series(s.ds, s.de - INTERVAL 1 SECOND,
              to_microseconds((CASE WHEN s.pid = 1 THEN {step_s} ELSE {light_step_s} END * 1e6)::BIGINT))) AS ts) t
          WHERE c.code IN ({in_list}) AND {where}"""

    vital_codes = [v[0] for v in VITALS]
    lab_codes = [v[0] for v in LABS]
    print(f"Writing to {out}")

    write("person", f"""SELECT r AS person_id, CASE WHEN r % 2 = 0 THEN 8532 ELSE 8507 END AS gender_concept_id,
        1945 + (r * 7) % 50 AS year_of_birth, 0 AS race_concept_id, 0 AS ethnicity_concept_id, 'P' || r AS person_source_value
        FROM range(1, {args.patients + 1}) t(r)""", "person_id")
    write("observation_period", """SELECT pid AS observation_period_id, pid AS person_id, MIN(vs)::DATE AS observation_period_start_date,
        MAX(ve)::DATE AS observation_period_end_date, 32817 AS period_type_concept_id FROM v GROUP BY pid""", "person_id")
    write("care_site", "SELECT * FROM (VALUES (1, 'Medicine ward', 'WARD'), (2, 'Intensive care unit', 'ICU')) t(care_site_id, care_site_name, care_site_source_value)", "care_site_id")
    write("visit_occurrence", """SELECT vid AS visit_occurrence_id, pid AS person_id, 9201 AS visit_concept_id, vs::DATE AS visit_start_date,
        vs AS visit_start_datetime, ve::DATE AS visit_end_date, ve AS visit_end_datetime, 32817 AS visit_type_concept_id,
        'Inpatient' AS visit_source_value FROM v""", "person_id, visit_start_datetime")
    write("visit_detail", """SELECT sid AS visit_detail_id, pid AS person_id, CASE WHEN site = 2 THEN 32037 ELSE 9201 END AS visit_detail_concept_id,
        ds::DATE AS visit_detail_start_date, ds AS visit_detail_start_datetime, de::DATE AS visit_detail_end_date, de AS visit_detail_end_datetime,
        32817 AS visit_detail_type_concept_id, site AS care_site_id, CASE WHEN site = 2 THEN 'ICU' ELSE 'WARD' END AS visit_detail_source_value,
        vid AS visit_occurrence_id FROM s""", "person_id, visit_detail_start_datetime")

    vitals = series(vital_codes, "s.site = 2", 1 / args.hz, 60)
    labs = series(lab_codes, "TRUE", "CASE WHEN s.site = 2 THEN 14400 ELSE 86400 END", "CASE WHEN s.site = 2 THEN 14400 ELSE 86400 END")
    write("measurement", f"""SELECT row_number() OVER () AS measurement_id, pid AS person_id, cid AS measurement_concept_id,
        ts::DATE AS measurement_date, ts AS measurement_datetime, 32817 AS measurement_type_concept_id, val AS value_as_number,
        0 AS unit_concept_id, vid AS visit_occurrence_id, sid AS visit_detail_id, code AS measurement_source_value,
        cid AS measurement_source_concept_id, unit AS unit_source_value, CAST(val AS VARCHAR) AS value_source_value
        FROM ({vitals} UNION ALL {labs})""", "person_id, measurement_datetime")

    icu_drugs = series([d[0] for d in ICU_DRUGS], "s.site = 2", 3600, 3600)
    ward_drugs = series([d[0] for d in WARD_DRUGS], "s.site = 1", 21600, 21600)
    write("drug_exposure", f"""SELECT row_number() OVER () AS drug_exposure_id, pid AS person_id, cid AS drug_concept_id,
        ts::DATE AS drug_exposure_start_date, ts AS drug_exposure_start_datetime, (ts + INTERVAL 1 HOUR)::DATE AS drug_exposure_end_date,
        ts + INTERVAL 1 HOUR AS drug_exposure_end_datetime, 32817 AS drug_type_concept_id, GREATEST(val, 0) AS quantity,
        vid AS visit_occurrence_id, sid AS visit_detail_id, code AS drug_source_value, cid AS drug_source_concept_id,
        CASE WHEN code IN ('PARACET') THEN 'oral' WHEN code = 'ENOX' THEN 'subcutaneous' ELSE 'intravenous' END AS route_source_value,
        unit AS dose_unit_source_value FROM ({icu_drugs} UNION ALL {ward_drugs})""", "person_id, drug_exposure_start_datetime")

    write("condition_occurrence", """SELECT row_number() OVER () AS condition_occurrence_id, v.pid AS person_id, c.id AS condition_concept_id,
        v.vs::DATE AS condition_start_date, v.vs + INTERVAL 2 HOUR AS condition_start_datetime, v.ve::DATE AS condition_end_date,
        v.ve AS condition_end_datetime, 32817 AS condition_type_concept_id, v.vid AS visit_occurrence_id, c.code AS condition_source_value,
        c.id AS condition_source_concept_id
        FROM v JOIN c ON c.domain = 'Condition' AND hash(v.vid, c.id) % 3 <> 0""", "person_id, condition_start_datetime")
    write("procedure_occurrence", """SELECT row_number() OVER () AS procedure_occurrence_id, s.pid AS person_id, c.id AS procedure_concept_id,
        s.ds::DATE AS procedure_date, s.ds + INTERVAL 3 HOUR AS procedure_datetime, s.de - INTERVAL 6 HOUR AS procedure_end_datetime,
        (s.de - INTERVAL 6 HOUR)::DATE AS procedure_end_date, 32817 AS procedure_type_concept_id, s.vid AS visit_occurrence_id,
        s.sid AS visit_detail_id, c.code AS procedure_source_value, c.id AS procedure_source_concept_id
        FROM s JOIN c ON c.domain = 'Procedure' AND s.site = 2 AND (c.code <> 'HD' OR s.pid = 1)""", "person_id, procedure_datetime")
    write("note", """SELECT row_number() OVER () AS note_id, s.pid AS person_id, d::DATE AS note_date, d + INTERVAL 10 HOUR AS note_datetime,
        32817 AS note_type_concept_id, 0 AS note_class_concept_id,
        CASE WHEN s.site = 2 THEN 'ICU progress note' ELSE 'Ward progress note' END AS note_title,
        'Synthetic note for patient ' || s.pid || ', stay ' || s.sid || ', ' || strftime(d, '%Y-%m-%d') ||
          '. Stable overnight. Plan: continue current treatment, reassess tomorrow.' AS note_text,
        0 AS encoding_concept_id, 0 AS language_concept_id, s.vid AS visit_occurrence_id, s.sid AS visit_detail_id,
        CASE WHEN s.site = 2 THEN 'ICU' ELSE 'WARD' END AS note_source_value
        FROM s CROSS JOIN LATERAL (SELECT unnest(generate_series(date_trunc('day', s.ds), s.de - INTERVAL 10 HOUR, INTERVAL 1 DAY)) AS d)""",
        "person_id, note_datetime")
    write("concept", f"""SELECT id AS concept_id, name AS concept_name, domain AS domain_id, 'Linkr synthetic' AS vocabulary_id,
          cls AS concept_class_id, 'S' AS standard_concept, code AS concept_code, DATE '2000-01-01' AS valid_start_date,
          DATE '2099-12-31' AS valid_end_date FROM c
        UNION ALL SELECT * FROM (VALUES
          (8507, 'MALE', 'Gender', 'Gender', 'Gender', 'S', 'M', DATE '1970-01-01', DATE '2099-12-31'),
          (8532, 'FEMALE', 'Gender', 'Gender', 'Gender', 'S', 'F', DATE '1970-01-01', DATE '2099-12-31'),
          (9201, 'Inpatient Visit', 'Visit', 'Visit', 'Visit', 'S', 'IP', DATE '1970-01-01', DATE '2099-12-31'),
          (32037, 'Intensive Care', 'Visit', 'Visit', 'Visit', 'S', 'OMOP4822460', DATE '1970-01-01', DATE '2099-12-31'),
          (32817, 'EHR', 'Type Concept', 'Type Concept', 'Type Concept', 'S', 'OMOP4976890', DATE '1970-01-01', DATE '2099-12-31')
        ) t(concept_id, concept_name, domain_id, vocabulary_id, concept_class_id, standard_concept, concept_code, valid_start_date, valid_end_date)""",
        "concept_id")
    write("vocabulary", """SELECT 'Linkr synthetic' AS vocabulary_id, 'Synthetic concepts for the Linkr overview test database' AS vocabulary_name,
        'Generated' AS vocabulary_version, 0 AS vocabulary_concept_id""", "vocabulary_id")
    write("death", "SELECT 1 AS person_id WHERE FALSE", "person_id")

    con.close()
    (out / "_build.duckdb").unlink()
    shutil.rmtree(out / "_tmp", ignore_errors=True)
    print(f"Done in {time.monotonic() - t0:.0f}s")


if __name__ == "__main__":
    main()
