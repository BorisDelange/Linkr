"""
Generate realistic ICU dashboard data for a French ICU unit.
Produces 3 CSV files:
  - icu_admissions.csv (200 admissions, one row per admission)
  - icu_infections.csv (nosocomial infections, one row per infection episode)
  - icu_procedures.csv (invasive devices, one row per device)
"""

import csv
import random
import math
from datetime import datetime, timedelta

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
    "USC": 0.15,  # Unité de soins continus
    "SSR": 0.08,
    "Neurologie": 0.05,
    "Autre hôpital": 0.05,
    "Domicile": 0.02,
    # deceased handled separately
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

# Pathogens by infection type (realistic distribution)
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
    "Staphylococcus aureus",  # MRSA
    "Klebsiella pneumoniae",  # ESBL
    "Acinetobacter baumannii",
    "Pseudomonas aeruginosa",
    "Enterobacter cloacae",
    "Escherichia coli",  # ESBL
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

ECMO_TYPES = {
    "VV": 0.65,
    "VA": 0.35,
}

# --- Generate admissions ---

admissions = []
person_ids_pool = list(range(1001, 1001 + 190))  # 190 unique patients → some readmissions
random.shuffle(person_ids_pool)

# Assign person_ids: most patients have 1 admission, ~10 have 2 (readmissions)
person_id_list = []
for i in range(180):
    person_id_list.append(person_ids_pool[i])
for i in range(20):
    person_id_list.append(person_ids_pool[i])  # 20 readmissions from first 20 patients

random.shuffle(person_id_list)

# Track per-patient sex and age (consistent across readmissions)
patient_demographics = {}
# Track first admission discharge for readmission patients
patient_first_discharge = {}

start_date = datetime(2024, 1, 1)
end_date = datetime(2025, 12, 31)

# Identify which person_ids appear more than once (readmissions)
from collections import Counter
pid_counts = Counter(person_id_list)
readmission_pids = {pid for pid, cnt in pid_counts.items() if cnt > 1}
pid_visit_num = {}  # track visit number per patient

