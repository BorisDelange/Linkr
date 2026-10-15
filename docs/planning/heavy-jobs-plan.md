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

État au 2026-10-14, §3 bis et §3 ter compris. « Mode » : **sync** = une requête HTTP qui attend ; **boucle** = le
navigateur enchaîne des requêtes courtes ; **deferred** = 202 + relève ; **job** = table
`jobs` ; **tâche** = tâche en mémoire avec sa propre relève ; **WS** = WebSocket.

### A. SQL construit par le navigateur, envoyé à `POST /data-sources/{id}/query`

La grande majorité. Une seule primitive serveur (le *job de requêtes*, §2) les couvre toutes.

| Tâche | Mode | Survit à l'onglet fermé | Annulable | Cible |
|---|---|---|---|---|
| Data catalog : calcul (aussi via MCP) | **job** (serveur) | oui (suit le job) | oui | fait (§3) |
| Data catalog : estimation des rendements, dimensionnement | boucle, requêtes `heavy` | non | oui | fait (§3 ter) |
| Liste des concepts : décompte par unités | **job** par étape | oui (suit le job) | oui | fait (§3 bis) |
| Statistiques d'une base | **job** (statistiques, puis comptage des tables) | oui (suit le job) | oui | fait (§3 bis) |
| Comptage de toutes les tables | **job** | non | oui | fait (§3 ter) |
| Profil de colonne, qualité ETL | requêtes `heavy` | non | oui (panneau) | fait (§3 ter) |
| Qualité des données : exécution d'un jeu de règles | **job** | oui (suit le job) | oui | fait (§3 bis) |
| Cohorte : exécution, rapport, tables | requêtes `heavy` | non | oui (panneau) | fait (§3 ter) |
| Extraction des concepts sources (mapping) | boucle, classement `heavy` | non (reprise) | oui | fait (§3 ter) |
| Éditeur SQL (base, scripts, IDE, Rmd) | `deferred` | non | oui (panneau) | fait (§3 ter) |
| Données patient, statistiques d'un concept, nombre de patients | `deferred` | non | oui (panneau) | fait (§3 ter) |

### B. Travail lourd déjà côté serveur, en requête synchrone

| Tâche | Route | Cible |
|---|---|---|
| Gel d'une cohorte (matérialisation, sans plafond de lignes) | `POST /cohorts/{id}/materialize` | fait (`deferred`, lourde) |
| Dataset depuis une requête (MCP seul, sans plafond) | `POST /dataset-files/from-query` | fait (`deferred`, lourde) |
| Commit + push git, clone | `git.py` | fait (`deferred`) ; statut et diff : non |
| Export ZIP espace de travail / projet / mapping | `export-zip` | fait (`deferred`) ; réglages : non |
| Table globale des mappings, import et pull de scores | `mapping_projects.py`, `git.py` | fait (`deferred`, lourde) |
| Déplacement de fichier ; création depuis un DDL | `data_sources.py` | fait (`deferred`) ; DDL : non (rapide) |
| Paquets : ajout/suppression, preset, mises à jour | `environments.py` | fait (`deferred`) |
| Inspection d'un export ATHENA (relancée à l'import) | `vocabulary-library/inspect`, `/import` | fait (`deferred`) |

### C. Tâches de fond ad hoc, à ranger dans la table `jobs`

Compactage d'une base, import de vocabulaires (l'interface ne peut pas s'y raccrocher), et
`deferred` lui-même. Aucune n'est annulable, toutes sont perdues au redémarrage.
**Fait (§3 ter)** : les trois sont des jobs du panneau, annulables.

### D. Flux WebSocket

- **Exécution ETL** : rien n'est envoyé pendant une instruction, donc une instruction plus
  longue que le délai d'inactivité de la passerelle coupe la socket, et la coupure annule le
  run. Elle échoue aussi si la passerelle bloque les WebSockets. Cible : job, flux en option.
  **Fait (§3 ter)** : job ETL, la WebSocket a disparu.
- **Terminal** : interactif par nature, reste en WebSocket.

### E. Déjà des jobs

Dérivation d'une base depuis une cohorte, construction d'environnement, « Run as job ».

### F. Bloquent toute l'API (à corriger quel que soit le reste)

