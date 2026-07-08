# Prompt — finir le backend full-stack de Linkr (moteur DuckDB serveur, terminal, stockage entités)

Copie tout ce qui suit dans une nouvelle session d'agent (contexte remis à zéro).

> **Périmètre : ce prompt NE couvre PAS l'IDE.** La migration de l'IDE vers des fichiers réels sur le file system (`projects/<uid>/scripts/` + `datasets/`, modèle `ide_files`, endpoints, kernel qui tourne dans le dossier du projet, suppression du bouton "show/hide protected data") est traitée **par une autre session en parallèle**. **Ne touche pas** à : `apps/web/src/stores/file-store.ts`, `apps/web/src/features/projects/FilesPage.tsx`, `apps/web/src/hooks/use-project-tree.ts`, `apps/web/src/features/projects/files/*`, ni aux fichiers backend `ide_file*` / au `cwd` des kernels (`execution/kernel.py`, `execution/runtime.py`). Si `npx tsc` remonte une erreur dans un de ces fichiers que tu n'as pas touché, c'est le travail de l'autre session — ignore-la, vérifie juste que TES fichiers sont clean.

---

Projet **Linkr** (monorepo React + FastAPI), repo `/Users/borisdelange/Documents/Mac/Programming projects/linkr`, branche `feature/fastapi-backend`. Plateforme de visualisation de données de santé (OMOP) avec **déploiement dual** : front-only WASM (statique) vs full-stack (backend Python). Le mode est basculé par `isServerMode()` (= présence de `VITE_API_URL`), défini dans `apps/web/src/lib/api-client.ts`.

## LIS D'ABORD

1. `docs/planning/fullstack-storage-plan.html` — le document d'architecture. Extrais le texte : `python3 -c "import re,html; t=open('docs/planning/fullstack-storage-plan.html').read(); t=re.sub(r'<(script|style).*?</\1>','',t,flags=re.S); print(html.unescape(re.sub(r'<[^>]+>','',t)))"`. Sections clés : **§02** (carte par entité), **§03** (compute serveur), **§04** (datasets), **§05** (dossier racine `data_dir`), **§08** (décisions à trancher).
2. `CLAUDE.md` (règles projet) + `docs/conventions.md` (conventions de code).
3. Ce prompt.

## Résumé de l'architecture (§03, acté)

**En mode serveur, tout le calcul touchant aux données patient tourne côté serveur ; les lignes brutes ne descendent (quasi) jamais dans le navigateur** — le navigateur envoie du SQL / du code / des specs et reçoit des résultats agrégés. Nuance donnée par le product owner : **la règle n'est pas absolue** — le poste client est sécurisé (CHU, utilisateurs authentifiés), on peut faire descendre *un peu* de données (points d'un nuage, valeurs d'une colonne pour un box-plot) quand c'est le rendu naturel ; mais on garde les agrégats petits quand un agrégat suffit (counts, bins, stats). **`isServerMode()` décide, jamais la nature de la donnée.** Le mode front-only WASM (Pyodide/WebR/DuckDB-WASM) est conservé et ne doit pas être cassé.

## Ce qui est DÉJÀ FAIT (ne pas refaire)

