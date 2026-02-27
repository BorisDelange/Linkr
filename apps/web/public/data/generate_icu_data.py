"""
Generate realistic ICU dashboard data for a French ICU unit.
Produces a single CSV file in long typed format:
  - icu_events.csv (one row per stay + one row per event)

Stay-level columns are denormalized (repeated on every row).
The first row per stay has event_type empty (pure stay row).
Subsequent rows have event_type = mechanical_ventilation | rrt | infection | device.
"""

import csv
import random
import math
from datetime import datetime, timedelta
from collections import Counter

random.seed(42)

N_ADMISSIONS = 200

# --- Helper functions ---

def random_date(start: datetime, end: datetime) -> datetime:
    delta = end - start
    seconds = random.randint(0, int(delta.total_seconds()))
    return start + timedelta(seconds=seconds)

def weighted_choice(options: dict):
    """options = {value: weight, ...}"""
    items = list(options.keys())
    weights = list(options.values())
    return random.choices(items, weights=weights, k=1)[0]

def clamp(val, lo, hi):
    return max(lo, min(hi, val))

def fmt_dt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M")

# --- Reference data ---

ORIGIN_WARDS = {
    "Urgences": 0.30,
    "Bloc opératoire": 0.25,
    "Médecine interne": 0.10,
    "Cardiologie": 0.08,
    "Pneumologie": 0.07,
    "Neurologie": 0.05,
    "Chirurgie digestive": 0.05,
    "Chirurgie thoracique": 0.03,
    "Autre hôpital": 0.05,
    "SSPI": 0.02,
}

DESTINATION_WARDS = {
    "Médecine interne": 0.20,
    "Chirurgie": 0.15,
    "Pneumologie": 0.10,
    "Cardiologie": 0.10,
    "USC": 0.15,
    "SSR": 0.08,
    "Neurologie": 0.05,
    "Autre hôpital": 0.05,
    "Domicile": 0.02,
}

ADMISSION_TYPES = {
    "Médical": 0.45,
    "Chirurgical programmé": 0.25,
    "Chirurgical urgent": 0.20,
    "Trauma": 0.10,
}

RRT_TYPES = {
    "CVVH": 0.35,
    "CVVHDF": 0.40,
    "HDI": 0.15,
    "SLED": 0.10,
}

RRT_INDICATIONS = {
    "Oligurie/Anurie": 0.35,
    "Hyperkaliémie": 0.20,
    "Acidose métabolique": 0.20,
    "Surcharge hydrosodée": 0.15,
    "Intoxication": 0.10,
}

INFECTION_TYPES = {
    "PAVM": 0.35,
    "Bactériémie liée au KT": 0.25,
    "Infection urinaire": 0.20,
    "Infection site opératoire": 0.10,
    "Autre": 0.10,
}

PATHOGENS_BY_TYPE = {
    "PAVM": {
        "Pseudomonas aeruginosa": 0.25,
        "Staphylococcus aureus": 0.20,
        "Klebsiella pneumoniae": 0.15,
        "Escherichia coli": 0.10,
        "Acinetobacter baumannii": 0.10,
        "Enterobacter cloacae": 0.08,
        "Stenotrophomonas maltophilia": 0.07,
        "Haemophilus influenzae": 0.05,
    },
    "Bactériémie liée au KT": {
        "Staphylococcus epidermidis": 0.30,
        "Staphylococcus aureus": 0.20,
        "Enterococcus faecalis": 0.15,
        "Candida albicans": 0.10,
        "Klebsiella pneumoniae": 0.10,
        "Escherichia coli": 0.08,
        "Pseudomonas aeruginosa": 0.07,
    },
    "Infection urinaire": {
        "Escherichia coli": 0.35,
        "Klebsiella pneumoniae": 0.15,
        "Enterococcus faecalis": 0.15,
        "Pseudomonas aeruginosa": 0.10,
        "Candida albicans": 0.15,
        "Proteus mirabilis": 0.10,
    },
    "Infection site opératoire": {
        "Staphylococcus aureus": 0.30,
        "Escherichia coli": 0.20,
        "Enterococcus faecalis": 0.15,
        "Pseudomonas aeruginosa": 0.10,
        "Klebsiella pneumoniae": 0.10,
        "Bacteroides fragilis": 0.15,
    },
    "Autre": {
        "Clostridium difficile": 0.30,
        "Staphylococcus aureus": 0.20,
        "Escherichia coli": 0.15,
        "Candida albicans": 0.15,
        "Aspergillus fumigatus": 0.10,
        "Enterococcus faecalis": 0.10,
    },
}

