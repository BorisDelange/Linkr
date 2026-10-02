# Passage à l'échelle — bases d'un milliard de lignes

**Problème.** Sur une base DuckDB qui lit des Parquet de plus d'un milliard de
lignes, les Statistiques passent, mais :

1. la liste des concepts échoue (`Could not build the concept list: 504 Gateway
   Time-out`), sans moyen de l'interrompre ;
2. le sélecteur de concepts des cohortes (workspace › database › cohorte) lance
   ce même calcul en silence s'il n'a jamais été fait ;
3. en Patient data, Timeline et Notes ignorent le séjour sélectionné ;
4. le Data overview met longtemps à s'afficher pour un patient à ~50 M lignes.

Ordre arbitré le 2026-10-02 : §1 → §2 → §3 → §4. Pilotage du calcul des concepts :
**comme le catalog** (le navigateur enchaîne des requêtes courtes ; fermer
l'onglet met en pause, la reprise repart de la dernière sauvegarde).

---

## 0. Contournement immédiat (rien à coder)

- Le 504 ne vient pas du nginx de Linkr (`docker/nginx.conf:53`,
  `proxy_read_timeout 3600s`) mais du proxy placé devant (`nginx/1.20.1`, délai
  par défaut 60 s). Monter son `proxy_read_timeout` débloque en attendant.
- Le `COPY` continue côté serveur après le 504 (rien ne l'annule) : recharger la
  page plus tard peut montrer la liste. Chaque « Retry » lance un calcul de plus
  en parallèle — à éviter.
- Même après §1, chaque unité reste une requête HTTP : elle doit tenir sous le
  délai du proxy. Le banc d'essai (§3) donne la taille de tranche qui convient.

---

## 1. Liste des concepts : calcul par unités, avec pause et reprise

### 1.1 Aujourd'hui

- `use-concepts.ts:623` `refresh()` → `POST /data-sources/{id}/concept-cache/refresh`
  (`lib/api/concept-cache.ts:20`), une seule requête synchrone, sans signal.
- Serveur : `data_source_service.py:1054` → `concept_cache_fs.refresh` →
  `db_connect.materialize_parquet` (`db_connect.py:1091`) : un `COPY (SELECT …)
  TO parquet`, hors `query_cancel.tracking` → impossible à interrompre.
- SQL : `buildConceptsMaterializeQuery` (`concept-queries.ts:391`) — par
  dictionnaire, `LEFT JOIN` sur `buildCountsSubquery` (`:289`) : `UNION ALL` de
  toutes les tables d'événements (deux fois quand il y a `source_concept_id`),
  puis `COUNT(*)` + `COUNT(DISTINCT patient)` par concept sur tout l'entrepôt.
  Le `COUNT(DISTINCT)` global est le coût dominant (temps et mémoire).
- Le cache est déjà **par database** : `_cache/concept-lists/{source_id}.parquet`
  (par utilisateur pour une base externe).
- Commentaire périmé `concept-queries.ts:318-320` (« counts streamed/cached
  separately ») : à corriger au passage.

### 1.2 Cible

Deux phases, chacune découpée en unités = une requête `/query` (donc annulable
via `/query/cancel`, comme le catalog) :

| Phase | Unité | SQL | Additif ? |
|---|---|---|---|
| `records` | une (table × colonne de concept) | `SELECT concept_id AS cid, COUNT(*) FROM <rel> GROUP BY 1` (et idem `source_concept_id`) | oui — des lignes |
| `patients` | une tranche de patients | `UNION ALL` des tables **dans la tranche**, `GROUP BY cid` → `COUNT(DISTINCT pid)` | oui — tranches disjointes |

- La phase `patients` reste une union sur toutes les tables *à l'intérieur* d'une
  tranche : un patient présent pour un même concept dans deux tables ne doit
  compter qu'une fois. Ce sont les tranches qui s'additionnent, pas les tables.
- Tranches : `planSlices` du catalog (`catalog-compute.ts:199`, quantiles de
  `patient_id`), avec un seuil plus bas que `SLICE_EVENT_ROWS = 250 M` — à régler
  sur le banc (§3) pour qu'une unité tienne largement sous 60 s.
- Les comptes sont calculés **une fois par concept_id**, indépendamment des
  dictionnaires ; la jointure aux dictionnaires se fait côté serveur à
  l'écriture du Parquet.
- Après la phase `records`, la liste est utilisable (colonne patients vide, avec
  un indicateur « en cours ») ; la phase `patients` la complète à chaque
  sauvegarde.
- Vérifier au passage si le décompte actuel compte deux fois une ligne dont
  `concept_id = source_concept_id` ; décider du comportement voulu et le
  garder dans les nouvelles requêtes.

### 1.3 Construit (2026-10-02, `feature/scale-concepts`)

Écart au plan initial : l'état de reprise n'est pas un blob `stats_cache` mais
**un Parquet par unité côté serveur** (`concept_cache_fs.write_unit`, dossier
`<source>.run/units/`) plus un manifeste JSON possédé par le client. Rien de
volumineux ne transite par le navigateur ; une unité est faite ou absente
(écriture atomique) ; la reprise saute les fichiers présents ; `assemble`
joint les dictionnaires aux unités faites (vue `memory.main._concept_counts`).

- Front : `concepts/concept-count-plan.ts` (unités, signature, progression),
  `concept-count-runner.ts` (sur `lib/run-registry.ts`, nouveau registre
  générique — la boucle du catalog, elle, sauvegarde un état en mémoire et ne
  s'est pas prêtée à l'extraction), `use-concept-count.ts`, `ConceptCountNotice`,
  `databases/DatabaseConceptsTab.tsx`.
- Serveur : routes `PUT …/concept-cache/run`, `POST …/units/{key}` (annulable par
  `/query/cancel`), `POST …/assemble` ; l'ancienne route `refresh` a disparu.
- Mode client seul : inchangé (comptes en ligne).

### 1.4 Mesures (banc `scratchpad`, Mac 8 cœurs / 16 Go / SSD)

| 1 Md de lignes, non trié | Durée |
|---|---|
| Ancien `COPY` unique | 320 s (→ 504 derrière un proxy à 60 s) |
| Étape `records` (5 unités) | 10 s — liste utilisable |
| Étape `patients`, tranches de 100 M | 16–33 s par tranche, 180 s au total |

D'où `CONCEPT_SLICE_ROWS = 50 M`. Sur 300 M lignes, Parquet **trié** par patient :
décompte complet 12 s au lieu de 31 s, lignes d'un patient 0,03 s au lieu de 0,40 s.

### 1.5 Tests

- Vitest : planification des unités (tables × colonnes, tranches), fusion
  additive des comptes, sérialisation/reprise de l'état, SQL généré par unité
  (avec et sans `source_concept_id`, avec les CTE de classes).
- Test de la boucle extraite : pause au milieu, reprise sans perte ni doublon.
- pytest : route d'écriture du cache (jointure dictionnaires, écriture atomique,
  permissions).

---

## 2. Onglet Concepts dans chaque database ; projets et cohortes lisent le cache

- `DatabaseDetailPage.tsx:91` : ajouter `concepts` à `DATABASE_TAB_IDS` **et** à
  `PROJECT_TAB_IDS` — l'onglet existe donc sur chaque database, vue depuis le
  workspace comme depuis un projet. Il porte le statut, l'avancement par phase,
  Lancer / Pause / Reprendre / Recalculer, la date du dernier calcul, et la
  liste des concepts de cette database (même tableau que la page Concepts).
- Un seul run par database, quel que soit l'endroit d'où on le lance.
- Page Concepts du projet : conservée (explorateur sur la database active). Elle
  **ne lance plus rien automatiquement** en mode serveur (`use-concepts.ts:663`) :
  bandeau « liste non calculée / partielle » + lien vers l'onglet Concepts de la
  database ; avancement affiché si un run tourne.
- Sélecteur de concepts des cohortes (`CohortConceptPickerDialog.tsx:133`) : même
  chose — aujourd'hui l'ouvrir lance le calcul complet sans montrer ni
  l'avancement ni l'erreur.
- Permission de lancer : la même que le rafraîchissement des Statistiques (à
  vérifier).
- i18n en/fr ; doc utilisateur `linkr-website` (page Databases + Concepts).

---

## 3. Patient data : filtre séjour + banc d'essai à grande échelle

> Construit le 2026-10-02 : `lib/duckdb/patient-scope.ts` (une portée pour tous
> les widgets — hospitalisation par `visit_id`, sinon par ses dates ; séjour par
> ses dates), `use-patient-scope.ts` (fenêtres lues une fois, en cache),
> `idLiteral` pour les plugins script, banc dans `scripts/bench/`, avertissement
> « non trié » (`parquet_layout.py` + `ParquetLayoutNotice`). Vérifié dans le
> navigateur (MIMIC demo, client seul) : Notes 32 → 9 sur un séjour, Timelines
> bornées au séjour.

### 3.1 Filtre séjour

| Widget | Hospitalisation | Séjour |
|---|---|---|
| Patient summary | non (dossier entier, voulu) | non |
| Timeline (`patient-data-queries.ts:262`) | oui | **non** |
| Clinical notes (`patient-data-queries.ts:349`) | oui | **non** |
| Data overview | oui | oui, par fenêtre de dates |

- Timeline et Notes appliquent la fenêtre du séjour comme le Data overview
  (`buildOverviewStayWindowQuery` + `buildStayFilter`,
  `patient-overview-queries.ts:274,360`), via un helper partagé —
  `visit_detail_id` est souvent vide (OMOP sample, MIMIC `labevents`).
- `TimelineWidget.tsx` : ajouter le séjour aux dépendances du fetch (`:307`).
- Aperçu SQL de l'éditeur (`PatientWidgetEditorSheet.tsx:97`, `widget-sql.ts:70,88`)
  et `timeline_sql` des plugins : passer aussi le séjour.
- Plugins script : `warehouse-plugin-executor.ts` injecte `person_id = ${pid}`
  sans guillemets → littéral correctement échappé.
- `buildVisitFilter` suppose une colonne `visit_id` sur chaque relation
  d'événements alors que le contrat la rend optionnelle
  (`schema-classes/contracts.ts:74`) : vérifier la colonne.
- Vitest : les builders Timeline / Notes avec séjour, avec et sans date de fin.

### 3.2 Banc d'essai (manuel, hors CI)

Script (`scripts/bench/` ou `apps/api/tests/perf/`) qui génère avec DuckDB un
OMOP synthétique paramétrable (`range()`), par défaut ~1 M patients et ~1 Md de
lignes d'événements, dont un patient à ~50 M lignes, en deux variantes de
Parquet : **non trié** et **trié par `person_id` puis date**. Il mesure, temps
et mémoire de pointe :

- chaque unité du calcul des concepts (→ seuil de tranche de §1.2) ;
- les requêtes patient (inventaire, densité, événements, Timeline) trié vs non trié ;
- les requêtes de densité du §4.

### 3.3 Disposition des Parquet

Toutes les requêtes Patient data filtrent sur `patient_id`. Non trié, DuckDB ne
peut sauter aucun row group et relit tout l'entrepôt à chaque widget ; trié, les
min/max par row group en écartent la quasi-totalité. Linkr ne possède pas ces
Parquet (la compaction, `managed_db.compact`, ne concerne que les DuckDB gérés) :

- documenter la recommandation (tri `person_id`, date ; row groups de taille
  raisonnable) dans la doc utilisateur / admin ;
- diagnostic (arbitré le 2026-10-02) dans l'onglet Statistiques : via `parquet_metadata()`, signaler
  une table dont les plages `person_id` des row groups se recouvrent.

---

## 4. Data overview : chargement par niveau de zoom

### 4.1 Aujourd'hui (`PatientOverviewWidget.tsx`, `patient-overview-queries.ts`)

Déjà en partie multi-résolution : inventaire par concept, bande de 240 cases
calculée en SQL, puis événements bruts de la fenêtre visible pour les lignes
assez peu denses (`LIMIT 4000`), rendu Canvas 2D. Les trous :

- les lignes denses ne sont **jamais** chargées → vides quand on est dézoomé
  (`drawDensity` reçoit `undefined`, `:1386`) ; `buildOverviewDensityQuery`
  sait densifier par ligne (`rows`) mais le tracé principal ne s'en sert pas ;
- au-delà de 4000 événements, la densité client ne couvre que les premiers →
  biais vers la gauche ;
- chaque pan/zoom change la clé du cache (`view.lo|view.hi`) et relance toutes
  les lignes, en série (`:546`), sans debounce ni annulation.

> Construit le 2026-10-02 (`widgets/overview-tiles.ts`, `buildOverviewTileDensityQuery`) :
> densité SQL sur cases absolues (puissance de deux ms ≈ 1 px) par tuiles de 256,
> toutes les tuiles manquantes d'une vue en une requête ; événements sur une
> fenêtre élargie et alignée, réutilisée au zoom ; une fenêtre tronquée à 4000
> bascule la ligne en densité ; debounce 150 ms, annulation, 4 requêtes en
> parallèle. M4 (min/max par case) reporté. Corrigé au passage : `cancellableQuery`
> (WASM) lisait un schéma encore vide. Mesures dans `scripts/bench/README.md`.

### 4.2 Cible

1. **Densité SQL pour les lignes denses** : une case par pixel ; nombre
   d'événements par case, et pour les mesures numériques min/max par case
   (agrégation M4 — tracé exact au pixel). Le brut reste pour les lignes peu
   denses dans la fenêtre ; le choix se fait sur le compte de l'inventaire
   ramené à la fenêtre, plus sur la limite 4000.
2. **Tuiles** : la fenêtre est arrondie à des tuiles de largeur puissance de 2
   (niveau de zoom × index), mises en cache par (ligne, niveau, tuile) ; un pan
   ne charge que les tuiles manquantes, le dézoom réutilise le niveau au-dessus.
3. **Requêtes maîtrisées** : debounce ~150 ms, annulation des requêtes obsolètes
   (`queryId` + `/query/cancel`), petite concurrence (3–4) au lieu du `for` en série.
4. **Défilement vertical** : ne requêter que les lignes visibles du budget, plus
   les voisines en préchargement.
5. 💤 Si le banc montre que ça ne suffit pas sur Parquet trié : pré-agrégat par
   patient matérialisé à la première ouverture (vues matérialisées façon Mosaic).

### 4.3 Tests

- Vitest : quantification fenêtre → tuiles (bords, niveaux), clé de cache,
  builder de densité M4 (SQL), choix brut/densité.
- Banc §3.2 : temps d'affichage initial et par pan/zoom sur le patient à 50 M lignes.

---

## 5. Tests manuels (à reporter dans le README une fois construit)

- Concepts : lancer depuis l'onglet database, pause, fermer l'onglet, reprendre ;
  liste utilisable après la phase `records` ; recalcul ; lancement depuis un
  projet pendant qu'un run tourne (pas de second run).
- Page Concepts du projet et sélecteur de cohorte sans cache : bandeau + lien,
  aucun calcul lancé.
- Patient data : hospitalisation puis séjour → Timeline, Notes et Data overview
  filtrés ; séjour sans `visit_detail_id` dans les événements.
- Data overview sur le patient du banc : dézoom complet, zoom profond, pan rapide.

Sources : M4 (Jugel et al., VLDB 2014), Mosaic (UW IDL), doc DuckDB sur le
partitionnement et l'élagage des Parquet.
