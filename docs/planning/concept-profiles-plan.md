# Profils de concepts — un seul calcul par base

**Problème.** Trois écrans calculent des statistiques par concept, chacun de son
côté, et aucun ne lit les résultats d'un autre :

| | Onglet *Concepts* d'une base | Extraction des *Source concepts* (concept mapping) | *Data catalog* |
|---|---|---|---|
| Calcule | lignes, patients, stats numériques (min/max/moyenne/écart-type/P1…P99, 20 classes P1–P99) | lignes, patients + 10 sections au choix (numérique, histogramme, catégoriel, unité, fréquence, temporel, services, complétude, par patient) | lignes, patients, séjours + croisements (période, service, âge, sexe) |
| Où | serveur seulement : unités Parquet `_cache/concept-lists/<source>[~user-N]` | navigateur, les deux modes : `info_json` dans `source-concepts.csv` du projet de mapping | JSON (`stats_caches` serveur, IndexedDB en WASM) |
| Patients | distincts sur toutes les tables d'événements | comptés dans la table principale du concept seulement | distincts |
| Histogramme | 20 classes entre P1 et P99 | valeurs aberrantes écartées (IQR/MAD/percentile), classes de Sturges | — |
| Anonymisation | aucune (local) | `minPatients` au calcul, masquage < 11 à l'export | suppression + bruit à la publication |
| Portée | par base **et par utilisateur** (base externe) | par projet de mapping | par catalog |

Conséquences : le même SQL de comptage tourne trois fois sur la même base ; un
concept affiche deux histogrammes différents et deux nombres de patients
différents selon l'écran ; tout ce qui a été calculé pour un écran est perdu pour
les autres.

Arbitré le 2026-11-02 : **un seul profil par concept et par base, exact, calculé
une fois ; chaque lecteur filtre ce dont il a besoin.**

---

## 1. Le principe

- **Un seul magasin par base**, partagé par tout le workspace (pas par
  utilisateur, §5). Valeurs exactes, sans seuil.
- **Calcul incrémental par section.** Chaque section d'un concept porte sa date
  et l'empreinte des données (§4). Demander une section absente ne calcule que
  celle-là, et l'ajoute au magasin : l'onglet *Concepts* en profite ensuite, et
  inversement.
- **Filtrage à la lecture** — « qui peut le plus peut le moins ». L'onglet
  *Concepts* lit tout. Le concept mapping lit les sections demandées et applique
  son seuil : concept sous `minPatients` → pas de profil ; catégorie sous
  `minCategoryCount` ou trop longue (`maxCategoryLength`, texte libre) → masquée ;
  `topN` coupé. Le *Data catalog* garde son propre calcul (croisements) et sa
  propre anonymisation, à la publication.

Pour que le filtrage marche à la lecture, le magasin garde ce qu'un seuil
demande : **les patients de chaque catégorie et de chaque service**, pas
seulement leurs lignes, et un `topN` large (200) pour qu'un `topN` plus petit se
déduise sans recalcul.

## 2. Le magasin

Serveur : un dossier par base, `_cache/concept-profiles/<source_id>/`, des
fichiers Parquet par section, écrits par unités comme aujourd'hui (même moteur :
jobs, reprise, pause, une unité à la fois). Clé de chaque ligne :
`(dict_key, concept_id)`, avec `vocabulary_id` et `concept_code` en colonnes
pour que le concept mapping retrouve ses concepts par (terminologie, code).

| Section | Table | Colonnes |
|---|---|---|
| `counts` | `counts.parquet` | lignes, patients (distincts, toutes tables), lignes par table d'événements |
| `numeric` | `numeric.parquet` | n, min, max, moyenne, écart-type, P1, P5, Q1, médiane, Q3, P95, P99, bornes IQR/MAD |
| `histogram` | `histogram.parquet` | une ligne par classe : borne, lignes, patients |
| `categorical` | `categorical.parquet` | une ligne par valeur (top 200) : valeur, longueur, lignes, patients |
| `unit` | `unit.parquet` | une ligne par unité : unité, lignes |
| `missingRate` | dans `counts` | lignes sans valeur |
| `temporal` | `temporal.parquet` | min/max date, une ligne par année |
| `frequency` | dans `numeric` | délai médian entre deux lignes d'un patient |
| `hospitalUnits` | `units.parquet` | une ligne par service (top 200) : lignes, patients |
| `perPatient` | dans `counts` | moyenne/médiane/min/max lignes par patient |

