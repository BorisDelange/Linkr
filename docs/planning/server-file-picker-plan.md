# Server file picker — désigner un fichier *sur le serveur* au lieu de l'uploader

**Problème.** En mode serveur (le cas majoritaire), tout point d'entrée « fichier »
de l'app suppose que le fichier est sur le PC de l'utilisateur. Pour une base
DuckDB ou un dossier Parquet posé sur le serveur par un administrateur, il n'y a
littéralement aucun moyen de la désigner : il faut la télécharger sur son poste
pour la re-téléverser. Au-delà de `max_upload_mb` (2 Go) c'est même impossible.

**Le socle existe déjà.** `ServerFolderPickerDialog` + `services/fs_browser.py`
font exactement ce navigateur serveur, avec un modèle de sécurité déjà réfléchi
(confinement `fs_browse_roots`, résolution des symlinks, re-validation au moment
de la persistance). Deux limites seulement : il ne liste **que des dossiers**, et
il est monté sous `/projects/{uid}/fs`, donc inutilisable pour une entité
workspace-scoped comme une database.

Ce plan généralise ce socle, puis le branche là où ça vaut le coup.

---

## 1. Le principe directeur

Trois façons de fournir un fichier, à ne pas confondre :

| Origine | Qui l'utilise | Sens en mode serveur |
|---|---|---|
| **Upload** (bytes copiés du PC vers le serveur) | petits fichiers d'auteur : ZIP d'import, images, scripts, `.json` | garde tout son sens |
| **Chemin serveur** (rien ne bouge, on pointe) | gros volumes de données : `.duckdb`, dossiers Parquet, vocabulaires OHDSI | **ce qui manque aujourd'hui** |
| **FS Access handles** (zéro-copie sur le PC) | dossiers Parquet en client-only | front-only, ne marchera jamais en serveur |

La règle : **le chemin serveur est l'analogue serveur du zéro-copie**. Les deux
répondent au même besoin — ne pas dupliquer des gigaoctets — chacun de son côté
de la barrière. C'est pourquoi il faut les proposer aux mêmes endroits.

Corollaire : « proposer les deux » n'est pas la réponse universelle. Un ZIP
d'import de 200 Ko vient du PC de l'utilisateur, point. Un warehouse OMOP de
40 Go est déjà sur le serveur, point. N'offrir le choix que là où les deux cas
sont réellement plausibles évite d'ajouter un onglet à 30 dialogues pour rien.

---

## 2. Le compte : où faut-il quoi ?

Inventaire complet : **32 points d'entrée** répartis sur 16 fichiers (plus les
composants partagés `ImportSourceDialog` et `AttachmentsDialog`, qui à eux seuls
couvrent 13 écrans). Classés par ce qu'ils méritent :

### A. Chemin serveur **prioritaire** — la donnée est volumineuse et vit sur le serveur

| # | Écran | Fichier | Attendu |
|---|---|---|---|
| 1 | **Databases › Add/Edit database** | `warehouse/databases/AddDatabaseDialog.tsx:1159,1248,1323` | `.duckdb`, `.sqlite`, **dossier Parquet** |
| 2 | **IDE › Connections › Add connection** | `projects/files/AddConnectionDialog.tsx:361,446,499` | idem (clone du précédent) |
| 3 | **Concept mapping › Import vocabulaire ATHENA** | `concept-mapping/ConceptSetsTab.tsx:1836` | **dossier** OHDSI (CONCEPT.csv + ~10 tables, plusieurs Go) |

Ce sont les trois cas où l'upload est aujourd'hui bloquant. (1) et (2) sont le
cœur de la demande.

### B. Les deux origines — plausibles des deux côtés

| # | Écran | Fichier | Attendu |
|---|---|---|---|
| 4 | **Datasets › Upload dataset** | `lab/datasets/UploadDatasetDialog.tsx:863` | `.csv/.parquet/.xlsx` — export produit par un script sur le serveur, *ou* fichier local |
| 5 | **Concept mapping › source fichier** | `concept-mapping/CreateMappingProjectDialog.tsx:1305,1277` | idem |
| 6 | **Mapping › Import des scores** | `concept-mapping/components/TargetConceptPanel.tsx:2502` | `.parquet` de similarités, typiquement calculé sur le serveur |
| 7 | **IDE › Upload files** | `projects/files/UploadDialog.tsx:184` | scripts — « importer depuis le serveur » a du sens dans un IDE serveur |
| 8 | **ETL › Scripts › Upload** | `warehouse/etl/EtlUploadDialog.tsx:190` | idem |