MDRO_PATHOGENS = {
    "Staphylococcus aureus", "Klebsiella pneumoniae", "Acinetobacter baumannii",
    "Pseudomonas aeruginosa", "Enterobacter cloacae", "Escherichia coli",
}

CVC_SITES = {
    "Jugulaire interne droite": 0.35,
    "Jugulaire interne gauche": 0.15,
    "Sous-clavier droit": 0.15,
    "Sous-clavier gauche": 0.10,
    "Fémoral droit": 0.15,
    "Fémoral gauche": 0.10,
}

ARTERIAL_SITES = {
    "Radial gauche": 0.35,
    "Radial droit": 0.30,
    "Fémoral droit": 0.20,
    "Fémoral gauche": 0.15,
}

ECMO_TYPES = {"VV": 0.65, "VA": 0.35}

# --- CSV columns ---

STAY_COLUMNS = [
    "person_id", "visit_occurrence_id", "visit_detail_id",
    "sex", "age", "admission_type", "origin_ward", "destination_ward", "discharge_disposition",
    "hospital_admission_datetime", "hospital_discharge_datetime", "hospital_los",
    "unit_admission_datetime", "unit_discharge_datetime", "unit_los",
    "saps2_score", "sofa_admission", "sofa_max",
    "deceased_in_icu", "deceased_in_hospital", "is_readmission_48h",
]

EVENT_COLUMNS = [
    "event_type", "event_start_datetime", "event_end_datetime",
]

VENTILATION_COLUMNS = [
    "tidal_volume_per_pbw", "pf_ratio", "unplanned_extubation", "reintubation_48h", "tracheostomy",
]

RRT_COLUMNS = [
    "rrt_type", "rrt_indication", "creatinine_max",
]

INFECTION_COLUMNS = [
    "infection_type", "pathogen", "is_mdro", "adequate_empirical_abx", "antibiotic_ddd",
]

DEVICE_COLUMNS = [
    "device_type", "device_site",
]

ALL_COLUMNS = STAY_COLUMNS + EVENT_COLUMNS + VENTILATION_COLUMNS + RRT_COLUMNS + INFECTION_COLUMNS + DEVICE_COLUMNS

# --- Build patient pool ---

person_ids_pool = list(range(1001, 1001 + 190))
random.shuffle(person_ids_pool)

person_id_list = []
for i in range(180):
    person_id_list.append(person_ids_pool[i])
for i in range(20):
    person_id_list.append(person_ids_pool[i])  # 20 readmissions

random.shuffle(person_id_list)

patient_demographics = {}
patient_first_discharge = {}

start_date = datetime(2024, 1, 1)
end_date = datetime(2025, 12, 31)

pid_counts = Counter(person_id_list)
readmission_pids = {pid for pid, cnt in pid_counts.items() if cnt > 1}
pid_visit_num = {}

# --- Generate stays and events ---

all_rows = []
stay_data_list = []  # keep raw stay data for readmission computation