`fs/rebind-copy` (copie de dossier sur la boucle d'événements) et `uploads/{id}/complete`
(réassemblage des morceaux sur la boucle) : pendant la copie, plus personne n'a de réponse.
**Fait (§3 ter)** : les deux passent dans un thread.

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
- **Runner** : ce que fait une requête est un paramètre du job. Par défaut (`read_rows`)
  le chemin de `/query` et un fichier de résultat ; `write_concept_units` écrit l'unité
  dans le cache des concepts (aucun résultat à rapatrier). Chaque requête peut porter son
  propre `pushdown` (jamais pour le SQL écrit à la main). `keepGoing` : une requête en
  échec n'arrête pas le job, son erreur est gardée sous sa clé (`errors`). Le job garde
  aussi la durée de chaque requête (`ms`).
- **Progression dans une requête** : toutes les connexions DuckDB du serveur ont
  `enable_progress_bar` ; pendant une requête, le job lit `con.query_progress()` chaque
  seconde et publie `current` + `reading` (pourcentage des données lues), et une
  `progress` de job qui compte la fraction de la requête en cours (panneau Jobs). C'est la
  part des lignes lues, pas le temps restant : une agrégation finale reste sur son dernier
  chiffre. Une requête calculée par Postgres/MySQL/Doris (pushdown) n'en donne aucune —
  l'interface montre alors le temps écoulé de l'étape (`RunSteps`), et le catalog la durée
  de son dernier calcul.

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

## 3 bis. Concepts, qualité, statistiques — construit le 2026-10-14

À valider à la main dans `docker/spe-sim` (§4).

- **Décompte des concepts** (`concept-count-runner.ts`) : un job par étape (lignes par
  table, puis patients par tranche), route `POST …/concept-cache/units-job`. L'assemblage
  de la liste est une requête du job (clé `assemble-…`) : après la dernière unité de
  chaque étape et environ tous les dixièmes des patients — jamais à côté d'une unité,
  donc jamais deux grosses requêtes DuckDB ensemble. L'id du job est dans le manifeste du
  run : un onglet fermé laisse le job compter, le démarrage suivant le suit. La route
  unité par unité (`POST …/units/{key}`) a disparu.
- **Qualité des données** (`dq-run.ts`, sur `lib/run-registry.ts`) : un job `keepGoing`
  (un contrôle en échec est un résultat `error`, pas la fin du run). Le run survit au
  changement d'onglet ; le job est retenu dans le navigateur avec la liste des contrôles
  qu'il exécute (`runQueryJob`, `remember`), et la page rouverte le suit puis enregistre
  le run dans l'historique. Bouton Arrêter.
- **Statistiques d'une base** (`database-stats.ts`) : les blocs sont une liste de
  requêtes ; un job `keepGoing` pour les statistiques, puis un pour le comptage des
  tables (un bloc en échec reste vide, comme avant). Un job arrêté depuis le panneau vaut
  un arrêt de la page. Chaque job est retenu dans le navigateur (`runQueryJob`,
  option `remember`) : l'onglet rouvert suit celui que la fermeture a laissé et
  enregistre ses résultats.
- **Progression** : voir §2 ; affichée sur la ligne de l'étape active (catalog,
  concepts), dans l'onglet Résultats de la qualité et dans le panneau Jobs.

## 3 ter. Le reste — construit le 2026-10-14

À valider à la main dans `docker/spe-sim` (§4).

- **`deferred` adossé aux jobs** (`core/deferred.py`) : un travail qui dépasse 20 s devient un
  job `task` du panneau (`AsJob` : libellé, propriétaire, file éventuelle), annulable ; la
  relève rend la réponse de la route, JSON ou fichier (`apiFetchFollowing` côté client, et
  le client du MCP). Seuls les travaux longs comptent dans le plafond par utilisateur.
- **`/query`** passe par là : plus aucun 504 sur une requête interactive. Une requête que
  l'application marque `heavy` (estimations et dimensionnement du catalog, cohorte, profil
  de colonne, qualité ETL, classement de l'extraction) attend son tour dans la file des
  requêtes lourdes ; elle ne devient un job du panneau qu'au-delà de 20 s, sans l'inonder.
- **Routes du groupe B** : `deferred.respond` autour de leur travail, dans sa propre session.
- **Groupe C** : compactage et import de vocabulaires deviennent des jobs (`compact`,
  `vocab-import`) ; l'annulation interrompt la copie avant tout remplacement de fichier.
- **ETL** : `POST …/etl-jobs`, un job par script (même session DuckDB), suivi par relève ;
  la WebSocket est supprimée. La route synchrone reste pour le MCP, sous `deferred`.
- **Groupe F** : copie de dossier et réassemblage d'upload hors de la boucle d'événements.
- **Non traité** : statut et diff git reconstruisent l'export dans la requête ; export et
  clone des réglages (admin) ; création depuis un DDL (rapide) ; lectures paginées des
  fichiers source d'un projet de mapping (`filesrc_`, hors `/query`).

## 4. Reproduction

`docker/spe-sim`, passerelle à 60 s, conteneur à 4 Go, base DuckDB sur Parquet de 240 M de
lignes (`python3 docker/spe-sim/make-datamart.py 240000000`, OMOP synthétique ; sans argument, 20 M de lignes pour des essais rapides) : la requête de décompte des concepts du catalog dure
190 s côté serveur et le navigateur reçoit un 504 à 60 s. Une tranche de 50 M de lignes dure
26 s. Deux requêtes simultanées font tuer le conteneur (OOM).

## 5. Ensuite, dans l'ordre

1. ~~Liste des concepts, qualité des données, statistiques~~ — fait (§3 bis).
2. ~~`deferred` sur `/query`~~, ~~groupe B~~, ~~groupe C et ETL~~, ~~groupe F~~ — fait (§3 ter).
3. Valider l'ensemble dans `docker/spe-sim` (§4), puis les points « non traité » du §3 ter
   s'ils posent problème en vrai.