### C. Upload seul — rien à changer

Tout le reste : les 13 écrans d'import ZIP via `ImportSourceDialog` (projets,
workspaces, presets, ETL, catalogues, DQ, SQL, mapping projects, databases —
qui ont déjà un onglet Git couvrant le cas « c'est déjà sur un serveur »), les
pièces jointes images (`AttachmentsDialog`, `WikiAttachmentsDialog`), l'import
ATLAS `.json`, l'import de mappings `.json`, les concept sets `.json`, le ZIP de
plugin, les fichiers de plugin. Ce sont des artefacts d'auteur, petits, qui
viennent légitimement du poste de l'utilisateur.

**Bilan : 3 écrans prioritaires, 5 optionnels, ~24 inchangés.**

---

## 3. Ce qu'il faut construire

### Étape 1 — Généraliser `fs_browser` aux fichiers *(backend, S/M)*

`services/fs_browser.py` :

- `list_dir(path, include_files=False, extensions=None)` — ajouter les fichiers
  au listing quand demandé, avec `{name, path, is_dir, size}`. Les dossiers
  restent listés en premier. Le filtre d'extensions est un confort d'affichage,
  **jamais** un contrôle de sécurité.
- `validate_file(path, extensions)` — le pendant de `validate_dir` : existe,
  est un fichier, est *lisible*, extension attendue. Mêmes `reason` machine-readable.
- `validate_source_path(path)` — le pendant de `validate_binding_path` pour une
  database. **C'est le contrôle de sécurité réel**, appelé à la persistance.

Un point à trancher explicitement : `validate_binding_path` refuse tout si
`enable_code_execution = False`, parce qu'un dossier IDE lié *est* de l'exécution
de code. Monter une database en lecture seule ne l'est pas. Le nouveau chemin
doit donc dépendre de `fs_browse_roots` **sans** être gaté sur
`enable_code_execution` — sinon un déploiement qui a désactivé l'IDE perd aussi
la possibilité de brancher ses propres données, ce qui n'a pas de sens.

### Étape 2 — Sortir les routes de `/projects/{uid}` *(backend, M)*

C'est le vrai obstacle : les databases sont workspace-scoped, les routes
actuelles sont project-scoped et gatées sur `project-settings:write`.

Nouveau routeur `/api/v1/fs` (non imbriqué) :

| Route | Permission |
|---|---|
| `GET /fs/list-dir?path=&include_files=&extensions=` | authentifié + une permission de *contexte* passée en query (`scope=database` → `databases:write`, `scope=project&projectUid=…` → `project-settings:write`) |
| `POST /fs/validate` | idem |

Les routes `/projects/{uid}/fs/*` existantes restent (resolved, rebind-copy sont
spécifiquement project-scoped) ; `list-dir` et `validate` deviennent des alias
minces vers le service partagé, pour ne pas casser `FoldersTab`.

Le point de vigilance : ne pas transformer l'ouverture aux databases en
« n'importe quel utilisateur connecté lit le filesystem ». Chaque appel porte son
scope, et le scope détermine la permission exigée.

### Étape 3 — Un seul composant `ServerPathPickerDialog` *(front, M)*

Généraliser `ServerFolderPickerDialog` plutôt que le forker :

```ts
interface Props {
  open: boolean
  mode: 'folder' | 'file'
  /** Filtre d'affichage, ex. ['.duckdb'] ou ['.parquet'] */
  extensions?: string[]
  /** Contexte de permission — décide de la route et du gate serveur. */
  scope: { kind: 'project'; projectUid: string } | { kind: 'database' }
  initialPath?: string
  defaultPath?: string
  onClose: () => void
  onPick: (path: string) => void
}
```

En mode `file`, les fichiers sont cliquables et sélectionnent au lieu de naviguer ;
le bouton de confirmation porte sur la sélection, pas sur le dossier courant.
`FoldersTab` continue de l'utiliser en `mode="folder"`, inchangé.

**À supprimer au passage** : `FileBrowserDialog` dans
`features/settings/GeneralTab.tsx:82-230`. C'est un troisième navigateur, qui
appelle `/api/v1/filesystem/browse` — **une route qui n'existe pas** côté
backend. Il est donc cassé depuis toujours : il affiche systématiquement son
message d'erreur. (Il contient aussi un `useState(() => …)` là où un `useEffect`
était voulu, ligne 121.) Le remplacer par le composant partagé.

### Étape 4 — Databases : le mode « chemin serveur » *(full-stack, M)*