for idx in range(N_ADMISSIONS):
    visit_occurrence_id = 5000 + idx
    visit_detail_id = 8000 + idx
    person_id = person_id_list[idx]

    pid_visit_num[person_id] = pid_visit_num.get(person_id, 0) + 1
    visit_num = pid_visit_num[person_id]

    # Demographics
    if person_id not in patient_demographics:
        sex = weighted_choice({"M": 0.62, "F": 0.38})
        age = clamp(int(random.gauss(63, 16)), 18, 95)
        patient_demographics[person_id] = {"sex": sex, "age": age}
    else:
        sex = patient_demographics[person_id]["sex"]
        age = patient_demographics[person_id]["age"]

    admission_type = weighted_choice(ADMISSION_TYPES)
    origin_ward = weighted_choice(ORIGIN_WARDS)

    # ICU admission
    if person_id in readmission_pids and visit_num > 1 and person_id in patient_first_discharge:
        prev_discharge = patient_first_discharge[person_id]
        if random.random() < 0.50:
            gap_hours = random.uniform(6, 48)
        else:
            gap_hours = random.uniform(48, 168)
        unit_admission = prev_discharge + timedelta(hours=gap_hours)
    else:
        unit_admission = random_date(start_date, end_date)

    # Unit LOS
    unit_los = round(max(0.5, random.lognormvariate(math.log(4), 0.7)), 1)
    unit_discharge = unit_admission + timedelta(days=unit_los)
    patient_first_discharge[person_id] = unit_discharge

    # Hospital dates
    hospital_to_icu_days = round(max(0, random.expovariate(1 / 1.5)), 1)
    hospital_admission = unit_admission - timedelta(days=hospital_to_icu_days)
    # Hospital discharge: after ICU discharge + 0-10 days in downstream ward
    post_icu_days = round(max(0, random.expovariate(1 / 3)), 1)
    hospital_discharge = unit_discharge + timedelta(days=post_icu_days)
    hospital_los = round((hospital_discharge - hospital_admission).total_seconds() / 86400, 1)

    # Severity scores
    saps2 = clamp(int(random.gauss(42, 18)), 8, 120)
    sofa_admission = clamp(int(random.gauss(6, 3.5)), 0, 20)
    sofa_max = clamp(sofa_admission + int(random.expovariate(1 / 2)), sofa_admission, 24)

    # Mortality
    mortality_prob = 1 / (1 + math.exp(-(saps2 - 65) / 15))
    deceased_in_icu = random.random() < mortality_prob
    deceased_in_hospital = deceased_in_icu or (random.random() < 0.05)

    # Destination ward
    if deceased_in_icu:
        destination_ward = "Décès"
        discharge_disposition = "Décès en réanimation"
        hospital_discharge = unit_discharge
        hospital_los = round((hospital_discharge - hospital_admission).total_seconds() / 86400, 1)
    elif deceased_in_hospital:
        destination_ward = weighted_choice(DESTINATION_WARDS)
        discharge_disposition = "Décès en hospitalisation"
    else:
        destination_ward = weighted_choice(DESTINATION_WARDS)
        discharge_disposition = "Transfert en service" if destination_ward not in ("Domicile", "Autre hôpital") else destination_ward

    # Stay base row
    stay = {
        "person_id": person_id,
        "visit_occurrence_id": visit_occurrence_id,
        "visit_detail_id": visit_detail_id,
        "sex": sex,
        "age": age,
        "admission_type": admission_type,
        "origin_ward": origin_ward,
        "destination_ward": destination_ward,
        "discharge_disposition": discharge_disposition,
        "hospital_admission_datetime": fmt_dt(hospital_admission),
        "hospital_discharge_datetime": fmt_dt(hospital_discharge),
        "hospital_los": hospital_los,
        "unit_admission_datetime": fmt_dt(unit_admission),
        "unit_discharge_datetime": fmt_dt(unit_discharge),
        "unit_los": unit_los,
        "saps2_score": saps2,
        "sofa_admission": sofa_admission,
        "sofa_max": sofa_max,
        "deceased_in_icu": int(deceased_in_icu),
        "deceased_in_hospital": int(deceased_in_hospital),
        "is_readmission_48h": 0,  # computed later
    }

    stay_data_list.append(stay)

    def make_row(**event_cols):
        """Create a row with stay columns + event columns."""
        row = {c: "" for c in ALL_COLUMNS}
        row.update(stay)
        row.update(event_cols)
        return row

    # --- Stay row (event_type empty) ---
    all_rows.append(make_row())

    # --- Mechanical ventilation (~60%) ---
    if random.random() < 0.60:
        mv_start_offset_h = random.uniform(0, 12)
        mv_start = unit_admission + timedelta(hours=mv_start_offset_h)
        mv_duration_hours = round(max(2, random.lognormvariate(math.log(72), 0.8)), 1)
        mv_end = mv_start + timedelta(hours=mv_duration_hours)
        mv_end = min(mv_end, unit_discharge)

        height_cm = random.gauss(172 if sex == "M" else 163, 8)
        pbw_kg = (50 if sex == "M" else 45.5) + 0.91 * (height_cm - 152.4)
        vt_pbw = round(clamp(random.gauss(6.8, 1.2), 4.0, 12.0), 1)
        pf_ratio = clamp(int(random.gauss(220, 90)), 50, 500)

        all_rows.append(make_row(
            event_type="mechanical_ventilation",
            event_start_datetime=fmt_dt(mv_start),
            event_end_datetime=fmt_dt(mv_end),
            tidal_volume_per_pbw=vt_pbw,
            pf_ratio=pf_ratio,
            unplanned_extubation=int(random.random() < 0.05),
            reintubation_48h=int(random.random() < 0.12),
            tracheostomy=int(random.random() < 0.08),
        ))

    # --- Renal replacement therapy (~10%) ---
    if random.random() < 0.10:
        rrt_start_offset_h = random.uniform(6, 48)
        rrt_start = unit_admission + timedelta(hours=rrt_start_offset_h)
        rrt_duration_days = round(max(1, random.lognormvariate(math.log(4), 0.6)), 1)
        rrt_end = rrt_start + timedelta(days=rrt_duration_days)
        rrt_end = min(rrt_end, unit_discharge)

        all_rows.append(make_row(
            event_type="renal_replacement_therapy",
            event_start_datetime=fmt_dt(rrt_start),
            event_end_datetime=fmt_dt(rrt_end),
            rrt_type=weighted_choice(RRT_TYPES),
            rrt_indication=weighted_choice(RRT_INDICATIONS),
            creatinine_max=int(clamp(random.gauss(350, 100), 150, 800)),
        ))

    # --- Infections (~15%) ---
    base_infection_prob = 0.12
    if unit_los > 7:
        base_infection_prob += 0.10

    if random.random() < base_infection_prob:
        n_infections = weighted_choice({1: 0.75, 2: 0.25})
        used_types = set()
        for _ in range(n_infections):
            inf_type = weighted_choice(INFECTION_TYPES)
            attempts = 0
            while inf_type in used_types and attempts < 10:
                inf_type = weighted_choice(INFECTION_TYPES)
                attempts += 1
            used_types.add(inf_type)

            pathogen = weighted_choice(PATHOGENS_BY_TYPE[inf_type])
            is_mdro = int((pathogen in MDRO_PATHOGENS) and (random.random() < 0.25))
            onset_day = clamp(int(random.gauss(5, 3)), 2, int(unit_los + 1))
            inf_start = unit_admission + timedelta(days=onset_day)
            antibiotic_ddd = round(max(0, random.gauss(unit_los * 1.2, unit_los * 0.5)), 1)

            all_rows.append(make_row(
                event_type="infection",
                event_start_datetime=fmt_dt(inf_start),
                infection_type=inf_type,
                pathogen=pathogen,
                is_mdro=is_mdro,
                adequate_empirical_abx=int(random.random() < 0.72),
                antibiotic_ddd=antibiotic_ddd,
            ))

    # --- Devices ---

    # CVC (~65%)
    if random.random() < 0.65:
        site = weighted_choice(CVC_SITES)
        dur = min(round(max(1, random.lognormvariate(math.log(5), 0.5)), 1), unit_los)
        dev_start = unit_admission + timedelta(hours=random.uniform(0, 4))
        dev_end = dev_start + timedelta(days=dur)
        dev_end = min(dev_end, unit_discharge)
        all_rows.append(make_row(
            event_type="device",
            event_start_datetime=fmt_dt(dev_start),
            event_end_datetime=fmt_dt(dev_end),
            device_type="CVC",
            device_site=site,
        ))

    # Arterial line (~55%)
    if random.random() < 0.55:
        site = weighted_choice(ARTERIAL_SITES)
        dur = min(round(max(0.5, random.lognormvariate(math.log(3), 0.5)), 1), unit_los)
        dev_start = unit_admission + timedelta(hours=random.uniform(0, 4))
        dev_end = dev_start + timedelta(days=dur)
        dev_end = min(dev_end, unit_discharge)
        all_rows.append(make_row(
            event_type="device",
            event_start_datetime=fmt_dt(dev_start),
            event_end_datetime=fmt_dt(dev_end),
            device_type="Cathéter artériel",
            device_site=site,
        ))

    # Urinary catheter (~75%)
    if random.random() < 0.75:
        dur = min(round(max(0.5, random.lognormvariate(math.log(4), 0.5)), 1), unit_los)
        dev_start = unit_admission + timedelta(hours=random.uniform(0, 2))
        dev_end = dev_start + timedelta(days=dur)
        dev_end = min(dev_end, unit_discharge)
        all_rows.append(make_row(
            event_type="device",
            event_start_datetime=fmt_dt(dev_start),
            event_end_datetime=fmt_dt(dev_end),
            device_type="Sonde urinaire",
            device_site="",
        ))

    # Chest drain (~8%)
    if random.random() < 0.08:
        dur = round(max(1, random.lognormvariate(math.log(3), 0.5)), 1)
        dev_start = unit_admission + timedelta(hours=random.uniform(0, 24))
        dev_end = dev_start + timedelta(days=dur)
        dev_end = min(dev_end, unit_discharge)
        all_rows.append(make_row(
            event_type="device",
            event_start_datetime=fmt_dt(dev_start),
            event_end_datetime=fmt_dt(dev_end),
            device_type="Drain thoracique",
            device_site=weighted_choice({"Droit": 0.55, "Gauche": 0.45}),
        ))

    # ECMO (~3%)
    if random.random() < 0.03:
        ecmo_type = weighted_choice(ECMO_TYPES)
        dur = round(max(2, random.lognormvariate(math.log(7), 0.5)), 1)
        dev_start = unit_admission + timedelta(hours=random.uniform(0, 12))
        dev_end = dev_start + timedelta(days=dur)
        dev_end = min(dev_end, unit_discharge)
        all_rows.append(make_row(
            event_type="device",
            event_start_datetime=fmt_dt(dev_start),
            event_end_datetime=fmt_dt(dev_end),
            device_type="ECMO",
            device_site=ecmo_type,
        ))

