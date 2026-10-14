# Tâches lourdes en jobs serveur

**Problème.** Dans une SPE, une passerelle (nginx, délai par défaut 60 s) se tient entre le
navigateur et Linkr. Toute requête HTTP plus longue reçoit un 504 alors que le serveur
continue, et le résultat est perdu. Découper en requêtes courtes ne suffit pas : sur une
machine plus lente ou une base plus grosse, une seule requête dépasse encore le délai. Et
deux grosses requêtes DuckDB simultanées dépassent la mémoire du container, qui est tué
(reproduit dans `docker/spe-sim`, voir §4).

**Principe.** Deux niveaux, sans usine à gaz :

1. **Calculs longs = jobs serveur** (table `jobs` existante) : visibles dans le panneau des
   jobs, annulables, indépendants de l'onglet et de la passerelle, et passés dans une file
   qui borne le nombre de grosses requêtes simultanées.
2. **Requêtes interactives** (éditeur SQL, données patient, cohorte en construction) :
   elles restent synchrones, avec `deferred` comme filet (202 + relève au-delà de 20 s) pour
   qu'aucune n'aboutisse plus jamais à un 504.

---

## 1. Inventaire

État au 2026-10-14. « Mode » : **sync** = une requête HTTP qui attend ; **boucle** = le
navigateur enchaîne des requêtes courtes ; **deferred** = 202 + relève ; **job** = table
`jobs` ; **tâche** = tâche en mémoire avec sa propre relève ; **WS** = WebSocket.

### A. SQL construit par le navigateur, envoyé à `POST /data-sources/{id}/query`

La grande majorité. Une seule primitive serveur (le *job de requêtes*, §2) les couvre toutes.

| Tâche | Mode | Survit à l'onglet fermé | Annulable | Cible |
|---|---|---|---|---|
| Data catalog : calcul (aussi via MCP) | boucle | non (reprise) | oui | **job — preuve de concept** |
| Data catalog : estimation des rendements | boucle, non découpée | non | au démontage | job |
| Liste des concepts : décompte par unités | boucle | non (reprise) | oui | job |
| Statistiques d'une base | boucle (~10 requêtes) | non | oui | job |
| Comptage de toutes les tables, profil de colonne, qualité ETL | sync / boucle | non | non | job |
| Qualité des données : exécution d'un jeu de règles | boucle séquentielle | **non, résultats perdus** | **non** | job |
| Cohorte : exécution, rapport, tables | boucle | non | en partie | job (exécution, rapport) |
| Extraction des concepts sources (mapping) | boucle | non (reprise) | oui | job |
| Éditeur SQL (base, scripts, IDE, Rmd) | sync | non | **non** | interactif + `deferred` |
| Données patient, statistiques d'un concept, nombre de patients | sync | non | rarement | interactif + `deferred` |

### B. Travail lourd déjà côté serveur, en requête synchrone

| Tâche | Route | Cible |
|---|---|---|
| Gel d'une cohorte (matérialisation, sans plafond de lignes) | `POST /cohorts/{id}/materialize` | job |
| Dataset depuis une requête (MCP seul, sans plafond) | `POST /dataset-files/from-query` | job |
| Commit + push git, clone | `git.py` | job |
| Export ZIP espace de travail / projet / mapping | `export-zip` | job |
| Table globale des mappings, import de scores | `mapping_projects.py` | job |
| Création d'une base depuis un DDL, déplacement de fichier | `data_sources.py` | job |
| Paquets : ajout/suppression (job, mais la requête attend), preset, mises à jour | `environments.py` | job sans attente |
| Inspection d'un export ATHENA (relancée à l'import) | `vocabulary-library/inspect` | job |

### C. Tâches de fond ad hoc, à ranger dans la table `jobs`

Compactage d'une base, import de vocabulaires (l'interface ne peut pas s'y raccrocher), et
`deferred` lui-même. Aucune n'est annulable, toutes sont perdues au redémarrage.

### D. Flux WebSocket

- **Exécution ETL** : rien n'est envoyé pendant une instruction, donc une instruction plus
  longue que le délai d'inactivité de la passerelle coupe la socket, et la coupure annule le
  run. Elle échoue aussi si la passerelle bloque les WebSockets. Cible : job, flux en option.
- **Terminal** : interactif par nature, reste en WebSocket.

### E. Déjà des jobs

Dérivation d'une base depuis une cohorte, construction d'environnement, « Run as job ».

### F. Bloquent toute l'API (à corriger quel que soit le reste)