**Aucune migration Alembic n'est nécessaire.** `connection_config` est un JSON
libre, et il existe déjà un précédent exact : le drapeau `managed` y détourne la
résolution du chemin vers `managed_db.path_for()`. On suit le même patron :

```ts
// types/index.ts — DatabaseConnectionConfig
/** Server mode: an absolute server path the admin points at, instead of
 *  uploaded bytes. The file is never copied and is attached read-only. */
serverPath?: string
```

Côté backend, un seul point d'insertion — `data_source_service._source_files()`
est la seule fonction qui produit les paires `(nom, chemin)` consommées par ses
5 call-sites. Ajouter, à côté de `if is_managed(source):` :

- fichier `.duckdb`/`.sqlite` → `kind="file"`, `path` = le chemin tel quel ;
- dossier → lister les `.parquet` et passer les paires à
  `db_connect.group_parquet_tables()`, qui les accepte déjà telles quelles.

Le dossier Parquet y gagne d'ailleurs : contrairement au blob store (dont le
commentaire de `data_source_service.py:282-285` explique qu'il ne peut pas être
globé, les blobs n'ayant ni suffixe ni isolation), un vrai dossier serveur se
glob naturellement.

Deux garde-fous non négociables :

1. **Re-valider `serverPath` à chaque écriture** de la source (create *et*
   update), exactement comme `projects.py:85` le fait pour les bindings. La
   validation côté picker n'est pas un contrôle de sécurité — sans ça, un
   `PATCH` fabriqué à la main donne lecture arbitraire du filesystem serveur.
2. **Attacher en lecture seule.** `_attach_file` passe déjà `READ_ONLY` ; il
   faut que ça reste vrai pour un fichier que Linkr ne possède pas. Interdire
   qu'une source `serverPath` serve de cible ETL (`run_etl_sql` exige déjà
   `managed`, donc c'est acquis — mais à couvrir par un test).

Côté UI, dans `AddDatabaseDialog` (et son clone) : en mode serveur, un choix
d'origine — *Téléverser depuis mon poste* / *Choisir sur le serveur* — plutôt
qu'un troisième bouton noyé. En client-only, rien ne change (pas de serveur à
parcourir). L'édition affiche le chemin au lieu du badge « Server storage ».

**Décision à prendre** : que fait « Export » d'une database en `serverPath` ? Le
chemin est machine-local, comme `idePath` — il ne doit **pas** voyager. Le
traitement existant des bindings (`docs/architecture.md`, jamais exportés) est le
précédent à suivre : strippé à l'export, la database se réimporte « à
reconnecter ». À confirmer avant de coder l'étape 4.

### Étape 5 — Le doublon `AddConnectionDialog` / `AddDatabaseDialog` *(front, M)*

Les deux dialogues sont des quasi-jumeaux : chacun a sa copie de
`readParquetFiles`, de `getFileAccept`, de la logique de picker. Brancher le
chemin serveur des deux côtés en copiant-collant une troisième fois serait une
faute.

Deux options, à arbitrer :

- **(a)** extraire la zone « source de fichiers » en un composant partagé
  (`DatabaseFileSourceField`) consommé par les deux dialogues — cadré, faisable
  dans ce chantier ;
- **(b)** fusionner les deux dialogues — plus propre, mais c'est un chantier
  distinct qui déborde de ce plan.

Recommandation : **(a)** ici, et noter (b) au backlog.

### Étape 6 — Les cas de la catégorie B *(front, M)*

Une fois (a) en place, chaque écran de la catégorie B est un petit branchement :
un sélecteur d'origine + `ServerPathPickerDialog` + le chemin envoyé au backend
au lieu du sha. Le backend a besoin, pour ces cas, d'un équivalent « lis ce
fichier serveur » là où il attend aujourd'hui un blob — pour les datasets, les
scores, la source d'un mapping project.

À faire **après** avoir validé les 3 écrans prioritaires en usage réel : c'est
là qu'on saura si le sélecteur d'origine est ergonomique avant de le dupliquer
cinq fois.

### Étape 7 — Tests & doc *(S/M)*

