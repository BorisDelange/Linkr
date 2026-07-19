# Export / versioning côté serveur (mode fullstack)

> Document de conception. **Rien n'est implémenté** — c'est un plan à valider avant tout code.
>
> **Motivation.** En mode fullstack, le navigateur construit aujourd'hui l'intégralité des
> ZIP d'export/versioning (DB→fichiers), puis les **upload** au serveur qui se contente de
> les committer/pusher. Pour un mapping project de ~180 k concepts, ça charge lourdement le
> client (lecture des données, DuckDB, JSZip, upload de plusieurs Mo) alors que le but du
> fullstack est justement de **décharger le navigateur**. On veut déplacer la construction
> côté serveur **quand un serveur existe**.
>
> **Contrainte cardinale.** Le déploiement **front-only / WASM n'a pas de serveur**. La
> logique d'export TS ne peut donc pas être *supprimée* — au mieux *court-circuitée* quand
> `isServerMode()`. Voir §3 : c'est ce qui rend un « tout serveur » naïf dangereux (deux
> implémentations DB→fichiers à garder identiques, sous peine de faux diffs git).
>
> **Avancement :**
> - **[À FAIRE]** tout. Ce document est la première étape.
> - **Débloqué en attendant** : le scope du `entries.json` par projet (« point 2 » de la
>   discussion d'origine) est **reporté ici** — inutile de le coder en TS si l'export part
>   côté serveur ; ce sera un simple `SELECT` (voir §6).

---

## 0 — Périmètre

Concerne **tous les scopes versionnables** (dispatch actuel : [git-sync-store.ts:37-73](../../apps/web/src/stores/git-sync-store.ts)) :

| Scope | Builder client actuel | Dépend de données lourdes ? |
|---|---|---|
| `projects` | `buildProjectZip` ([entity-io.ts:384](../../apps/web/src/lib/entity-io.ts)) | Oui — blobs datasets (raw files) |
| `workspaces` | `buildWorkspaceZip` ([entity-io.ts:1567](../../apps/web/src/lib/entity-io.ts)) | Oui — réutilise buildProjectZip + mapping folders |
| `mapping-projects` | `buildMappingProjectZip`/`Folder` ([export.ts:594,734](../../apps/web/src/lib/concept-mapping/export.ts)) | Oui — source-concepts.csv, scores.parquet, source-concept-ids, DuckDB (Export tab uniquement) |
| `sql-script-collections` | `buildSqlCollectionZip` ([entity-io.ts:1264](../../apps/web/src/lib/entity-io.ts)) | Non — métadonnées + scripts |
| `etl-pipelines` | `buildEtlPipelineZip` ([entity-io.ts:1278](../../apps/web/src/lib/entity-io.ts)) | Non |
| `data-catalogs` | `buildDataCatalogZip` ([entity-io.ts:1303](../../apps/web/src/lib/entity-io.ts)) | Non |
| `dq-rule-sets` | `buildDqRuleSetZip` ([entity-io.ts:1330](../../apps/web/src/lib/entity-io.ts)) | Non |
| `schema-presets` | `buildSchemaPresetZip` ([entity-io.ts:1354](../../apps/web/src/lib/entity-io.ts)) | Non |
| `user-plugins` | `buildUserPluginZip` ([entity-io.ts:1388](../../apps/web/src/lib/entity-io.ts)) | Non |

**Deux sorties partagent ces builders** : le bouton **Export** (téléchargement d'un ZIP) et
le **git sync** (upload puis commit/push serveur). Elles doivent produire un ZIP **identique**
pour un même état — sinon changer de méthode d'export fabrique un faux diff git.

---

## 1 — Modèle actuel (ce sur quoi on s'appuie)

- **Front = toute la logique DB→fichiers.** Chaque builder lit la façade `Storage`
  (`getStorage()`, IndexedDB en front-only ou l'adaptateur API en serveur), assemble un
  `JSZip`, calcule `.gitattributes`/LFS ([entity-io.ts:1252](../../apps/web/src/lib/entity-io.ts)),
  inline l'organisation ([entity-io.ts:1234](../../apps/web/src/lib/entity-io.ts)).
- **Serveur = octets opaques.** [git_service.py](../../apps/api/app/services/git_service.py)
  déballe le ZIP reçu dans un working tree (`_unpack_zip_into`), `fetch` le remote pour
  comparer, `status`/`diff`/`commit_push`. Il **ne sait pas ce qu'est un « mapping »**.
- **Seule construction de ZIP côté serveur aujourd'hui** : `clone_to_zip`
  ([git_service.py:990-1051](../../apps/api/app/services/git_service.py)) — clone un remote et
  le zippe. C'est le seul modèle serveur à imiter (`io.BytesIO` + `zipfile`).
- **Repos git serveur** : sous `data_dir/<kind>/<id>/versioning` (projets sous
  `project_fs.cache_dir(uid)/versioning`).
- **Détection serveur** : `isServerMode()` = `!!VITE_API_URL`
  ([api-client.ts:8](../../apps/web/src/lib/api-client.ts)).
- **Import = symétrique et 100 % client** : le serveur ne parse jamais un ZIP d'import
  (`parseProjectZip`/`parseWorkspaceZip`/`importProjectContent`). Hors périmètre direct,
  mais à garder en tête (§7).

---

## 2 — Le vrai enjeu : ne pas dupliquer la logique DB→fichiers

Le piège d'un « tout côté serveur » naïf : réécrire `buildProjectZip` & co en Python, **en
plus** de les garder en TS pour le front-only. On aurait alors **deux implémentations** de la
projection DB→fichiers. La moindre divergence (ordre des clés JSON, tri, formatage CSV,
gestion LFS) produit des ZIP différents → **faux diffs git** entre un client front-only et un
client serveur travaillant sur le même dépôt. C'est exactement le problème de cohérence qui a
motivé ce chantier, transposé au niveau des deux moteurs.

**Conséquence de conception :** il faut soit (a) une source unique de vérité pour le *format*
d'export, soit (b) un contrat de format testé des deux côtés (golden files). Voir les options
§4.

---

## 3 — Ce qui doit rester client, quoi qu'il arrive

- **Tout l'export front-only** (`isServerMode() === false`). Sans serveur, les builders TS
  sont la seule option. On ne peut donc que *court-circuiter* en mode serveur, jamais
  supprimer.
- **L'extraction DuckDB** des concepts source d'un mapping project sur data source **DB**
  ([export.ts:669-686](../../apps/web/src/lib/concept-mapping/export.ts)) : DuckDB-WASM est
  dans le navigateur. Note : ce chemin n'est **pas** sur la route git aujourd'hui
  (`buildMappingProjectZip` ne passe pas `queryDataSource`) — seul le bouton Export l'utilise.
  Donc migrer le git ZIP côté serveur **n'oblige pas** à porter DuckDB.
- **L'import** (parse ZIP→DB) reste client (§7).

---

## 4 — Options d'architecture

### Option A — Builder serveur en Python, front-only garde le sien (duplication assumée)

Réécrire chaque `buildXxxZip` en Python, lisant les données sur disque
(`_tree.json` + fichiers de contenu, cf. fullstack-storage-plan §01) + la base. En mode
serveur, le front n'appelle plus le builder : il demande au serveur « construis et
commit/push » (ou « construis et renvoie-moi le ZIP » pour le bouton Export).

- **+** Décharge réellement le navigateur (aucune donnée lourde ne descend).
- **+** Le git ZIP est construit là où vivent déjà les repos et les données.
- **−** Deux implémentations DB→fichiers → risque de divergence de format (§2). À maîtriser
  par des **golden ZIP tests** partagés (mêmes entrées → mêmes octets, vérifié en CI des
  deux côtés).
- **−** Chantier conséquent : 9 scopes.

### Option B — Builder serveur seulement pour les scopes lourds, léger reste client

Porter côté serveur uniquement `projects` / `workspaces` / `mapping-projects` (les seuls qui
transfèrent des Mo). Les 6 scopes légers (SQL, ETL, catalogs, DQ, presets, plugins = quelques
Ko de JSON) restent construits client puis uploadés — c'est déjà négligeable.

- **+** Concentre l'effort là où le gain existe.
- **+** Moins de surface Python à maintenir.
- **−** Toujours de la duplication sur les 3 scopes lourds (mêmes golden tests requis).
- **−** Deux comportements selon le scope (à documenter).

### Option C — Contrat de format unique, un seul moteur « logique », deux « emballeurs »

Extraire la logique DB→fichiers en une **description déclarative** (liste de `{path, contenu}`
par entité) indépendante de JSZip/zipfile. Le front l'emballe en JSZip ; le serveur la
réimplémente une fois en emballeur Python. La *logique* (quoi mettre, comment sérialiser) est
spécifiée une fois (schéma + golden files), les *emballeurs* sont triviaux.

- **+** Réduit la divergence à la couche emballage (petite, testable).
- **−** Refactor initial du front pour séparer « liste de fichiers » et « emballage ».
- **−** Ne supprime pas la double implémentation de la *sérialisation* (JSON/CSV) — juste la
  circonscrit.

### Option D — Statu quo amélioré : garder client, mais éviter les allers-retours inutiles

Ne pas migrer ; à la place, réduire le coût client (streaming, ne pas re-télécharger les
blobs déjà côté serveur, cache). Le moins ambitieux ; ne répond pas vraiment à l'objectif
fullstack mais coûte peu.

---

## 5 — Recommandation (à valider)

**Option B, avec des golden ZIP tests** comme garde-fou de cohérence, et en s'appuyant sur
`clone_to_zip` comme modèle d'emballage serveur. Raisons :

1. Le gain est **concentré** sur 3 scopes ; les 6 légers ne justifient pas de code Python.
2. Les golden tests (mêmes entrées → mêmes octets, vérifiés côté TS **et** Python en CI)
   neutralisent le risque de divergence de format — c'est le point dur (§2).
3. On peut **livrer par étapes** (un scope à la fois) sans big-bang.

À trancher explicitement avant code : **A vs B vs C**, et l'ampleur acceptable de Python.

---

## 6 — Cas mapping project + `entries.json` (le « point 2 » reporté)

Une fois l'export mapping project côté serveur :

- `source-concepts.csv` : déjà côté serveur (blob store) → le serveur le lit directement.
- `scores.parquet` : déjà côté serveur (blob store), opt-in, jamais versionné.
- `source-concept-ids/entries.json` **scopé au projet** : devient un **`SELECT`**. Le registre
  est en base (`source_concept_id_entries`, [source_concept_id_service.py](../../apps/api/app/services/source_concept_id_service.py)) ;
  les concepts du projet sont dans son dictionnaire source (sur disque) + ses mappings (en
  base). Le scope = `entries WHERE (vocab, code) ∈ concepts(projet)` — pur SQL/jointure côté
  serveur, **zéro DuckDB navigateur**. C'est la raison pour laquelle on n'a **pas** codé ce
  scope en TS : il sera trivial ici.
- Invariant à préserver : un `sourceConceptId` est **global par `(vocab, code)`** dans un
  workspace (vérifié en base). L'import côté client applique déjà `reconcileImportedEntries`
  (garde l'id local). Si l'import migre un jour côté serveur (§7), reproduire cette règle.

---

## 7 — Import (hors périmètre immédiat, à cadrer plus tard)

L'import (ZIP→DB) est aujourd'hui **100 % client** et symétrique de l'export. Le migrer côté
serveur est un **chantier jumeau** (parseurs Python de `_tree.json` + contenu), avec les mêmes
enjeux de duplication/cohérence. À traiter **après** l'export, dans un document séparé, une
fois le contrat de format (§4) stabilisé.

---

## 8 — Étapes proposées (si Option B validée)

1. **Contrat de format + golden tests** : figer, pour un scope pilote (mapping project),
   l'ensemble `{path → octets}` attendu ; générer un golden ZIP depuis le front actuel ;
   écrire un test TS (le front reproduit le golden) et un test Python (le futur builder
   reproduit le golden). C'est le filet anti-divergence (§2).
2. **Endpoint serveur `build+commit/push`** pour le mapping project : le serveur construit le
   ZIP (modèle `clone_to_zip`) et enchaîne sur le flux git existant, sans upload client.
3. **Endpoint serveur `build→download`** pour le bouton Export (mode serveur) : renvoie le ZIP
   construit côté serveur (le front ne fait que déclencher + télécharger).
4. **Bascule côté client** : en `isServerMode()`, `buildZipUncached`
   ([git-sync-store.ts:37](../../apps/web/src/stores/git-sync-store.ts)) et le bouton Export
   appellent le serveur au lieu des builders TS. Front-only : inchangé.
5. **entries.json scopé** (§6) intégré au builder serveur du mapping project.
6. **Étendre** à `projects` puis `workspaces` (réutilise le mapping folder serveur).
7. (Plus tard) **Import serveur** (§7), document séparé.

---

## 9 — Risques / points ouverts

- **Divergence de format TS vs Python** → golden tests obligatoires (§2, §8.1).
- **LFS/`.gitattributes`** : la résolution LFS opt-in ([git-lfs.ts]) doit produire le même
  `.gitattributes` des deux côtés (inclure dans les golden tests).
- **Ordre déterministe** : tris déjà en place côté TS (mappings, entries) à répliquer à
  l'octet près côté Python.
- **Organisation inline** (`attachEntityOrganization`) : même sérialisation des deux côtés.
- **`buildMappingProjectZip` git ≠ Export tab** aujourd'hui (scores off, pas de DuckDB) : le
  builder serveur doit reproduire **exactement** la variante git, pas la variante Export tab,
  pour la cohérence des diffs.
- **Interaction avec le pull** ([git-sync-plan.md](git-sync-plan.md)) : le pull calcule le
  diff métier **côté front** (LOCAL=export front). Si l'export passe serveur, vérifier que le
  pull dispose toujours d'une projection LOCAL cohérente (soit le serveur expose l'arbre, soit
  le front garde un builder pour la comparaison). **À arbitrer** — c'est le couplage le plus
  subtil.
