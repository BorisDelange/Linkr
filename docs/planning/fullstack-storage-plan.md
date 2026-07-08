# Linkr full-stack — plan de stockage & de calcul (base / fichiers / serveur)

> Version Markdown du document de décision (l'original `fullstack-storage-plan.html`
> reste la source historique). Des annotations **[FAIT]** / **[EN COURS]** / **[À FAIRE]**
> indiquent l'état d'avancement au moment de la rédaction.

Règle générale : **métadonnées légères en base**, **contenu lourd/binaire en fichiers**
sous un dossier racine unique (`data_dir`), calqué sur `linkr-portal/`. Le calcul touchant
aux données vit **côté serveur** en mode full-stack, **dans le navigateur** en mode front-only.

---

## 01 — Le principe de partage base / fichiers

L'export ZIP fait déjà cette séparation (un `_tree.json` de métadonnées + les fichiers de
contenu à leur chemin). Le backend full-stack reproduit ce layout sur disque et indexe les
métadonnées en base.

**En base (SQLite / Postgres)** : identité & relations (id, workspaceId, projectUid, FK,
cascades) ; métadonnées (noms multilingues, description, config, status, badges, timestamps,
auteur) ; arbres de fichiers sans contenu ; concept mappings ; structure dashboards ; registres.

**En fichiers (`data_dir`)** : code & scripts (IDE, ETL, SQL, code inline widgets, plugins) ;
données (CSV/Parquet des datasets, source brut des mappings, blobs Parquet) ; bases importées
(vocabulaires OHDSI, dédupliqués par hash) ; markdown (README, wiki) ; pièces jointes binaires.

**Recalculable** : caches (`*_stats_cache`, `catalog_results`, scores) — peut ne pas être
persisté ; recalcul à la demande.

---

## 03 — Où tourne le calcul : décision d'architecture (ACTÉE)

Deux modes de déploiement, deux endroits pour le calcul — **le mode seul décide, jamais la
nature de la donnée**. Le drapeau `isServerMode()` (présence de `VITE_API_URL`) tranche.

- **Full-stack (CHU) — compute 100 % serveur** : DuckDB, R et Python s'exécutent sur le
  serveur ; le WASM n'est pas chargé. Le navigateur envoie du SQL / des specs et ne reçoit que
  des résultats agrégés. Motivé par (1) postes peu puissants, (2) données patient à ne pas
  exposer sur le poste.
- **Front-only (WASM) — conservé** : déploiement statique (GitLab Pages, portal), démos,
  données publiques (MIMIC). Compute dans le navigateur (DuckDB-WASM / Pyodide / WebR). Ne
  doit **jamais** être cassé.

Pas de classification de sensibilité. Frontière technique : tout ce qui lit les tables
s'exécute au serveur ; le navigateur réaffiche/re-trie des résultats déjà reçus.

*Nuance produit ultérieure : la règle "aucune donnée dans le navigateur" n'est pas absolue —
poste sécurisé, on peut descendre un peu de données quand c'est le rendu naturel (points d'un
nuage), mais on garde les agrégats petits quand un agrégat suffit.*