`fs/rebind-copy` (copie de dossier sur la boucle d'événements) et `uploads/{id}/complete`
(réassemblage des morceaux sur la boucle) : pendant la copie, plus personne n'a de réponse.

---

## 2. La primitive : le job de requêtes

Un job qui exécute **une liste ordonnée de requêtes SQL** sur une base et garde le résultat
de chacune. Une requête seule est le cas d'une liste d'un élément.

**Serveur**

- `POST /data-sources/{id}/query-jobs` `{label, owner, queries: [{key, sql}]}` → le job
  (`kind = "query"`). Droits : `databases:read` sur la base, comme `/query`.
- Le corps du job exécute les requêtes **l'une après l'autre**, chacune par le même chemin
  que `/query` (`data_source_service.query`, login de l'utilisateur, journal d'accès),
  `progress` = faites / total, une ligne de log par requête.
- Résultat de chaque requête écrit en JSON (le corps même de `/query`) sous
  `data_dir/job-results/<job>/<key>.json` ; `Job.result` ne garde que
  `{done, rows, total, error?}` — jamais les lignes, pour que la liste des jobs (relevée
  toutes les 3 s) reste légère.
- `GET /jobs/{id}/results/{key}` → les lignes (JSON), en revérifiant `databases:read`.
  Le dossier est effacé quand le job est effacé (`clear_finished`) et au bout de 24 h.
- **File dédiée** : un sémaphore `max_heavy_queries` (nouveau réglage, défaut 1), distinct de
  celui des builds — un catalog ne bloque pas un build, et deux grosses requêtes DuckDB ne
  tournent jamais ensemble.
- **Annulation** : `POST /jobs/{id}/cancel` interrompt la requête DuckDB en cours
  (`query_cancel` / `con.interrupt()`), pas seulement la tâche asyncio.

**Client** (`lib/api/query-jobs.ts`)

- `startQueryJob(...)`, `followQueryJob(id, onResult, signal)` : relève l'état toutes les
  1,5 s, récupère chaque résultat dès qu'il est prêt, dans l'ordre.
- Mode client seul (WASM) et MCP : inchangés, ils gardent l'exécution requête par requête.

## 3. Preuve de concept : le data catalog — construite le 2026-10-14

Validée dans `docker/spe-sim` (passerelle 60 s, conteneur 5 Go, 240 M de lignes) : calcul
complet sans 504 (≈ 6 min, la première requête dure plus de 4 min) ; onglet fermé en cours
de phase → le job continue, la reprise le suit sans en relancer un ; annulation depuis le
panneau → pause, requête DuckDB interrompue ; deux jobs lourds lancés ensemble → le second
attend, pas d'OOM — à condition de borner la mémoire de DuckDB : avec ses 80 % par défaut,
une seule grosse requête faisait tuer le conteneur de 5 Go (Python occupe ~1 Go à côté).
D'où `LINKR_DUCKDB_MEMORY_LIMIT`, 60 % par défaut. Reste hors job : le dimensionnement (`planSlices`, deux requêtes rapides
sur Parquet, plus lentes sur une base distante) et l'estimation des rendements.

1. **Étapes sous forme de données** (`catalog-compute.ts`) : chaque étape devient
   `{info, sql | null, apply(rows, state)}` au lieu d'une fermeture qui appelle `query`. Le
   comportement ne change pas : `run = apply(await query(sql))`.
2. **Exécuteur injecté** (`catalog-run.ts`) : `runCatalogComputation` reçoit une fonction qui
   exécute une liste d'étapes. Par défaut, requête par requête (WASM, MCP) ; en mode serveur,
   un job par phase — les étapes de base (concepts, totaux, classements) en un job, puis les
   croisements, planifiés à partir des classements, en un second.
3. **Onglet fermé** : le job continue. L'id du job en cours est sauvegardé avec l'état de
   reprise ; au retour, la reprise relit les résultats déjà prêts au lieu de les recalculer.
4. **Pause** = annulation du job ; les étapes déjà intégrées sont gardées comme aujourd'hui.
5. Le panneau des jobs affiche « Catalog X — 7/12 ».

**Ce que ça touche** : `catalog-compute.ts`, `catalog-run.ts`, `catalog-runner.ts` (front) ;
un service `query_jobs.py`, deux routes, un réglage, le nettoyage des résultats (serveur) ;
tests vitest (plan des étapes, reprise avec job) et pytest (route, annulation, droits, file).

**Validation** : la reproduction de §4 doit aboutir sans 504, passerelle à 60 s, y compris en
fermant l'onglet au milieu ; et deux catalogs lancés ensemble passent l'un après l'autre sans
que l'API soit tuée.

## 4. Reproduction

`docker/spe-sim`, passerelle à 60 s, conteneur à 4 Go, base DuckDB sur Parquet de 240 M de
lignes (générateur synthétique OMOP) : la requête de décompte des concepts du catalog dure
190 s côté serveur et le navigateur reçoit un 504 à 60 s. Une tranche de 50 M de lignes dure
26 s. Deux requêtes simultanées font tuer le conteneur (OOM).

## 5. Ensuite, dans l'ordre

1. Liste des concepts, qualité des données, statistiques : même primitive, même exécuteur.
2. `deferred` sur `/query` pour les requêtes interactives.
3. Groupe B (gel de cohorte, exports, git…) : `jobs.launch` autour du code existant.
4. Groupe C dans la table `jobs` ; ETL en job.
5. Groupe F, indépendamment (petits correctifs).