- **Stockage blobs** : `apps/api/app/services/blob_store.py` — content-addressed sous `data_dir/_files/<sha256>`, dédup par hash. Config : `apps/api/app/config.py` → `settings.data_dir` (défaut `~/.linkr`, env `LINKR_DATA_DIR`), `settings.data_path` (Path résolu). DB SQLite/Postgres dans `data_dir/linkr.db`.
- **Datasets serveur** : lignes en **Parquet** (`apps/api/app/services/data/dataset_rows.py`), pagination/tri/filtres/stats serveur. Modèle `DatasetFile` (`apps/api/app/models/dataset.py`), pointeurs `data_sha` (Parquet parsé) + `raw_sha` (fichier original), tous deux dans `_files/<sha>` flat.
- **Exécution R/Python serveur** : `apps/api/app/services/execution/runtime.py` (one-shot) + `kernel.py` (**kernels persistants** par `(projectUid, langage, envId)`, variables qui persistent). Route `POST /api/v1/execute` (+ `/execute/restart`, `/execute/kernels`). Contrat de sortie `RuntimeOutput { stdout, stderr, figures[], table, html }` (identique au moteur WASM navigateur, `apps/web/src/lib/runtimes/types.ts`). Front : `executeOnServer(language, code, opts)` dans `apps/web/src/lib/api/execution.ts`.
- **Injection dataset** : `apps/api/app/services/execution/injection.py` — préambule qui charge le Parquet du dataset comme variable `dataset` (colonnes renommées id→nom, typées), Python (pandas/pyarrow) + R (arrow), avec filtres dashboard.
- **`sql_query()`** dans les kernels → route vers `data_source_service.query` (**Postgres OK ; autres moteurs = erreur claire**).
- **Les 8 composants viz built-in migrés serveur** (Table1, KeyIndicator, PlotBuilder, CorrelationMatrix, StatisticalTests, Regression, KaplanMeier, Sankey, Map) — chacun a un `<x>-server.ts` (génère du Python pandas/scipy/statsmodels/lifelines) branché par `isServerMode()`. Libs stat dans `pyproject.toml` groupe `[project.optional-dependencies] execution` + `docker/Dockerfile.api`. **Ne pas y retoucher.**
- **IDE fichiers réels** : en cours dans une autre session (voir encadré en haut). **Ne pas y toucher.**

---

## TÂCHE A (prioritaire) — Moteur DuckDB serveur (§03 étape b) — le plus gros reste

Aujourd'hui, seul Postgres passe côté serveur (`sql_query()` → `data_source_service.query`). Le plan demande **une API de requêtes serveur qui remplace `queryDataSource` et `computeStats`** : le navigateur envoie du SQL / une spec, le serveur exécute (DuckDB sur les Parquet + bases importées) et renvoie **des lignes de résultat**, jamais les tables brutes.

### Étapes

