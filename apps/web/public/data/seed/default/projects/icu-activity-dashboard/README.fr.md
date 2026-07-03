# Tableau de bord d'activité de réanimation

## Vue d'ensemble

Ce projet fournit un **tableau de bord de suivi de l'activité de réanimation** construit à partir de la base de démonstration MIMIC-IV (100 patients, format OMOP CDM). Il extrait des indicateurs cliniques clés à partir des données de routine du dossier patient informatisé et les présente sous forme d'un ensemble de visualisations interactives.

## Données

Le jeu de données est extrait du **MIMIC-IV Demo** transformé au format **OMOP CDM v5.4**. Le pipeline d'extraction :

1. **Identifie les séjours en réanimation** à partir de `visit_detail` + `care_site` (172 séjours répartis sur 7 unités de réanimation)
2. **Joint les données démographiques** (âge, sexe, origine ethnique) depuis `person`
3. **Extrait les mesures** (constantes vitales, biologie, paramètres de ventilation) depuis `measurement`
4. **Détecte les événements** : ventilation mécanique, infections, procédures depuis les tables cliniques OMOP
5. **Produit un CSV au format long typé** avec des lignes au niveau du séjour et au niveau de l'événement

## Domaines d'indicateurs

| Domaine | Indicateurs clés |
|---|---|
| **Démographie** | Distribution des âges, sex-ratio, taux de mortalité (réanimation / hôpital) |
| **Admissions et flux** | Chronologie des admissions, durée de séjour, répartition par unité de réanimation, réadmissions <48h |
| **Ventilation mécanique** | Taux de ventilation, durée, volume courant/PBW, PEEP, FiO2 |
| **Infections** | Types d'infection (sepsis, pneumonie, infection urinaire), distribution des pathogènes |
| **Procédures** | CVC, PICC, cathéters artériels, trachéotomie, extubation |

## Scripts

| Script | Description |
|---|---|
| `01_extract_icu_data.sql` | Requêtes SQL pour identifier les séjours en réanimation et extraire les données cliniques des tables OMOP |
| `02_build_dataset.py` | Pipeline Python pour construire le jeu de données analytique au format large |

## Chiffres clés (MIMIC-IV Demo)

- **172 séjours en réanimation** issus de **100 patients**
- **7 unités de réanimation** : MICU, SICU, CVICU, CCU, TSICU, MICU/SICU, Neuro SICU
- **43 % sous ventilation mécanique** (médiane 25,4h)
- **7,6 % de mortalité en réanimation**, 13,4 % de mortalité hospitalière
- **23 % de réadmissions** dans les 48h