for idx in range(N_ADMISSIONS):
    visit_occurrence_id = 5000 + idx
    visit_detail_id = 8000 + idx
    person_id = person_id_list[idx]

    # Track visit number
    pid_visit_num[person_id] = pid_visit_num.get(person_id, 0) + 1
    visit_num = pid_visit_num[person_id]

    # Demographics (consistent per patient)
    if person_id not in patient_demographics:
        sex = weighted_choice({"M": 0.62, "F": 0.38})  # ICU ~62% male
        age = clamp(int(random.gauss(63, 16)), 18, 95)  # Mean ~63, SD ~16
        patient_demographics[person_id] = {"sex": sex, "age": age}
    else:
        sex = patient_demographics[person_id]["sex"]
        age = patient_demographics[person_id]["age"]

    admission_type = weighted_choice(ADMISSION_TYPES)
    origin_ward = weighted_choice(ORIGIN_WARDS)

    # ICU admission datetime — for readmissions, place within 6-72h of prior discharge
    if person_id in readmission_pids and visit_num > 1 and person_id in patient_first_discharge:
        prev_discharge = patient_first_discharge[person_id]
        # ~50% within 48h (true readmission), ~50% later
        if random.random() < 0.50:
            gap_hours = random.uniform(6, 48)
        else:
            gap_hours = random.uniform(48, 168)  # 2-7 days
        icu_admission = prev_discharge + timedelta(hours=gap_hours)
    else:
        icu_admission = random_date(start_date, end_date)

    # LOS: lognormal, median ~4 days, some long stays
    icu_los_days = round(max(0.5, random.lognormvariate(math.log(4), 0.7)), 1)
    icu_discharge = icu_admission + timedelta(days=icu_los_days)

    # Store discharge for readmission tracking
    patient_first_discharge[person_id] = icu_discharge

    # Hospital admission before ICU (0-7 days)
    hospital_to_icu_days = round(max(0, random.expovariate(1/1.5)), 1)
    hospital_admission = icu_admission - timedelta(days=hospital_to_icu_days)

    # Severity scores
    saps2 = clamp(int(random.gauss(42, 18)), 8, 120)
    sofa_admission = clamp(int(random.gauss(6, 3.5)), 0, 20)
    sofa_max = clamp(sofa_admission + int(random.expovariate(1/2)), sofa_admission, 24)

    # Mortality: ~18% ICU, correlated with SAPS2
    mortality_prob = 1 / (1 + math.exp(-(saps2 - 65) / 15))
    deceased_in_icu = random.random() < mortality_prob
    # Hospital mortality: ICU deceased + ~5% of ICU survivors
    deceased_in_hospital = deceased_in_icu or (random.random() < 0.05)

    # Destination ward
    if deceased_in_icu:
        destination_ward = "Décès"
        discharge_disposition = "Décès en réanimation"
    elif deceased_in_hospital:
        destination_ward = weighted_choice(DESTINATION_WARDS)
        discharge_disposition = "Décès en hospitalisation"
    else:
        destination_ward = weighted_choice(DESTINATION_WARDS)
        discharge_disposition = "Transfert en service" if destination_ward not in ("Domicile", "Autre hôpital") else destination_ward

    # Readmission flag (will be computed after sorting)
    # For now, placeholder
    is_readmission_48h = False

    # --- Mechanical ventilation ---
    # ~60% of ICU patients are ventilated
    mechanical_ventilation = random.random() < 0.60
    if mechanical_ventilation:
        mv_duration_hours = round(max(2, random.lognormvariate(math.log(72), 0.8)), 1)
        # Ideal body weight based tidal volume
        # PBW male: 50 + 0.91*(height-152.4), female: 45.5 + 0.91*(height-152.4)
        height_cm = random.gauss(172 if sex == "M" else 163, 8)
        pbw_kg = (50 if sex == "M" else 45.5) + 0.91 * (height_cm - 152.4)
        # Vt/PBW: target 6-8 mL/kg, some non-compliant
        tidal_volume_per_pbw = round(random.gauss(6.8, 1.2), 1)
        tidal_volume_per_pbw = clamp(tidal_volume_per_pbw, 4.0, 12.0)
        # P/F ratio day 1
        pf_ratio_day1 = clamp(int(random.gauss(220, 90)), 50, 500)
        # Unplanned extubation: ~5% of ventilated
        unplanned_extubation = random.random() < 0.05
        # Reintubation 48h: ~12% of ventilated
        reintubation_48h = random.random() < 0.12
        # Tracheostomy: ~8% of ventilated
        tracheostomy = random.random() < 0.08
    else:
        mv_duration_hours = None
        tidal_volume_per_pbw = None
        pf_ratio_day1 = None
        unplanned_extubation = False
        reintubation_48h = False
        tracheostomy = False

    # --- Renal replacement therapy ---
    # ~10% of ICU patients
    rrt = random.random() < 0.10
    if rrt:
        rrt_type = weighted_choice(RRT_TYPES)
        rrt_duration_days = round(max(1, random.lognormvariate(math.log(4), 0.6)), 1)
        rrt_indication = weighted_choice(RRT_INDICATIONS)
        creatinine_max = round(random.gauss(350, 100), 0)
        creatinine_max = clamp(creatinine_max, 150, 800)
    else:
        rrt_type = None
        rrt_duration_days = None
        rrt_indication = None
        creatinine_max = round(random.gauss(95, 40), 0)
        creatinine_max = clamp(creatinine_max, 40, 300)

    # Antibiotic DDD (defined daily doses during stay)
    antibiotic_ddd = round(max(0, random.gauss(icu_los_days * 1.2, icu_los_days * 0.5)), 1)

    admissions.append({
        "person_id": person_id,
        "visit_occurrence_id": visit_occurrence_id,
        "visit_detail_id": visit_detail_id,
        "sex": sex,
        "age": age,
        "admission_type": admission_type,
        "origin_ward": origin_ward,
        "destination_ward": destination_ward,
        "discharge_disposition": discharge_disposition,
        "icu_admission_datetime": icu_admission.strftime("%Y-%m-%d %H:%M"),
        "icu_discharge_datetime": icu_discharge.strftime("%Y-%m-%d %H:%M"),
        "hospital_admission_datetime": hospital_admission.strftime("%Y-%m-%d %H:%M"),
        "icu_los_days": icu_los_days,
        "hospital_to_icu_days": hospital_to_icu_days,
        "saps2_score": saps2,
        "sofa_admission": sofa_admission,
        "sofa_max": sofa_max,
        "deceased_in_icu": int(deceased_in_icu),
        "deceased_in_hospital": int(deceased_in_hospital),
        "is_readmission_48h": 0,  # will compute below
        "mechanical_ventilation": int(mechanical_ventilation),
        "mv_duration_hours": mv_duration_hours if mv_duration_hours else "",
        "tidal_volume_per_pbw": tidal_volume_per_pbw if tidal_volume_per_pbw else "",
        "pf_ratio_day1": pf_ratio_day1 if pf_ratio_day1 else "",
        "unplanned_extubation": int(unplanned_extubation),
        "reintubation_48h": int(reintubation_48h),
        "tracheostomy": int(tracheostomy),
        "renal_replacement_therapy": int(rrt),
        "rrt_type": rrt_type if rrt_type else "",
        "rrt_duration_days": rrt_duration_days if rrt_duration_days else "",
        "rrt_indication": rrt_indication if rrt_indication else "",
        "creatinine_max": int(creatinine_max),
        "antibiotic_ddd": antibiotic_ddd,
    })

