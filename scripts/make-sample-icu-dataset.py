"""Generate the sample ICU dataset used to exercise the analysis plugins.

Deliberately NOT random noise: the relationships are planted (severity drives
outcome, a block of correlated biology, one control variable correlated with
nothing), so a reader can check that a plugin reports them rather than only
that it runs. See the README written beside the CSV for the expected findings.

    python3 scripts/make-sample-icu-dataset.py [OUTPUT.csv]

Seeded, so the same file comes out every time.
"""
import math, random, csv, sys, datetime as dt

rng = random.Random(20260824)
N = 400

SITES = ['CHU Rennes', 'CHU Nantes', 'CHU Angers', 'CHU Brest', 'CH Vannes', 'CH Le Mans']
SERVICES = ['Réanimation médicale', 'Réanimation chirurgicale', 'Réanimation polyvalente', 'USC', 'USI cardiologique']
DIAGNOSES = ['Sepsis', 'SDRA', 'Choc cardiogénique', 'Traumatisme', 'AVC', 'Intoxication', 'Post-opératoire']
COMMENTS = ['Sortie contre avis', 'Transfert externe', 'Réadmission < 48h']

def logistic(x): return 1 / (1 + math.exp(-x))

rows = []
base_date = dt.datetime(2025, 1, 6, 8, 0)

for i in range(1, N + 1):
    site = rng.choice(SITES)
    service = rng.choice(SERVICES)
    arm = rng.choice(['Standard', 'Intervention'])
    sex = rng.choice(['M', 'F'])

    age = max(18, min(95, round(rng.gauss(63, 16))))
    # weight correlates with sex, and mildly (negatively) with age
    weight = round(rng.gauss(82 if sex == 'M' else 68, 13) - (age - 63) * 0.12, 1)
    weight = max(38.0, weight)
    # height correlates strongly with weight -> a clear correlation-matrix signal
    height = round(rng.gauss(175 if sex == 'M' else 162, 7) + (weight - 75) * 0.18)
    bmi = round(weight / (height / 100) ** 2, 1)

    # SOFA rises with age and is the main driver of everything downstream
    sofa = round(max(0, min(24, rng.gauss(6 + (age - 63) * 0.05, 3))))
    # lactate tracks SOFA (planted correlation), log-normal-ish
    lactate = round(max(0.4, rng.lognormvariate(math.log(1.4 + sofa * 0.12), 0.45)), 1)
    # creatinine tracks SOFA too, so the matrix shows a block
    creatinine = round(max(30, rng.gauss(80 + sofa * 9, 28)))
    # a variable correlated with nothing, as a control
    noise_score = round(rng.uniform(0, 100), 1)

    ventilated = rng.random() < logistic(-2.2 + 0.28 * sofa)
    vasopressors = rng.random() < logistic(-2.6 + 0.30 * sofa)
    diagnosis = rng.choice(DIAGNOSES)

    # --- survival: hazard rises with SOFA and age, falls in the Intervention arm
    # Time to ICU death; the baseline is long enough that most patients are
    # still alive when follow-up ends, which is what makes censoring matter.
    log_hr = 0.16 * sofa + 0.022 * (age - 63) - 0.75 * (arm == 'Intervention') + 0.30 * ventilated
    scale = 95 * math.exp(-log_hr)
    true_time = rng.weibullvariate(scale, 1.35)
    # Discharge alive, or the 30-day study window closing — either way the
    # patient leaves without the event, and the curve must use their follow-up.
    admin_censor = min(30.0, rng.weibullvariate(14, 1.2))
    los = max(0.5, min(true_time, admin_censor))
    died = 1 if true_time <= admin_censor else 0

    admission = base_date + dt.timedelta(days=rng.randint(0, 330), hours=rng.randint(0, 23))
    discharge = admission + dt.timedelta(days=los)

    rows.append({
        'patient_id': f'P{i:04d}',
        'site': site,
        'service': service,
        'arm': arm,
        'sex': sex,
        'age': age,
        'height_cm': height,
        'weight_kg': weight,
        'bmi': bmi,
        'sofa_score': sofa,
        'lactate_mmol_l': lactate,
        'creatinine_umol_l': creatinine,
        'noise_score': noise_score,
        'ventilated': str(ventilated),
        'vasopressors': str(vasopressors),
        'primary_diagnosis': diagnosis,
        'los_days': round(los, 2),
        'death_icu': died,
        'admission_datetime': admission.isoformat(sep=' ', timespec='minutes'),
        'discharge_date': discharge.date().isoformat(),
        'comment': rng.choice(COMMENTS) if rng.random() < 0.30 else '',
    })

# Missingness, so the "Missing" rows and pairwise handling have something to do.
for r in rows:
    if rng.random() < 0.07: r['weight_kg'] = ''
    if rng.random() < 0.07: r['bmi'] = ''
    if rng.random() < 0.04: r['sofa_score'] = ''
    if rng.random() < 0.11: r['lactate_mmol_l'] = ''
    if rng.random() < 0.05: r['creatinine_umol_l'] = ''
    if rng.random() < 0.04: r['primary_diagnosis'] = ''

out_path = sys.argv[1] if len(sys.argv) > 1 else 'linkr-sample-icu.csv'
with open(out_path, 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)

# Report the planted signal so it can be checked against what the plugins show.
import statistics as st
def col(name, cast=float):
    return [cast(r[name]) for r in rows if r[name] != '']
print(out_path)
print('rows', len(rows), 'cols', len(rows[0]))
print('deaths', sum(r['death_icu'] for r in rows), '/', len(rows))
for a in ('Standard', 'Intervention'):
    sub = [r for r in rows if r['arm'] == a]
    print(f'  {a}: n={len(sub)} deaths={sum(r["death_icu"] for r in sub)} median LOS={st.median(r["los_days"] for r in sub):.1f}')
def corr(x, y):
    pairs = [(float(r[x]), float(r[y])) for r in rows if r[x] != '' and r[y] != '']
    xs = [p[0] for p in pairs]; ys = [p[1] for p in pairs]
    mx, my = st.mean(xs), st.mean(ys)
    num = sum((a-mx)*(b-my) for a, b in pairs)
    den = math.sqrt(sum((a-mx)**2 for a in xs) * sum((b-my)**2 for b in ys))
    return num/den
for pair in (('weight_kg','height_cm'), ('sofa_score','lactate_mmol_l'), ('sofa_score','creatinine_umol_l'), ('age','sofa_score'), ('noise_score','sofa_score')):
    print(f'  r({pair[0]}, {pair[1]}) = {corr(*pair):+.2f}')