# --- Compute readmission flags ---

stay_data_list.sort(key=lambda s: (s["person_id"], s["unit_admission_datetime"]))
for i in range(1, len(stay_data_list)):
    if stay_data_list[i]["person_id"] == stay_data_list[i - 1]["person_id"]:
        prev_discharge = datetime.strptime(stay_data_list[i - 1]["unit_discharge_datetime"], "%Y-%m-%d %H:%M")
        curr_admission = datetime.strptime(stay_data_list[i]["unit_admission_datetime"], "%Y-%m-%d %H:%M")
        if (curr_admission - prev_discharge).total_seconds() < 48 * 3600:
            stay_data_list[i]["is_readmission_48h"] = 1

# Apply readmission flags back to all rows
readmission_map = {s["visit_detail_id"]: s["is_readmission_48h"] for s in stay_data_list}
for row in all_rows:
    row["is_readmission_48h"] = readmission_map.get(row["visit_detail_id"], 0)

# Sort by visit_detail_id then event_type (stay row first)
event_order = {"": 0, "mechanical_ventilation": 1, "renal_replacement_therapy": 2, "infection": 3, "device": 4}
all_rows.sort(key=lambda r: (r["visit_detail_id"], event_order.get(r.get("event_type", ""), 9)))

# --- Write CSV ---

