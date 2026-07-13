# Activité de réanimation

Un projet de démonstration synthétique montrant l'activité, la gravité et le
devenir en réanimation. Toutes les données sont fictives — aucun patient réel.

## Données

- **Séjours en réanimation** (`icu-stays.csv`, 220 lignes) — une ligne par
  séjour :
  - `person_id`, `age`, `sex`, `icu_unit`
  - `sofa_score` (gravité, 0–20), `los_days` (durée de séjour)
  - `mechanical_ventilation` (0/1), `deceased_in_icu` (0/1)
  - `admission_datetime`

L'âge, le score SOFA, la ventilation et la mortalité sont corrélés afin que les
graphiques et indicateurs présentent des gradients réalistes (les patients plus
âgés / à SOFA élevé ont une mortalité plus élevée).

## Tableau de bord — Activité de réanimation

- **Démographie** — patients uniques, mortalité en réanimation, distribution de
  l'âge par sexe, séjours par unité.
- **Gravité & devenir** — SOFA médian, taux de ventilation, distribution de la
  durée de séjour, mortalité par unité.

Filtres latéraux : sexe, unité de réanimation, tranche d'âge.

## Analyse (Lab › IDE)

- `mortality_analysis.py` — reproduit l'indicateur de mortalité et le détaille
  par bande de SOFA.
- `los_summary.r` — résumé de la durée de séjour et de la ventilation par unité.