Plus `manifest.json` : par section, l'empreinte et la date du calcul, les
options (méthode d'écart des aberrants, nombre de classes).

**Une seule définition de l'histogramme** : celle de l'extraction (aberrants
écartés par la méthode choisie, classes de Sturges plafonnées à 50) — c'est elle
que les projets de mapping exportés contiennent déjà, donc le format d'export ne
change pas. Le magasin garde les percentiles, donc l'onglet *Concepts* peut
toujours redessiner un histogramme P1–P99 sans recalcul s'il le faut.

**Une seule définition des patients** : distincts sur toutes les tables
d'événements du dictionnaire. L'extraction, qui les comptait sur la table
principale, change de chiffre — à signaler dans les notes de version.

**Les sections de détail** (numérique, catégoriel, unité…) sont calculées sur la
table d'événements qui porte le plus de lignes du concept, comme l'extraction le
fait déjà (`mergeTableCounts`) : deux tables ne mélangent pas leurs colonnes de
valeurs. `counts` dit laquelle.

Mode client (WASM) : le même magasin dans OPFS (`concept-profiles/<source_id>/`),
même Parquet, même moteur d'unités exécuté par DuckDB-WASM. C'est le plus gros
morceau ; il vient après le serveur (§6).

## 3. Les écrans

- **Onglet *Concepts* de la base** : propriétaire du magasin. Les cartes d'étapes
  deviennent la liste des sections (« What to compute for each concept », même
  composant que l'extraction), avec pour chacune son état : à jour, périmée,
  absente. *Calculer* ne lance que ce qui manque ; *Recalculer* refait tout ou
  les sections choisies. La ligne de progression parle en pourcentages, le
  détail des lots au survol.
- **Panneau d'un concept** : lit le magasin ; le calcul au clic (aujourd'hui
  `concept_stats_caches`) n'existe plus que pour un concept absent du magasin, et
  écrit dans le magasin.
- **Concept mapping, extraction** : quand la source est une base, l'extraction
  lit le magasin, demande au moteur les sections qui manquent (elles s'y
  ajoutent), puis filtre (§1) et écrit `info_json` comme aujourd'hui. Le projet
  garde sa copie : les décisions de mapping ont été prises sur ces valeurs, et
  l'export contient cette copie figée. Si le magasin est plus récent, le projet
  propose « Profil plus récent disponible — mettre à jour ». Une source *fichier*
  (CSV sans base) n'est pas concernée.
- **Data catalog** : inchangé, sauf éventuellement lire `counts` pour ses totaux
  par concept (gain faible, en dernier).

## 4. Données qui changent

À chaque section calculée, le manifeste garde une **empreinte** de la base :

- fichiers (Parquet, DuckDB, SQLite) : taille et date de chaque fichier lu ;
- base externe : nombre de lignes et identifiant maximal de chaque table
  d'événements (une requête légère par table).

L'onglet *Concepts* compare l'empreinte au chargement (bases fichiers) ou sur
demande (*Vérifier*, bases externes, où la requête coûte) et marque les sections
périmées. *Recalculer* se lance depuis l'onglet *Concepts* ; l'extraction d'un
projet de mapping peut le déclencher aussi, le calcul tourne alors sur la base
et remplit le même magasin.

Un changement du mapping de schéma de la base invalide tout (comme aujourd'hui
le cache des concepts).

## 5. Portée : le workspace, pas l'utilisateur

Aujourd'hui une base externe (PostgreSQL, Doris…) a un cache par utilisateur,
parce que chacun s'y connecte avec son propre login et que ses droits décident
de ce que la requête voit. Arbitré : **un seul cache par base**, partagé par
tous ceux qui ont accès à la base dans Linkr — recalculer pour chaque utilisateur
ne sert à rien.

Conséquence assumée : un utilisateur dont le login voit moins de tables lit des
effectifs calculés par un collègue qui en voit plus. Ce sont des agrégats,
l'accès à la base dans Linkr reste exigé (`databases:read`), et écrire le cache
d'une base externe demande désormais `databases:write` comme pour une base
fichier.

## 6. Étapes

| # | Étape | Effort |
|---|---|---|
| 0 | Pourcentages + détail des lots au survol ; SQL de la modale aéré ; la requête complète (relations `linkr_*` écrites en CTE) et la requête sur les tables de la base, visibles dans la modale ; nouvelles requêtes dans la modale (patients, complétude, unités, catégories) | S |
| 1 | Cache des concepts et stats au clic par base, plus par utilisateur (§5) | S |
| 2 | Magasin serveur : manifeste + sections, `counts` et `numeric`/`histogram` à la définition de l'extraction, migration des unités `stats-` actuelles | M |
| 3 | Sections restantes (catégoriel, unité, complétude, temporel, fréquence, services, par patient) en unités serveur ; « What to compute » dans l'onglet *Concepts* | M |
| 4 | Panneau d'un concept lu depuis le magasin ; `concept_stats_caches` retiré | S |
| 5 | Extraction du concept mapping branchée sur le magasin (sections manquantes calculées, filtrage, « profil plus récent ») | M |
| 6 | Empreinte des données, sections périmées, *Vérifier* / *Recalculer* | S |
| 7 | Mode client : magasin OPFS + moteur d'unités sous DuckDB-WASM | L |
| 8 | Data catalog : totaux lus depuis `counts` (optionnel) | S |

## 7. Où on en est (2026-11-02, branche `feature/concept-profiles`)

Construit :

- étapes 0 et 1 (pourcentages, modale SQL à trois formes, cache des concepts par base) ;
- le magasin : table `concept_profiles` (serveur, `concept_profile_service`) et
  IndexedDB (client), même ligne `StoredProfile` (`lib/concept-profiles/`) ;
  valeurs exactes, sections ajoutées à la demande (`missingSections`,
  `mergeProfile`), seuils appliqués à la lecture (`filterProfile`), empreinte des
  données (`dataFingerprint` : SQL des relations + nombre de lignes de chacune) ;
- le moteur est celui de l'extraction (`extractBatch` / `extraction-runner.ts`),
  qui lit le magasin, ne calcule que ce qui manque et y range ce qu'il calcule —
  dans les deux modes ;
- onglet *Concepts* : une seule carte, étapes *Lignes*, *Patients*, *Statistiques* ;
  *Statistiques* = les profils, avec « What to compute » dans sa carte, lancés
  après les comptages ; vérifier les données → profils périmés ; le panneau d'un
  concept montre son profil quand il existe ;
- concept mapping : l'extraction lit le magasin (un lecteur sans droit d'écriture
  extrait quand même, sans rien y ranger) ; bandeau « profils plus récents » ;