1. **Recense les appels** : `grep -rn "queryDataSource\|computeStats" apps/web/src` — cartographie les sites (warehouse concepts/cohorts/patient-data, datasets, dashboards, data-quality, catalogs). Compte-les et regroupe-les par feature. **Rends ce recensement au product owner avant de coder** (il t'aidera à prioriser les surfaces).
2. **Trouve `queryDataSource`** (probablement `apps/web/src/lib/…`) et son équivalent WASM (DuckDB-WASM). Regarde comment `sql_query()` route déjà côté serveur (`apps/api/app/services/data/data_source_service.py`) et comment DuckDB est initialisé côté serveur (`apps/api/app/services/data/db_connect.py` — gère déjà les extensions DuckDB sous `data_dir`).
3. **Endpoint(s) serveur DuckDB** : une route `POST /api/v1/query` (ou étends l'existant) qui exécute du SQL DuckDB read-only et renvoie des lignes. Doit interroger :
   - les **Parquet des datasets** (`_files/<data_sha>`),
   - les **bases importées** (`data_sources`, vocabulaires OHDSI dédupliqués sous `_files/`),
   - et **router vers Postgres/autres moteurs** quand la source est une vraie base (réutilise `data_source_service`).
4. **Côté front** : `queryDataSource` route vers l'API en mode serveur, garde DuckDB-WASM en front-only. **`isServerMode()` décide.** Même contrat de retour (lignes) dans les deux modes pour ne rien casser en aval.
5. **`computeStats`** (stats par colonne) passe aussi serveur → agrégats DuckDB sur le Parquet (le plan §04 le liste explicitement).
6. **Incrémental** : l'app doit rester utilisable à chaque étape. Commence par un moteur read-only sur Parquet (datasets + warehouse), fais valider une surface, puis élargis aux autres. **Propose ton découpage en sous-lots et fais-le valider avant de tout brancher.**

### Pièges Tâche A
- **Ne casse pas le front-only** : les ~142 sites doivent continuer à marcher en DuckDB-WASM quand `!isServerMode()`.
- **SQL injection / read-only** : le SQL généré côté front est déjà paramétré, mais côté serveur exécute en read-only (pas de write sur les sources).
- **Perf** : réutilise une connexion DuckDB serveur (ne pas rouvrir à chaque requête) ; attention aux gros résultats (paginer / plafonner comme le fait déjà le mode WASM).
- **Coordination** : une session a récemment touché **SQL scripts / data sources / warehouse** — regarde l'état de `data_source_service.py` et `sql_script_service.py` avant, et `git add` UNIQUEMENT tes fichiers.

---

## TÂCHE B — Terminal serveur (§07 étape d)

REPL interactif en streaming sur un kernel persistant (le point "le plus complexe, en dernier" du plan). Le composant front existe (`apps/web/src/features/projects/files/TerminalPane.tsx`) — **MAIS il est sous `files/`, dossier de l'IDE que l'autre session touche.** Coordonne-toi : ne modifie `TerminalPane.tsx` qu'après accord, ou concentre-toi sur le **backend** (canal streaming WebSocket/SSE vers un kernel vivant, réutilisant `execution/kernel.py`) et laisse le branchement front à la fin. **À faire APRÈS la Tâche A.**

---

## TÂCHE C — Couverture stockage des entités restantes (§02 / §08)

Le §02 du plan cartographie **toutes** les entités (pipelines, cohorts, ETL, wiki, plugins, mappings, concept sets, catalogs, DQ rule sets, schema presets…) avec base=métadonnées / fichiers=contenu lourd. 

1. **Audit** : pour chaque entité du §02, vérifie ce qui existe déjà côté serveur (`apps/api/app/models/` + `apps/api/app/services/` + routes dans `main.py`) vs encore client-only (IndexedDB). Rends un tableau au product owner : entité → statut (fait / partiel / client-only) → ce qui manque.
2. **Implémente les manquantes** par ordre d'importance (à valider avec le product owner). Patron : métadonnées en base (modèle + migration Alembic + service + routes CRUD kebab-case), contenu lourd/binaire en fichiers/blobs. Regarde les entités **déjà faites** comme patron (`sql_script`, `dataset`, `data_source`, `wiki_page`, `schema_preset`).
3. **Décisions §08 à respecter** :
   - **① Fichiers = source de vérité ou export ?** → reco **A** : la **base est l'unique source de vérité des métadonnées** ; les fichiers ne stockent que les blobs ; l'arbo git complète est régénérée à la demande via l'export existant (`apps/web/src/lib/entity-io.ts`). Pas de double écriture à synchroniser.
   - **Caches** (`*_stats_cache`, `catalog_results`, scores) → **ne PAS les mettre en base**, recalcul serveur à la demande (volumineux, dérivés).
   - **Dossier racine** → reste `LINKR_DATA_DIR` fixé côté serveur (lecture seule dans le wizard).

---

## Règles projet (obligatoires — CLAUDE.md + docs/conventions.md)

- **i18n** : tout texte via `t('key')`, clés dans `apps/web/src/locales/en.json` ET `fr.json`.
- **Path alias** `@/` pour les imports depuis `src/`.
- **Pas de commentaires descriptifs** : seulement le WHY non-évident.
- **Tests suivent le code** : logique pure/critique → test. Backend `cd apps/api && .venv/bin/python -m pytest` (doit rester vert). Front `cd apps/web && npx tsc -b --force` + `npx eslint <fichiers touchés>`.
- **Commits par lot** (PAS à chaque petit fix), messages en anglais, format `Scope: description`. Avant de committer, `git add` UNIQUEMENT tes fichiers (jamais `git add -A`).
- **Ne PAS `git commit --amend`** ni rebaser (sessions parallèles sur la branche).
- **Alembic** : chaque nouvelle table → génère UNE migration (`alembic revision --autogenerate -m "…"`), **vérifie-la à la main**, `alembic upgrade head`.

## Méthode

- Commence par **relire `fullstack-storage-plan.html` §02–§08**, puis **explore le code réel** avant d'écrire du code : `data_source_service.py`, `db_connect.py`, `queryDataSource`/`computeStats` côté front, les modèles/services existants.
- **Propose ton plan de la Tâche A (moteur DuckDB serveur) + le recensement des ~142 appels, et fais-le valider AVANT de coder.** C'est la priorité.
- Vérifie à chaque étape : le mode front-only WASM ne doit jamais casser (`isServerMode()` branche les deux chemins).
- Fais tester le product owner en mode serveur après chaque brique (il veut voir les résultats avant les commits).
- **Ne touche pas à l'IDE** (voir encadré en haut) — une autre session s'en occupe.
