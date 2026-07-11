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
  et `computeStats` ; le navigateur reçoit des lignes de résultat. **[LARGEMENT FAIT — 2026-07-09]**
  (routage `isServerMode()` dans `engine.ts`, pool de connexions, cache Parquet matérialisé ;
  voir l'état de session 2026-07-09. Reste : quelques fuites WASM mineures, voir 2026-07-10.)
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
- **(c) Multi-environnements + sessions + monitoring.** **[FAIT]** Kernels keyés
  `(project_uid, user_id, language, env_id)` ; footer StatusBar (Ready/Busy/RSS/PID/restart) ;
  dropdown Session (créer/basculer/supprimer) ; `session_timeout_minutes` (éviction idle) +
  `max_sessions_per_user` appliqués. **Reste :** de vrais venv/packages par env (aujourd'hui
  un env = un namespace, même interpréteur) ; un `env_id` distinct par onglet terminal.
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
- **Caches** → recalculables ; ceux partageables à l'échelle projet/workspace (database-stats,
  catalog-results) vivent dans un **cache serveur partagé** (`stats_cache`), invalidé par un bouton
  reset. (Décision affinée depuis — voir « État actuel ».)
- **Dossier racine** → `LINKR_DATA_DIR` fixé côté serveur (lecture seule dans le wizard).


---

## État actuel (MàJ 2026-07-11)

La transition full-stack est fonctionnelle et déployable (Docker validé bout en bout,
v2.1.0). Détail par brique dans les sections §01–§08 ci-dessus (annotations `[FAIT]`).

### Fait
- **Stockage entités serveur (§02)** : toutes les entités client-only sont persistées serveur
  (métadonnées en base, contenu lourd en blobs), dashboards inclus. Schémas + plugins built-in
  seedés à la création d'un workspace.
- **Moteur DuckDB serveur (§03b)** : `queryDataSource`/`computeStats` routés serveur en mode
  full-stack (read-only + écriture sur Parquet uniquement — pas de fichier DuckDB partagé) ;
  bases externes attachées en `READ_ONLY` ; pool de connexions ; cache Parquet matérialisé.
- **Datasets (§04)**, **R/Python serveur (§06)**, **kernels + sessions + terminal streaming (§07)**.
- **Zéro runtime WASM en mode serveur** : audit exhaustif — Pyodide/WebR/DuckDB-WASM ne sont
  chargés par aucun chemin en full-stack (concept-mapping scores, RmdNotebook, plugins warehouse
  patient-data, testeur de plugins : tous routés serveur). Vérifié au niveau bundle.
- **Zéro IndexedDB en mode serveur** : stores API-backed ou no-op ; IDB jamais ouverte en
  full-stack. Caches partageables (`databaseStatsCache`, `catalogResults`) portés vers une table
  serveur partagée `stats_cache` (reset = invalidation globale). IDB conservée pour le front-only.
- **Client léger** : bundle initial ~1,9 MB → ~0,66 MB gzip (lazy-load par route + composants viz
  + vis-network à la demande).

### Décisions produit actées
- **Compute = le mode décide, jamais la nature de la donnée** (§03). Full-stack = tout serveur ;
  front-only WASM conservé (portal statique, démos MIMIC) — ne jamais casser.
- **Base = source de vérité des métadonnées ; fichiers = blobs** (§08). Exception : `scripts/` et
  `datasets/` → le disque est la source unique (façon RStudio/Jupyter).
- **Caches recalculables** : cache **serveur partagé** quand c'est partageable à l'échelle
  projet/workspace + bouton reset ; sinon recalcul. (Remplace la note §08 « caches pas en base ».)
- **IndexedDB conservée** (front-only en dépend, pas un problème de compat) — jamais ouverte en
  mode serveur.
- **Modèle de droits** : le catalogue ressources×actions reste **à valider de bout en bout par le
  PO** (voir `users-authorizations-audit.md`).

### Backlog (non ordonnancé — PO)
- **Import par lien git** : vérifier l'upload depuis un lien git (champ de chaque modal Import).
- **Versioning projets & workspaces** : page Versioning connectée à un git.
- **IDE — environnements** : venv/packages par env, un env par terminal (cf. §07c « reste »).
- **IDE — gestion de jobs** : suivi/interruption de longs processus (± file de jobs).
- **Multi-user — édition concurrente** : prévenir si un contenu a été modifié entre-temps
  (détection de conflit / version).
- **Perf multi-user** : pas de blocage logique (kernels isolés, async), mais contention CPU/RAM
  possible sur jobs longs — prévoir file de jobs + limites de concurrence. uvicorn tourne en
  1 worker.
- **Pipeline** : le rendre réellement fonctionnel.
- **Page Reports** : à implémenter.
- **Finitions** : Run du bouton éditeur en streaming (+ Stop/Ctrl+C) ; streaming R vrai temps réel
  (aujourd'hui bufferisé) ; gating UI inline edit/delete sur les pages détail (backend déjà en 403).