- pytest sur le service : listing de fichiers, filtre d'extensions, confinement
  (un `..` et un symlink qui sortent d'une root), `validate_file`, et surtout
  **`validate_source_path` appelé à la persistance** (le test
  `test_validate_binding_path_enforces_browse_roots` est le modèle exact).
- pytest sur la résolution : `serverPath` fichier → `kind="file"` ; dossier →
  `parquet-folder` avec les bonnes tables ; refus comme cible ETL.
- i18n EN + FR pour toutes les nouvelles clés.
- `docs/architecture.md` : documenter `fs_browse_roots` comme le mécanisme de
  confinement — c'est le réglage que tout déploiement serveur devra poser.

---

## 4. État — lot 1 livré

| St | Étape | Effort |
|----|-------|--------|
| ✅ | Service `fs_browser` : fichiers + `validate_file` / `validate_readable_dir` / `validate_source_path` | S/M |
| ✅ | Routeur `/workspaces/{id}/fs/*` scopé sur `databases:write` ; routes projet inchangées | M |
| ✅ | `ServerPathPickerDialog` partagé (mode folder\|file, scope projet\|workspace) + `FileBrowserDialog` mort supprimé | M |
| ✅ | `DatabaseFileSource` monté par les deux dialogues d'ajout de base | M |
| ✅ | `serverPath` bout en bout (config, résolution, re-validation, lecture seule, strippé à l'export) | M |
| ✅ | Import vocabulaire ATHENA depuis un dossier serveur | M |
| ✅ | Tests (29 pytest + sanitize) + i18n EN/FR + `docs/architecture.md` | S/M |
| 🔜 | **[À TESTER]** Bout en bout dans l'app, en mode serveur — voir §6 | S |
| 🔜 | Catégorie B, écran par écran, après retour d'usage | M |

### Décisions prises

1. **Gating** — le chemin serveur ne dépend **pas** de `enable_code_execution`
   (contrairement aux bindings IDE) : attacher une base en lecture seule n'est
   pas de l'exécution de code. Un déploiement sans IDE peut brancher ses données.
2. **Export** — `serverPath` est strippé, et gratuitement :
   `EXPORTED_CONNECTION_KEYS` est une **allowlist** (front et Python), donc un
   champ non listé ne sort jamais. Épinglé par `sanitize-connection-config.test.ts`.
3. **Doublon des dialogues** — champ partagé extrait (option a). La fusion des
   deux dialogues reste au backlog.
4. **Catégorie B** — reportée après retour d'usage.
5. **Fichiers dans le picker de dossiers** — visibles mais non sélectionnables :
   un dossier se reconnaît à ce qu'il contient.

### Reste ouvert

- **`fs_browse_roots` vide = tout le filesystem** (modèle RStudio Server, assumé
  dans le code). Maintenant qu'une entité workspace y accède, faut-il poser une
  racine par défaut ? Non tranché : le changer casserait les déploiements qui
  s'appuient sur le défaut actuel.
- **Vocabulaire CSV sur le serveur** — un dossier serveur est lu via
  `read_parquet` ; un ATHENA en CSV est refusé avec un message explicite plutôt
  qu'importé vide. Le support CSV côté serveur n'a jamais existé (limite
  préexistante, pas une régression).

---

## 5. Ce qui reste à faire — catégorie B

Les 5 écrans optionnels (datasets, source de mapping project, import des scores,
upload IDE, upload ETL). Chacun demande, en plus du sélecteur d'origine, un
travail backend : lire un fichier serveur là où un blob est attendu aujourd'hui.
À faire écran par écran, une fois le lot 1 éprouvé en usage réel.

---

## 6. À tester dans l'app (mode serveur)

Rien de tout cela n'a été vérifié dans l'application qui tourne — seulement par
les tests. À faire avant de merger :

1. **Databases › Add** → *Choisir sur le serveur* → un `.duckdb` : la base se
   connecte, les tables apparaissent, une requête SQL renvoie des lignes.
2. Même chose avec un **dossier Parquet** (y compris imbriqué : `person/part-0.parquet`).
3. **Édition** : re-pointer une base vers un autre chemin, vérifier qu'elle n'est
   pas ré-importée et que l'identité (lineageId, createdAt) est intacte.
4. **Export** de cette base → vérifier qu'`entity.json` ne contient aucun chemin.
5. **IDE › Connections** : même flux, le nom se préremplit depuis le chemin.
6. **Concept mapping › vocabulaire ATHENA** depuis un dossier serveur en Parquet.
7. **Client-only** (`npm run dev` sans `VITE_API_URL`) : aucun sélecteur
   d'origine nulle part, l'upload fonctionne comme avant.
8. **Confinement** : poser `LINKR_FS_BROWSE_ROOTS=/un/dossier`, vérifier qu'on ne
   remonte pas au-dessus, et qu'un `PATCH` fabriqué à la main avec un chemin
   hors racine est refusé en 400.
