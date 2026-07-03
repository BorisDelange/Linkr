# Prédiction précoce de la mortalité hospitalière en réanimation à partir des données des 24 premières heures

## Contexte

La prédiction de la mortalité en unité de soins intensifs (réanimation) est centrale pour la décision clinique, l'allocation des ressources et l'évaluation comparative de la qualité des soins. Les scores de gravité établis — APACHE II, SAPS II, SOFA — ont été largement adoptés mais présentent des limites bien connues : ils ont été développés sur des cohortes historiques, reposent sur des ensembles de variables fixes et utilisent des schémas de pondération prédéfinis qui ne s'adaptent pas au case-mix local. Plusieurs études ont montré que des modèles de régression logistique et d'apprentissage automatique entraînés sur des données de dossier patient informatisé (EHR) collectées en routine peuvent égaler ou surpasser ces scores traditionnels.

Ce projet examine si des modèles prédictifs ajustés sur des variables disponibles au cours des **24 premières heures** suivant l'admission en réanimation peuvent discriminer efficacement les survivants des non-survivants — en utilisant uniquement des données au format OMOP Common Data Model.

## Objectif

Développer et évaluer des modèles prédictifs de la **mortalité hospitalière** chez les patients de réanimation, à partir des données démographiques et des mesures physiologiques recueillies au cours des 24 premières heures de séjour (H0–H24).

## Données

Le jeu de données est le **MIMIC-IV demo** (version 2.2), un sous-ensemble librement accessible de la base clinique MIMIC-IV, transformé au format **OMOP CDM v5.4**. Il contient 100 patients uniques ayant séjourné en réanimation au Beth Israel Deaconess Medical Center (Boston, États-Unis).

Après application des critères d'inclusion (séjour hospitalier $\geq$ 24 h, au moins une mesure en H0–H24), la cohorte finale comprend **242 séjours en réanimation** issus de 100 patients, avec **13 décès** (taux de mortalité de 5,4 %).

## Scripts

Le projet contient deux **notebooks d'étude autonomes** et trois **scripts d'exemple** (un par type de fichier).

### 1. Analyse exploratoire des données (`01_eda_mortality.ipynb`)

Notebook Jupyter **autonome** réalisant l'ensemble du pipeline d'EDA :

- Exploration des concepts OMOP (domaines, vocabulaires, mesures disponibles)
- Extraction de la cohorte via SQL (séjours éligibles $\geq$ 24h, indicateur de mortalité, données démographiques)
- Ingénierie des variables (mesures H0–H24 : moyenne/min/max des constantes vitales, première valeur des examens biologiques, GCS le plus défavorable)
- Export d'un jeu de données au format large (une ligne par séjour, ~45 variables)
- Vue d'ensemble de la cohorte : données démographiques, distributions âge/sexe, chronologie des admissions
- Distributions des variables selon le devenir (constantes vitales, biologie, GCS)
- Analyse des données manquantes et de leurs schémas selon le devenir
- Matrice de corrélation et détection de la multicolinéarité
- Table 1 avec statistiques descriptives
- Associations univariées (corrélation point-bisériale)
- Détection des valeurs aberrantes avec plages de plausibilité clinique

### 2. Pipeline d'apprentissage automatique (`02_ml_mortality.qmd`)

Rapport Quarto R **autonome** avec pipeline de ML complet :

- Extraction de la cohorte et ingénierie des variables (identiques au notebook 1)
- Préparation des données : sélection des variables, imputation par la médiane
- Séparation apprentissage/test (75/25 stratifiée)
- Régression logistique (modèle de référence) avec odds ratios
- Arbre de décision (rpart)
- Comparaison des modèles : courbes ROC, matrice de confusion
- Analyse de calibration
- Importance des variables (coefficients standardisés + importance de l'arbre)
- Analyse du seuil (compromis sensibilité/spécificité/F1)

### 3–5. Scripts d'exemple

Exemples autonomes illustrant chaque type de fichier (chacun peut être exécuté indépendamment) :

| Script | Langage | Description |
|---|---|---|
| `03_example.sql` | SQL | Extraction de la cohorte à partir des tables OMOP CDM |
| `04_example.py` | Python | Cohorte + ingénierie des variables + export CSV (`sql_query()` + pandas) |
| `05_example.R` | R | Cohorte + ingénierie des variables + statistiques + régression logistique (`sql_query()`) |

## Variables extraites

| Catégorie | Variables | Agrégation |
|---|---|---|
| **Constantes vitales** (7) | Fréquence cardiaque, PAS, PAD, PAM, fréquence respiratoire, SpO$_2$, température | Moyenne, min, max |
| **Biologie** (15) | Hémoglobine, hématocrite, plaquettes, GB, Na, K, Cl, HCO$_3$, créatinine, urée, glycémie, trou anionique, Ca, Mg, phosphate | Première valeur |
| **Neurologie** (3) | GCS ouverture des yeux, réponse verbale, réponse motrice | Minimum |

Les données OMOP au format long sont pivotées en un **jeu de données large à une ligne par séjour** (242 lignes $\times$ ~45 colonnes).

## Limites

- **Effectif réduit** : 100 patients / 13 décès limitent la puissance statistique et la généralisabilité
- **Jeu de données de démonstration** : MIMIC-IV demo est un échantillon de commodité
- **Données monocentriques** : Beth Israel Deaconess Medical Center uniquement
- **H0–H24 seulement** : pas de modélisation de séries temporelles, pas de variables au-delà de 24h
- **Imputation par la médiane** : approche simple, sans imputation multiple
- **Absence de validation externe** : monocentrique, sans découpage temporel

## Références

1. Johnson, A. et al. *MIMIC-IV, a freely accessible electronic health record dataset.* Sci Data 10, 1 (2023).
2. Knaus, W.A. et al. *APACHE II: a severity of disease classification system.* Crit Care Med 13, 818–829 (1985).
3. Le Gall, J.R. et al. *A new Simplified Acute Physiology Score (SAPS II).* JAMA 270, 2957–2963 (1993).