output_dir = "/Users/borisdelange/Documents/Mac/Programming projects/linkr-v2/apps/web/public/data/"

with open(output_dir + "icu_events.csv", "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=ALL_COLUMNS, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(all_rows)

# --- Summary stats ---
stay_rows = [r for r in all_rows if r["event_type"] == ""]
mv_rows = [r for r in all_rows if r["event_type"] == "mechanical_ventilation"]
rrt_rows = [r for r in all_rows if r["event_type"] == "renal_replacement_therapy"]
inf_rows = [r for r in all_rows if r["event_type"] == "infection"]
dev_rows = [r for r in all_rows if r["event_type"] == "device"]

n = len(stay_rows)
n_deceased = sum(1 for r in stay_rows if r["deceased_in_icu"])
n_readmission = sum(1 for r in stay_rows if r["is_readmission_48h"])

print(f"=== ICU Dashboard Data Generated ===")
print(f"Total rows:            {len(all_rows)}")
print(f"Stay rows:             {n}")
print(f"Unique patients:       {len(set(r['person_id'] for r in stay_rows))}")
print(f"Ventilation events:    {len(mv_rows)} ({100 * len(mv_rows) / n:.1f}%)")
print(f"RRT events:            {len(rrt_rows)} ({100 * len(rrt_rows) / n:.1f}%)")
print(f"Infection episodes:    {len(inf_rows)}")
print(f"Device events:         {len(dev_rows)}")
print(f"Deceased in ICU:       {n_deceased} ({100 * n_deceased / n:.1f}%)")
print(f"Readmissions 48h:      {n_readmission} ({100 * n_readmission / n:.1f}%)")
print(f"\nFile written: {output_dir}icu_events.csv")