# --- Compute readmission flags ---
# Sort admissions by person_id and admission time
admissions.sort(key=lambda a: (a["person_id"], a["icu_admission_datetime"]))
for i in range(1, len(admissions)):
    if admissions[i]["person_id"] == admissions[i-1]["person_id"]:
        prev_discharge = datetime.strptime(admissions[i-1]["icu_discharge_datetime"], "%Y-%m-%d %H:%M")
        curr_admission = datetime.strptime(admissions[i]["icu_admission_datetime"], "%Y-%m-%d %H:%M")
        if (curr_admission - prev_discharge).total_seconds() < 48 * 3600:
            admissions[i]["is_readmission_48h"] = 1

# Re-sort by visit_detail_id for clean output
admissions.sort(key=lambda a: a["visit_detail_id"])

# --- Generate infections ---
infections = []
infection_id = 1

for adm in admissions:
    # ~15% of patients get at least one nosocomial infection
    # Higher if longer stay and ventilated
    base_prob = 0.12
    if adm["mechanical_ventilation"]:
        base_prob += 0.08
    if adm["icu_los_days"] > 7:
        base_prob += 0.10

    if random.random() < base_prob:
        # 1-2 infections per patient
        n_infections = weighted_choice({1: 0.75, 2: 0.25})
        used_types = set()
        for _ in range(n_infections):
            inf_type = weighted_choice(INFECTION_TYPES)
            # Avoid duplicate types for same patient
            attempts = 0
            while inf_type in used_types and attempts < 10:
                inf_type = weighted_choice(INFECTION_TYPES)
                attempts += 1
            used_types.add(inf_type)

            pathogen = weighted_choice(PATHOGENS_BY_TYPE[inf_type])
            is_mdro = (pathogen in MDRO_PATHOGENS) and (random.random() < 0.25)
            onset_day = clamp(int(random.gauss(5, 3)), 2, int(adm["icu_los_days"] + 1))
            adequate_abx = random.random() < 0.72  # ~72% adequate empirical ABx

            infections.append({
                "infection_id": infection_id,
                "visit_detail_id": adm["visit_detail_id"],
                "person_id": adm["person_id"],
                "infection_type": inf_type,
                "pathogen": pathogen,
                "is_mdro": int(is_mdro),
                "infection_onset_day": onset_day,
                "adequate_empirical_abx": int(adequate_abx),
            })
            infection_id += 1

    # Mark nosocomial_infection on admission
    adm["nosocomial_infection"] = int(any(
        inf["visit_detail_id"] == adm["visit_detail_id"] for inf in infections
    ))

# --- Generate procedures ---
procedures = []
procedure_id = 1

for adm in admissions:
    # CVC: ~65% of ICU patients
    if random.random() < 0.65:
        site = weighted_choice(CVC_SITES)
        duration_days = round(max(1, random.lognormvariate(math.log(5), 0.5)), 1)
        duration_days = min(duration_days, adm["icu_los_days"])
        procedures.append({
            "procedure_id": procedure_id,
            "visit_detail_id": adm["visit_detail_id"],
            "person_id": adm["person_id"],
            "device_type": "Cathéter veineux central",
            "device_site": site,
            "duration_days": duration_days,
        })
        procedure_id += 1
        adm["has_cvc"] = 1
        adm["cvc_site"] = site
    else:
        adm["has_cvc"] = 0
        adm["cvc_site"] = ""

    # Arterial line: ~55% of ICU patients
    if random.random() < 0.55:
        site = weighted_choice(ARTERIAL_SITES)
        duration_days = round(max(0.5, random.lognormvariate(math.log(3), 0.5)), 1)
        duration_days = min(duration_days, adm["icu_los_days"])
        procedures.append({
            "procedure_id": procedure_id,
            "visit_detail_id": adm["visit_detail_id"],
            "person_id": adm["person_id"],
            "device_type": "Cathéter artériel",
            "device_site": site,
            "duration_days": duration_days,
        })
        procedure_id += 1
        adm["has_arterial_line"] = 1
        adm["arterial_line_site"] = site
    else:
        adm["has_arterial_line"] = 0
        adm["arterial_line_site"] = ""

    # Urinary catheter: ~75% of ICU patients
    if random.random() < 0.75:
        duration_days = round(max(0.5, random.lognormvariate(math.log(4), 0.5)), 1)
        duration_days = min(duration_days, adm["icu_los_days"])
        procedures.append({
            "procedure_id": procedure_id,
            "visit_detail_id": adm["visit_detail_id"],
            "person_id": adm["person_id"],
            "device_type": "Sonde urinaire",
            "device_site": "",
            "duration_days": duration_days,
        })
        procedure_id += 1
        adm["has_urinary_catheter"] = 1
        adm["urinary_catheter_days"] = duration_days
    else:
        adm["has_urinary_catheter"] = 0
        adm["urinary_catheter_days"] = ""

    # Chest drain: ~8%
    if random.random() < 0.08:
        duration_days = round(max(1, random.lognormvariate(math.log(3), 0.5)), 1)
        procedures.append({
            "procedure_id": procedure_id,
            "visit_detail_id": adm["visit_detail_id"],
            "person_id": adm["person_id"],
            "device_type": "Drain thoracique",
            "device_site": weighted_choice({"Droit": 0.55, "Gauche": 0.45}),
            "duration_days": duration_days,
        })
        procedure_id += 1
        adm["has_chest_drain"] = 1
    else:
        adm["has_chest_drain"] = 0

    # ECMO: ~3%
    if random.random() < 0.03:
        ecmo_type = weighted_choice(ECMO_TYPES)
        duration_days = round(max(2, random.lognormvariate(math.log(7), 0.5)), 1)
        procedures.append({
            "procedure_id": procedure_id,
            "visit_detail_id": adm["visit_detail_id"],
            "person_id": adm["person_id"],
            "device_type": "ECMO",
            "device_site": ecmo_type,
            "duration_days": duration_days,
        })
        procedure_id += 1
        adm["has_ecmo"] = 1
        adm["ecmo_type"] = ecmo_type
    else:
        adm["has_ecmo"] = 0
        adm["ecmo_type"] = ""