- histogramme : la définition de l'extraction partout où un profil existe ;
- le classement des concepts (début d'un calcul et chaque reprise) lit les
  lignes par table dans le comptage de l'onglet *Concepts* quand il les a
  (`counted-records.ts`, route `relation-records`) ; sinon, et pour un tri par
  patients, il relit les tables ;
- cohortes : chaque table n'est cherchée que pour les concepts que le comptage y
  a trouvés (`held` de la route `relations`).
- moteur des profils en job serveur (mode serveur) : un lot = une requête (bornes
  calculées dans le SQL), toutes les requêtes du calcul planifiées après le
  classement et envoyées en un job qui continue onglet fermé ; *Reprendre*
  récupère ce qu'il a fini, *Pause* l'annule. Le job prend la file des requêtes
  lourdes requête par requête (`shareLane`).

Reste :

| St | Étape | Effort |
|---|---|---|
| 🔜 | **[À TESTER]** dans l'app : carte des profils (serveur et WASM), panneau, extraction relue depuis le magasin ; calcul en job : fermer l'onglet en cours de calcul, rouvrir, *Reprendre* ; une cohorte lancée pendant le calcul passe entre deux lots | S |
| 💤 | Reprendre tout seul à la réouverture de l'onglet un calcul laissé sur le serveur (aujourd'hui : un clic sur *Reprendre*) | S |

| 💤 | Data catalog : totaux lus depuis le magasin | S |

