# Codes de test — widgets Python & SQL (mode full-stack)

Snippets pour tester le rendu des widgets custom **Python** et **SQL** en mode serveur,
dans le même esprit que le widget R (dataset `table_agregee` de neoclip).

Rappels sur l'exécution serveur (kernel persistant) :
- Le dataset du widget est injecté comme variable `dataset` :
  - **Python** → un `pandas.DataFrame`, colonnes renommées vers leurs noms d'affichage.
  - Les figures **matplotlib** sont récupérées automatiquement (SVG, taille auto — pas de souci de dimensions comme en R).
  - Une variable `result` (DataFrame) devient le **tableau** du widget.
- **SQL** : `sql_query()` interroge la **connexion base de données active** (tables OMOP : `person`, `visit_occurrence`, …), PAS le dataset du widget. Il faut donc une connexion DB active sur le projet.
  - ⚠️ Différence client/serveur : côté serveur `df = sql_query("...")` (synchrone) ; côté client WASM `df = await sql_query("...")`. Les snippets ci-dessous détectent le mode.

---

## 1. Widget Python — figure matplotlib (durée de séjour par unité)

Colonnes attendues : `hospit_unit`, `hospit_los_days`.

```python
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# Durée médiane de séjour par unité
med = (dataset
       .assign(hospit_los_days=lambda d: d["hospit_los_days"].astype(float))
       .groupby("hospit_unit")["hospit_los_days"]
       .median()
       .sort_values())

fig, ax = plt.subplots(figsize=(9, 6))
ax.barh(med.index.astype(str), med.values, color="#4B6FAA")
ax.set_xlabel("Durée médiane de séjour (jours)")
ax.set_title("Durée médiane de séjour par unité", fontweight="bold")
fig.tight_layout()
```

## 2. Widget Python — tableau récapitulatif (variable `result`)

```python
# Un DataFrame nommé `result` est affiché comme tableau du widget.
result = (dataset
          .assign(hospit_los_days=lambda d: d["hospit_los_days"].astype(float))
          .groupby("hospit_unit")["hospit_los_days"]
          .agg(n="count", mediane="median", moyenne="mean")
          .round(2)
          .reset_index()
          .rename(columns={"hospit_unit": "Unité"}))
print("Unités :", dataset["hospit_unit"].nunique(), "| n =", len(dataset))
```

## 3. Widget Python — histogramme (âge gestationnel)

Colonne attendue : `ga_weeks`.

```python
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

ga = pd.to_numeric(dataset["ga_weeks"], errors="coerce").dropna()
fig, ax = plt.subplots(figsize=(9, 6))
ax.hist(ga, bins=20, color="#88BF9C", edgecolor="white")
ax.set_xlabel("Âge gestationnel (SA)")
ax.set_ylabel("Nombre de patients")
ax.set_title("Distribution de l'âge gestationnel", fontweight="bold")
fig.tight_layout()
```

---

## 4. Widget SQL — nécessite une connexion base de données active (OMOP)

`sql_query()` interroge la connexion active, pas le dataset. Écrit pour le **mode serveur**
(synchrone) avec repli automatique sur le mode client (asynchrone).

```python
import inspect

_q = sql_query("""
    SELECT gender_concept_id, COUNT(*) AS n
    FROM person
    GROUP BY gender_concept_id
    ORDER BY n DESC
""")
# Serveur: sql_query est synchrone ; client WASM: coroutine à await.
df = await _q if inspect.iscoroutine(_q) else _q

result = df  # affiché comme tableau du widget
print(df)
```

### Variante SQL + figure

```python
import inspect
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

_q = sql_query("""
    SELECT CAST(strftime('%Y', visit_start_date) AS INT) AS annee, COUNT(*) AS n
    FROM visit_occurrence
    GROUP BY 1 ORDER BY 1
""")
df = await _q if inspect.iscoroutine(_q) else _q

fig, ax = plt.subplots(figsize=(9, 6))
ax.bar(df["annee"].astype(str), df["n"], color="#4B6FAA")
ax.set_title("Nombre de visites par année", fontweight="bold")
ax.set_xlabel("Année"); ax.set_ylabel("Visites")
fig.tight_layout()
```

> Adapte les noms de tables/colonnes à ta connexion OMOP. Sans connexion active,
> `sql_query()` renvoie l'erreur « No active database connection ».