**Séquençage** (l'app reste utilisable à chaque étape) :
- **(a) Stockage** — métadonnées en base, blobs (lignes de dataset en Parquet) sur disque. **[FAIT]**
- **(b) Moteur DuckDB serveur** — une API de requêtes remplace `queryDataSource` (~142 appels)
  et `computeStats` ; le navigateur reçoit des lignes de résultat. **[À FAIRE — plus gros reste]**
- **(c) R / Python serveur** — exécution par session (voir §06/§07). **[FAIT]** (kernels
  persistants) ; **terminal streaming = §07(d) [À FAIRE]**.

---

## 04 — Datasets en full-stack **[FAIT]**

Cible atteinte : lignes en **Parquet** sur le serveur (colonnaire, interrogeable DuckDB) ;
tableau paginé `LIMIT/OFFSET` serveur ; tri/filtres `ORDER BY / WHERE` serveur ; stats par
colonne = agrégats DuckDB ; analyses = code exécuté serveur, seul le résultat revient ;
datasets importés **en lecture seule** (source immuable, transformation via pipeline).

Implémentation retenue (disque source de vérité) : `projects/<uid>/datasets/` contient les
fichiers **bruts** (source unique, scannés depuis le disque) ; un **cache Parquet dérivé** vit
sous `projects/<uid>/.cache/datasets/` pour la pagination/stats/injection. Les analyses sont
re-keyées par `(project_uid, dataset_path)` avec réconciliation des orphelines au scan.

---

## 05 — Le dossier racine `data_dir`

Un seul dossier configurable (`LINKR_DATA_DIR`, défaut `~/.linkr`) contient tout :

```
data_dir/
├─ linkr.db                    # base : métadonnées + relations (ou Postgres externe)
├─ _files/<sha256>             # blobs partagés dédupliqués par hash (Parquet, uploads)
└─ projects/<project-uid>/     # [FAIT] arbre de travail réel par projet (façon RStudio/Jupyter)
   ├─ scripts/                 #   fichiers IDE réels (noms lisibles) — disque = source unique
   ├─ datasets/                #   datasets bruts — disque = source unique
   └─ .cache/datasets/         #   cache Parquet dérivé (jamais montré dans l'arbre)
```

Le kernel d'un projet tourne avec `projects/<uid>/` comme **répertoire de travail**, donc le
code lit `scripts/…` et `datasets/…` par chemins relatifs.

---

## 06 — Exécuter R et Python côté serveur **[FAIT]**

- `docker/Dockerfile.api` installe `r-base` → `Rscript` dispo. Python = interpréteur backend.
- `app/services/execution/` : `runtime.py` (one-shot) + `kernel.py` (kernels persistants).
- Injection des données par le serveur (`injection.py`) : le Parquet est chargé comme variable
  `dataset` (pandas/pyarrow côté Python, arrow côté R) — plus de `JSON.stringify` des lignes.
- Retour : `RuntimeOutput` (table, figures encodées, stdout/stderr) — même contrat que le
  moteur WASM navigateur.
- Isolation : process séparé, timeout, cwd = dossier projet.

---

## 07 — Environnements & sessions kernel (IDE)

Un IDE attend une **session vivante** où les variables s'accumulent entre les runs (modèle
kernel Jupyter / console RStudio). Deux sens d'« environnement » : (1) paquets installés
(pip/CRAN) ; (2) état des variables (mémoire d'un process vivant).

- **(a) Kernel Python persistant par projet** — variables persistent. **[FAIT]**
- **(b) Kernel R persistant.** **[FAIT]**
- **(c) Multi-environnements + UI footer** (créer/lister/basculer/restart, monitoring). **[PARTIEL]**
  Route `/execute/kernels` existe (liste des kernels vivants) ; UI footer à compléter.
- **(d) Terminal serveur = REPL interactif sur un kernel (streaming)** — **le plus complexe,
  en dernier**. **[À FAIRE — PRIORITÉ de la prochaine session]**

Kernels persistants en mémoire (acté) : un process R/Python vivant par environnement, gardé en
RAM côté serveur. Variables perdues au redémarrage serveur ou à l'expiration d'inactivité
(`session_timeout_minutes`), plafond `max_sessions_per_user`. « Restart kernel » = tuer +
relancer. Le footer reflète l'état : Ready / Busy / Memory (RSS).

Mapping : par défaut 1 kernel Python + 1 kernel R par projet ; possibilité d'en créer d'autres.
Un environnement = `{ langage, id, projet, paquets installés, process vivant }`.

---

## 08 — Décisions tranchées

- **Fichiers = source de vérité ou export ?** → **Base = vérité des métadonnées ; fichiers =
  blobs**. Exception actée depuis : pour `scripts/` et `datasets/`, **le disque EST la source
  unique** (scan disque, pas de table miroir de contenu), façon RStudio/Jupyter.
- **Caches** (`*_stats_cache`, `catalog_results`, scores) → pas en base, recalcul serveur.
- **Dossier racine** → `LINKR_DATA_DIR` fixé côté serveur (lecture seule dans le wizard).
