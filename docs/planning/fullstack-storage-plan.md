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

## 02 — Persistance serveur par entité (Tâche 4) **[FAIT]**

Chaque entité auparavant client-only (IndexedDB) a maintenant sa persistance serveur :
modèle SQLAlchemy + schémas Pydantic (camelCase) + service + routes CRUD workspace/project-
scopées + adaptateur front `lib/api/<entité>.ts` branché dans `createAPIStorage()`
(`api-storage.ts`). `isServerMode()` décide au niveau de la façade `getStorage()` ; les stores
Zustand sont inchangés. Migrations Alembic + tests d'intégration pytest pour chacune.

| Entité | Tables | Portée | Notes |
|---|---|---|---|
| Pipeline (DAG projet) | `pipelines` | project | **[FAIT]** |
| ETL pipelines | `etl_pipelines` + `etl_files` | workspace | contenu scripts inline **[FAIT]** |
| Cohorts | `cohorts` | project | criteria tree JSON ; caches result_count/attrition **[FAIT]** |
| Data quality | `dq_rule_sets` + `dq_custom_checks` | workspace | SQL inline, cascade **[FAIT]** |
| Data catalogs | `data_catalogs` | workspace | config/DCAT-AP JSON ; `catalog_results` = cache local **[FAIT]** |
| Concept sets | `concept_sets` | workspace | expression/resolvedIds JSON ; delete-batch **[FAIT]** |
| Source-concept IDs | `source_concept_id_ranges` (clé composite) + `_entries` | workspace | upsert + saveBatch **[FAIT]** |
| Mapping projects | `mapping_projects` + `concept_mappings` + `service_mappings` | workspace | CSV source dans blob store (`raw_file_sha`, lazy-load) ; createBatch/deleteOrphans **[FAIT]** |
| User plugins | `user_plugins` | workspace (nullable = global) | fichiers code inline **[FAIT]** |
| IDE connections | `ide_connections` | project | **secret Fernet** (password/token chiffré dans `connection_secret`, jamais renvoyé) **[FAIT]** |
| Schémas par défaut | (seed) | workspace | OMOP 5.4/5.3, MIMIC-IV/III seedés à la création d'un workspace (front) **[FAIT]** |

Déjà persistés avant cette tâche : workspaces, organizations, projects, data sources,
datasets, SQL scripts, wiki, schema presets, IDE files (autre session).

Requête serveur d'un mapping project *file* : `POST /mapping-projects/{id}/query` exécute le SQL
sur le CSV du blob via `db_connect.query_csv` (DuckDB `read_csv_auto`), en reconstruisant la vue
`source_concepts` (colonnes normalisées via columnMapping, miroir du montage WASM). **[FAIT]**

Perf mode serveur (concept-mapping) : buffer CSV **jamais** chargé dans le state React
(sortait le navigateur de l'archi §03 et provoquait un lag/timeout devtools) ; `mountFileSourceIntoDuckDB`
no-op en mode serveur ; cross-project overview parallélisé (`Promise.all`) + chargement des
lignes source différé aux onglets Table/Export. **[FAIT]**

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
  persistants) ; **terminal streaming = §07(d) [FAIT]**.

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