# --- Write CSVs ---

output_dir = "/Users/borisdelange/Documents/Mac/Programming projects/linkr-v2/apps/web/public/data/"

# 1. Admissions
adm_fields = [
    "person_id", "visit_occurrence_id", "visit_detail_id",
    "sex", "age", "admission_type", "origin_ward", "destination_ward", "discharge_disposition",
    "icu_admission_datetime", "icu_discharge_datetime", "hospital_admission_datetime",
    "icu_los_days", "hospital_to_icu_days",
    "saps2_score", "sofa_admission", "sofa_max",
    "deceased_in_icu", "deceased_in_hospital", "is_readmission_48h",
    "mechanical_ventilation", "mv_duration_hours", "tidal_volume_per_pbw", "pf_ratio_day1",
    "unplanned_extubation", "reintubation_48h", "tracheostomy",
    "renal_replacement_therapy", "rrt_type", "rrt_duration_days", "rrt_indication", "creatinine_max",
    "antibiotic_ddd", "nosocomial_infection",
    "has_cvc", "cvc_site", "has_arterial_line", "arterial_line_site",
    "has_urinary_catheter", "urinary_catheter_days",
    "has_chest_drain", "has_ecmo", "ecmo_type",
]

with open(output_dir + "icu_admissions.csv", "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=adm_fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(admissions)

# 2. Infections
inf_fields = [
    "infection_id", "visit_detail_id", "person_id",
    "infection_type", "pathogen", "is_mdro",
    "infection_onset_day", "adequate_empirical_abx",
]

with open(output_dir + "icu_infections.csv", "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=inf_fields)
    writer.writeheader()
    writer.writerows(infections)

# 3. Procedures
proc_fields = [
    "procedure_id", "visit_detail_id", "person_id",
    "device_type", "device_site", "duration_days",
]

with open(output_dir + "icu_procedures.csv", "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=proc_fields)
    writer.writeheader()
    writer.writerows(procedures)

# --- Summary stats ---
n_ventilated = sum(1 for a in admissions if a["mechanical_ventilation"])
n_rrt = sum(1 for a in admissions if a["renal_replacement_therapy"])
n_deceased_icu = sum(1 for a in admissions if a["deceased_in_icu"])
n_readmission = sum(1 for a in admissions if a["is_readmission_48h"])
n_nosocomial = sum(1 for a in admissions if a.get("nosocomial_infection"))

print(f"=== ICU Dashboard Data Generated ===")
print(f"Admissions:            {len(admissions)}")
print(f"Unique patients:       {len(set(a['person_id'] for a in admissions))}")
print(f"Ventilated:            {n_ventilated} ({100*n_ventilated/len(admissions):.1f}%)")
print(f"RRT:                   {n_rrt} ({100*n_rrt/len(admissions):.1f}%)")
print(f"Deceased in ICU:       {n_deceased_icu} ({100*n_deceased_icu/len(admissions):.1f}%)")
print(f"Readmissions 48h:      {n_readmission} ({100*n_readmission/len(admissions):.1f}%)")
print(f"Nosocomial infections: {n_nosocomial} ({100*n_nosocomial/len(admissions):.1f}%)")
print(f"Total infection episodes: {len(infections)}")
print(f"Total procedure records:  {len(procedures)}")
print(f"\nFiles written to: {output_dir}")