Le dossier `datasets/` est aussi surfacé **en lecture seule dans l'arbre de l'IDE** (à côté de
`scripts/`, flag `showInIde` dans `use-project-tree.ts`) : cliquer un fichier ouvre le
**visualiseur de dataset** (aperçu paginé, même rendu que la page Datasets), pas le JSON de
métadonnées ; pas de Download ni d'édition depuis l'IDE (la page Datasets reste le point
d'import/édition, source immuable). **[FAIT]**

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
  Route `/execute/kernels` existe (liste des kernels vivants) et le kernel est déjà keyé
  `(project_uid, language, env_id)` — l'isolation par environnement est donc *possible* côté
  backend. Reste : (1) l'UI footer (créer/basculer/restart + Ready/Busy/RSS) ; (2) attribuer un
  `env_id` distinct par terminal et/ou pour les scripts (aujourd'hui tout utilise `env_id="default"`,
  donc kernel partagé) — le modèle « un env par terminal » façon VS Code demandé par le PO ;
  (3) appliquer `session_timeout_minutes` / `max_sessions_per_user` (définis mais pas branchés).
- **(d) Terminal serveur = REPL interactif sur un kernel (streaming)** — **le plus complexe,
  en dernier**. **[FAIT]** WebSocket `/execute/terminal` : Python/R en streaming sur le kernel
  persistant (chunks stdout/stderr live + `done`), interruption Ctrl+C → SIGINT (le kernel survit),
  Bash = vrai PTY (`pty.openpty` + `bash -i`, pas de fork de l'interpréteur). Auth WS via `?token=`.
  Front : `TerminalSocket` + xterm, `isServerMode()` décide (WASM inchangé en front-only).
  **Reste (hors §07d, notés) :** Run du bouton éditeur toujours en batch (à passer en streaming +
  Stop réel + Ctrl+C) ; streaming R vrai temps réel (aujourd'hui bufferisé par `capture.output`,
  sortie émise en fin de run).

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


---

## État de session — 2026-07-08

### Fait cette session
- **Tâche 4 (stockage entités) : COMPLÈTE** — voir §02. Toutes les entités client-only sont persistées serveur (+ seed des schémas par défaut à la création d'un workspace).
- **Requête serveur du CSV d'un mapping project** (§02) — premier morceau de la Tâche 2/§03(b).
- **Perf concept-mapping en mode serveur** — buffer hors state, mount WASM no-op serveur, cross-project overview parallélisé + différé.
- **Divers UI** : schema browser unifié (SQL scripts / IDE / ETL) + modal large ; homogénéisation boutons ; raccourcis clavier (match sur `event.code`, new-file = Cmd/Ctrl+Alt+N) ; reset → « Clear local cache » + purge IndexedDB au 1er boot serveur ; panneau Connections (overflow, labels engine, bouton outline blanc-sur-blanc) ; bouton connecter DB serveur → `retestDataSource`.

### À FINIR (non résolu)
- **✅ Connexion d'une base externe en mode serveur — RÉGLÉ (2026-07-09).** La cause racine était un **double quoting du DSN** : le fix de sécurité `e860150c` enveloppait chaque valeur en `host="localhost"`, mais l'extension `postgres`/`mysql` de DuckDB ne comprend pas ce quoting (elle prend les guillemets comme des caractères littéraux du nom d'hôte → `could not translate host name`). `_dsn_value` utilise maintenant l'échappement backslash libpq (le seul que DuckDB honore). Les symptômes "base grise" + "404 detail not found" + `IO Error` en cascade en découlaient. Vérifié bout en bout sur la base mimic live (104 tables introspectées, requêtes SQL OK). Commit `797cffaa`.
- **✅ Tâche 2 / A — Moteur DuckDB serveur — LARGEMENT FAIT (2026-07-09).** L'audit des ~147 `queryDataSource` a montré que le routage `isServerMode()` était **déjà en place** dans `engine.ts` ; il restait : (1) les fuites WASM (téléchargement d'octets) en mode serveur, gardées par `isServerMode()` — commit `17f35d0a` ; (2) un **pool de connexions DuckDB par source** (extension chargée + ATTACH réutilisés) — le setup ~150 ms + handshake n'est plus payé qu'à la 1re requête (mesuré 9× sur mimic) — commit `aee55f2b` ; (3) un **cache Parquet matérialisé** de la liste de concepts (page/filtres/tri/détail lus depuis le Parquet local, refresh serveur atomique non bloquant, stats par concept en cache serveur partagé) — commits `1e7c3652` + `a8720492`.
- **Tâche 3 — Terminal serveur** (§07(d), streaming) — autre session. **[À FAIRE]**
- **✅ §07(c) — Environnements / sessions kernel — FAIT (2026-07-09).** Kernels keyés par **user** aussi `(project, user, lang, env)` — isolation des namespaces entre utilisateurs (`8334fe09`). Monitoring **RSS/PID/idle** exposé + affiché dans le footer StatusBar ; `session_timeout_minutes` (éviction des kernels inactifs) et `max_sessions_per_user` (plafond, aussi pour R/Python) désormais **appliqués** (`dad9e764`, `c2acc087`). **Sessions nommées** (namespaces, façon consoles RStudio) persistées côté serveur **par (projet, user)** — table `execution_sessions` + routes CRUD (`56e3fb41`) ; store + **dropdown Session** dans la toolbar IDE (créer/basculer/supprimer), câblé à `executeOnServer` + terminaux (`f129ffd9`). **Terminaux en onglets d'éditeur** (façon JupyterLab) avec bouton Bash/Python/R, panneau bas supprimé (`481d308b`). *Reste plus tard : de vrais venv/packages par environnement (aujourd'hui un env = un namespace, même interpréteur) ; env_id par onglet terminal individuel.*

### Coordination
Sessions parallèles sur `feature/fastapi-backend` (voir mémoire `parallel-session-git`). Les fichiers untracked `ide_files.py` / `schemas/ide_file.py` appartiennent à la session IDE — ne pas committer.
