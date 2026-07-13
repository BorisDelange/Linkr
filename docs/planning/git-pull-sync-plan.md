# Versioning : passer du push-only au pull (sync bidirectionnel)

> Document de conception + suivi d'implémentation.
>
> **Périmètre confirmé : le pull ne concerne QUE les mapping projects.** Pour tous les
> autres scopes versionnables (projects, sql-collections, etl-pipelines, data-catalogs,
> dq-rule-sets, schema-presets, user-plugins, workspaces), le pull sera **revu au cas par
> cas plus tard** — chaque type a des familles de contenu différentes et mérite sa propre
> stratégie de merge. La détection (bandeau behind/diverged) reste, elle, généralisable.
>
> **Avancement :**
> - **[FAIT]** Détection : table `git_sync_state`, bandeau behind/diverged, ancrage à
>   l'import, sync-state serveur léger (sans ZIP). Commits `2503da91`, `5521e1bc`,
>   `d9b08e43`.
> - **[EN COURS]** Pull mapping project (§3), par sous-étapes :
>   - **[FAIT]** merger pur `concept-mapping/merge.ts` + tests ; endpoint `pull-preview`
>     (BASE+REMOTE) + test backend.
>   - **[TODO]** UI de résolution `PullResolveDialog`.
>   - **[TODO]** écriture en base des choix + MAJ de l'ancre.

---

## 0 — Le problème, formulé

Trois besoins, du plus simple au plus dur :

1. **Détection** — l'onglet Versioning doit signaler « le remote a bougé, tu n'es plus
   synchronisé » (des commits existent en amont qu'on n'a pas).
2. **Résolution intelligente** — faire visualiser à l'utilisateur *ce qui a changé au
   niveau métier* (pour un mapping project : quels mappings ajoutés / modifiés /
   supprimés, pas quel diff de lignes CSV) et lui permettre de **résoudre les conflits
   dans une UI d'entité**, pas fichier-par-fichier — pour préserver la cohérence interne
   de chaque élément (un mapping project reste un tout, pas 4 fichiers indépendants).
3. **Fichiers étrangers** — comment traiter les fichiers présents dans le repo mais **non
   gérés par l'appli** (un `notes.md` ajouté à la main, un `.gitlab-ci.yml`, un dossier
   `analysis/` d'un collègue).

Le fil rouge : **l'appli ne versionne pas des fichiers, elle versionne des entités**.
Le git tree est une *projection* de la base (l'export). Un pull ne peut donc pas être un
simple `git merge` : il faut reprojeter les fichiers entrants vers des objets métier,
differ *ces objets*, et n'écrire en base que ce que l'utilisateur accepte.

---

## 1 — Rappel du modèle actuel (ce sur quoi on s'appuie)

- Le **front** possède la logique DB→fichiers : `buildProjectZip` / `buildWorkspaceZip` /
  `buildMappingProjectZip` (dans [entity-io.ts](../../apps/web/src/lib/entity-io.ts) et
  [concept-mapping/export.ts](../../apps/web/src/lib/concept-mapping/export.ts)). Il
  possède aussi la logique fichiers→DB : `parseProjectZip`, `importProjectContent`,
  `parseWorkspaceZip`, la reconstitution mapping (`restoreFileSourceDataFromCsv`, parse
  des `mappings.json`).
- Le **backend** ([git_service.py](../../apps/api/app/services/git_service.py)) ne connaît
  que des octets : il déballe un ZIP dans un working tree, `fetch` le remote pour comparer,
  commit, push. Il ne sait pas ce qu'est un « mapping ».
- `_sync_remote_branch` **fetch déjà** `origin/<branch>` et reset l'index dessus (pour que
  le status compare l'export vs le contenu distant réel). **La brique de lecture du remote
  existe donc déjà** — elle est juste utilisée aujourd'hui uniquement comme référence de
  diff, jamais réinjectée en base.

Conséquence architecturale forte : **le diff métier se calcule côté front**, parce que
c'est le front qui sait transformer des fichiers en entités. Le backend fournit les
*octets* des deux côtés (remote HEAD vs local export) ; le front les reprojette et diffe.

---

## 2 — Détection de désynchronisation (besoin 1)

Le moins cher, à faire en premier. On veut un indicateur « ahead / behind / diverged ».

### Ce qu'il faut savoir

- **behind** = le remote a des commits qu'on n'a pas (quelqu'un a poussé).
- **ahead** = on a des changements locaux non poussés (déjà couvert par le status actuel).
- **diverged** = les deux (le cas conflictuel).

Aujourd'hui on ne stocke pas « le dernier commit sur lequel on était synchro ». Pour
distinguer *behind* de *diverged*, il faut une **base commune** (merge-base). Deux options :

- **(A) Persister le dernier OID synchronisé** par entité (`git_synced_oid`), écrit à
  chaque commit/push et à chaque pull résolu. `behind` = `remote HEAD != synced_oid` et
  `synced_oid` est ancêtre de remote HEAD. `diverged` = ni l'un ni l'autre n'est ancêtre.
- **(B) Sans état persistant** : `git fetch` puis `merge-base --is-ancestor` entre le HEAD
  local du working tree de versioning et remote HEAD. Fragile — le working tree local est
  reconstruit à chaque opération (`_unpack_zip_into` wipe tout), donc son historique n'est
  pas fiable comme référence.

→ **Décision (A), table dédiée partagée** (validé). Une **seule** table
`git_sync_state(scope, entity_id, branch, synced_oid, checked_at)`, clé
`(scope, entity_id, branch)`, **commune à tous les scopes versionnables** (projects,
mapping-projects, sql-collections, etl-pipelines, data-catalogs, dq-rule-sets,
schema-presets, user-plugins, workspaces) — mêmes scopes que les repo-getters de
`git_service.py`. Évite d'ajouter une colonne à 9 tables et de multiplier les migrations
quand on généralisera le pull. C'est l'ancre qui rend *tout* le reste calculable proprement
(behind/ahead/diverged, et le 3-way merge). Elle est écrite au push et à chaque pull résolu.

### API

Nouveau `GET`/`POST` léger `…/sync-state` (ou étendre `gitStatus`) qui, en plus des fichiers
locaux modifiés, renvoie :

```
{ ahead: bool, behind: bool, remoteHead: oid|null, syncedOid: oid|null,
  remoteAheadBy: int }   // nb de commits d'avance du remote (best-effort)
```

Le backend : `_sync_remote_branch` fait déjà le fetch ; il suffit de comparer `FETCH_HEAD`
à `syncedOid` via `merge-base --is-ancestor` (deux appels, pas cher).

### Initialisation de l'ancre (import & git-link)

Question : **l'import via git pose-t-il déjà l'ancre ?** Non, et il ne *peut* pas le faire
au moment du clone : `/clone` renvoie un ZIP mais l'entité n'existe pas encore (le front
lui donne un id juste après, via `createBatch`), et `clone_to_zip` ne remonte pas l'OID
cloné. L'ancre est indexée `(scope, entity_id, branch)` → à écrire **après** création de
l'entité, ou à poser paresseusement. Deux stratégies :

- **(A) Explicite** — `/clone` remonte le HEAD ; le front appelle `POST …/sync-state` après
  `createBatch`. Fidèle mais couple l'import au versioning + un aller-retour de plus.
- **(B) Lazy, auto-cicatrisante** *(retenu)* — on n'écrit rien à l'import. Au **premier**
  calcul de sync-state d'une entité **sans** ligne `git_sync_state` : si l'export local est
  **identique** au remote HEAD (aucun fichier local modifié), on **adopte remote HEAD comme
  `synced_oid`** (on vient d'importer, on est synchro). Sinon on laisse `synced_oid = null`
  → l'UI dit « première synchro » plutôt qu'un faux « en retard ».

(B) gagne : marche aussi pour les entités **déjà importées avant cette feature** (pas de
migration de données) et pour un git-link ajouté **après coup** à une entité existante.
De toute façon **le premier push écrit `synced_oid` explicitement** — le lazy ne sert qu'à
couvrir proprement la fenêtre « importé, jamais encore poussé ».

### UI

Bandeau dans l'onglet Versioning : « ⟳ N modification(s) en amont — mettre à jour ».
Coûte peu, gros gain de clarté. **On peut livrer ça seul, sans la résolution**, comme
première itération (détecter d'abord, résoudre ensuite).

---

## 3 — Le pull intelligent (besoin 2) — le cœur

### 3.1 Principe : diff **d'entités**, pas de fichiers

Le pull produit trois arbres logiques :

- **BASE** = l'état à `synced_oid` (dernier point de synchro connu). Reprojeté en entités.
- **REMOTE** = l'état à `remote HEAD` (ce qui arrive). Reprojeté en entités.
- **LOCAL** = l'état actuel en base (ce que l'utilisateur a peut-être modifié depuis).

**« 3-way » = merge à trois versions**, par opposition à comparer seulement 2. En croisant
BASE↔REMOTE (« ce qu'*ils* ont changé ») et BASE↔LOCAL (« ce que *j'*ai changé »), on
distingue automatiquement qui a bougé : si un seul côté a changé, on applique sans
demander ; le conflit n'existe que quand **les deux** ont modifié la même chose
différemment depuis la BASE. Sans BASE (merge 2-way), toute différence ressemblerait à un
conflit. C'est le principe de `git merge`, appliqué ici à des **objets métier** (mappings,
champs) et non à des lignes de texte — d'où « au niveau objet » :

| BASE | REMOTE | LOCAL | Résultat |
|---|---|---|---|
| — | ajouté | — | **ajout distant** → proposer d'ajouter |
| présent | modifié | inchangé | **update distant propre** → appliquer |
| présent | inchangé | modifié | **modif locale seule** → garder local (rien à faire) |
| présent | modifié (≠) | modifié (≠) | **CONFLIT** → choix utilisateur (leur / mien / champ-par-champ) |
| présent | supprimé | inchangé | **suppression distante** → proposer de supprimer |
| présent | supprimé | modifié | **CONFLIT** (supprimé chez eux, édité chez moi) |

**Périmètre v1 : mapping project uniquement** (cas d'usage phare, cf. thèse INDICATE).
L'utilisateur chargera le même mapping project dans 2 workspaces pour tester pull/push.

Un mapping project n'est **pas** qu'une liste de mappings : le merger doit couvrir **toutes
ses familles**, chacune avec sa propre stratégie de merge (décidées avec l'utilisateur) :

| Famille | Fichier(s) | Unité | Stratégie de merge |
|---|---|---|---|
| **Mappings** | `mappings.json` | un mapping (clé = voir §3.1.1 — **PAS** `id`) | **3-way ligne par ligne**, résolution **par mapping** : ajout/modif/suppr propres appliqués ; conflit = choix binaire *le mien* / *le leur* **pour ce mapping** (« prends celui poussé ailleurs, garde le mien pas encore committé »). |
| **Source concepts** | `source-concepts.csv` (souvent LFS) | la liste entière | **En bloc** : choix *mien* / *leur* pour toute la liste (pas de résolution ligne à ligne). Mais afficher des **infos + un aperçu** avant de choisir : nombre de lignes local vs distant, et les **100–1000 premières lignes ajoutées / supprimées** (même esprit que le diff hunks) pour comprendre ce qui change. |
| **Similarity scores** | `similarity-scores.parquet` (LFS) | la liste entière | **Version distante en bloc** (donnée dérivée/recalculable). Afficher des **infos de diff** avant de remplacer : nombre de scores local vs distant, date de modification. Pas de conflit possible. |
| **Métadonnées** | `project.json` (nom, description, badges…) | chaque champ | **3-way par champ** ; conflit = les deux ont changé le même champ depuis la base → choix *mien* / *leur* **par champ** (garder mon nom, prendre leur description). |

→ Un **merger dédié mapping project** ([concept-mapping/merge.ts]) sait (a) reprojeter un
tree de fichiers en ces familles, (b) apparier/differ selon la stratégie de chaque famille,
(c) produire une liste de changements proposés + conflits. La généralisation aux autres
scopes (projects, SQL, ETL…) est **hors périmètre v1** — on valide toute l'infra sur le
mapping project d'abord.

### 3.1.1 La clé d'appariement des mappings (vérifié dans le code)

Décisif pour tout le merge. **Le `id` d'un mapping n'est PAS stable entre instances** :
à l'import, `MappingProjectListPage.doImport` régénère `id: crypto.randomUUID()` pour
chaque mapping. Donc l'`id` dans le `mappings.json` distant (REMOTE) ne correspond à aucun
`id` local (LOCAL) — l'appariement par `id` échoue systématiquement (tout paraîtrait
« ajouté chez eux + supprimé chez moi »).

L'identité stable inter-instances est le **concept source**. Mais la table
`concept_mappings` n'a **aucune contrainte d'unicité** sur la source → un même concept
source peut avoir **plusieurs mappings** (plusieurs cibles). Deux clés possibles :

- **(K1) source seule** : `sourceConceptId | sourceVocabularyId | sourceConceptCode`.
  - *Re-cibler* un concept (changer sa target) = **une modification** (intuitif).
  - Mais si un concept a **plusieurs targets**, K1 les confond (ne distingue pas « j'ai
    ajouté une 2ᵉ cible » de « j'ai changé la cible ») → appariement ambigu, voire
    plusieurs mappings LOCAL/REMOTE pour la même clé (indécidable proprement).
- **(K2) source + target** : `…source… → targetConceptId | targetVocabularyId | targetConceptCode`.
  - Gère nativement le multi-cibles (chaque paire est une unité distincte).
  - Mais *re-cibler* un concept devient **une suppression + un ajout** (moins intuitif à
    lire, mais sémantiquement exact : l'ancienne paire n'existe plus, une nouvelle apparaît).

**Décision : K2** (source + target) — validé. Le modèle autorise le multi-cibles et K1 y
devient ambigu. Le coût (re-cibler = suppr+ajout) est acceptable et se corrige à
l'affichage : on peut *détecter* qu'une suppression et un ajout partagent la même source et
les présenter comme « cible modifiée » dans l'UI, sans compliquer la clé de merge.

Clé exacte : `${sourceConceptId}|${sourceVocabularyId}|${sourceConceptCode}»→»${targetConceptId}|${targetVocabularyId}|${targetConceptCode}`
(les champs nuls normalisés en chaîne vide, pour un appariement déterministe).

*(Champs comparés pour un « modifié » sous K2 : equivalence, status, comments, reviews,
mappedBy/reviewedBy + détails, reviewComment, matchScore — pas les timestamps ni les `id`.)*

### 3.2 Où tourne le merge ?

Le backend sait produire les octets des trois arbres :

- LOCAL = l'export actuel (déjà construit par le front, uploadé, ou reconstruit).
- REMOTE = `git show remote/<branch>:<path>` pour chaque fichier (fetch déjà fait).
- BASE = `git show <synced_oid>:<path>`.

Le **front** fait la reprojection + le diff objet (il a `parseMappingProjectFolder` &
consorts). Donc :

1. Backend expose un endpoint `pull-preview` qui renvoie, pour l'entité, **les trois
   versions de chaque fichier managé** (ou un ZIP par version — réutilise
   `clone_to_zip`/`_unpack` machinery). Pour les gros fichiers LFS : renvoyer résolus
   (le pull *veut* le contenu, contrairement au status qui skip le smudge).
2. Front reprojette BASE/REMOTE/LOCAL en entités, calcule le 3-way, renvoie une structure
   de « changements proposés » à afficher.
3. UI de résolution (voir 3.3).
4. À la validation, le front **écrit en base** les changements acceptés (via les stores /
   API entité existants — createBatch, update, deleteOrphans pour un mapping project), puis
   marque `synced_oid = remote HEAD`. **Aucun `git merge` n'écrit jamais la DB directement.**

> Point subtil : après un pull, le contenu en base a changé → un futur export/push
> produira un tree cohérent avec le remote. Le pull ne fait donc **pas** de commit git ;
> il met à jour la base + l'ancre `synced_oid`. Le prochain push normal reflètera l'état
> fusionné. (Alternative : committer un merge côté serveur pour tracer la fusion dans
> l'historique git — à décider ; pas nécessaire pour la cohérence des données.)

### 3.3 UI de résolution (au niveau entité)

Réutiliser l'esprit de [GitDiffDialog](../../apps/web/src/components/versioning/GitDiffDialog.tsx)
mais **orientée objets**, pas Monaco/texte :

Sections par famille, chacune avec sa granularité :

- **Métadonnées** — les champs en conflit listés (nom / description / badges), chacun avec
  un toggle *mien* / *leur* et un aperçu des deux valeurs.
- **Mappings** — liste groupée **Ajouts distants** / **Modifiés** / **Supprimés** /
  **Conflits**. Chaque ligne = un mapping lisible (`source → target` + badge : target
  changée, statut changé, commentaire ajouté…). Ajouts/modifs/suppr propres cochés par
  défaut (« Tout appliquer »). Chaque conflit = choix *garder le mien* / *prendre le leur*
  **pour ce mapping** ; mini-diff côte-à-côte des champs (source, target, equivalence,
  statut, reviewer) — pas de Monaco.
- **Source concepts** — un seul bloc : « la liste distante diffère (N lignes local vs M
  distant) » → choix *garder ma liste* / *prendre la leur*, mais avec un **aperçu déroulable
  des différences** : les 100–1000 premières lignes ajoutées / supprimées (calculées comme
  le diff hunks du versioning), pour comprendre avant de choisir en bloc.
- **Similarity scores** — notice : « scores distants : M (modifiés le …), locaux : N » →
  case *remplacer par les scores distants* (par défaut si le remote en a).

C'est là que « résoudre au niveau graphique et pas fichier » prend tout son sens : on ne
montre jamais le CSV/JSON brut, on montre des mappings et des champs métier.

---

## 4 — Fichiers étrangers (besoin 3)

Un repo partagé peut contenir des fichiers **hors périmètre de l'appli**. Il faut une
règle claire, sinon soit on les écrase (perte de données d'un collègue), soit on les tire
en base sans savoir quoi en faire.

### Définir « managé »

Un fichier est *managé* s'il correspond à un chemin que l'export produit pour ce scope
(`project.json`, `mappings.json`, `dashboards/**`, `scripts/**`, `README.*`,
`.gitattributes`, `.gitignore`, la source CSV/parquet…). Tout le reste est **étranger**.
On a déjà une classification de fichiers ([git-file-meta.ts](../../apps/web/src/lib/git-file-meta.ts),
[git-file-classify.ts](../../apps/web/src/lib/git-file-classify.ts)) — l'étendre d'un
prédicat `isManaged(scope, path)` (par défaut : catégorie `other` = étranger).

### Règle de traitement

| Situation | Comportement |
|---|---|
| **Push sélectif** (cas UI normal, `paths` fourni) | `_stage_paths` ne stage QUE les chemins cochés. Un fichier étranger n'est jamais dans `paths`, donc jamais stagé ni supprimé : HEAD (= FETCH_HEAD) le conserve → **il survit.** ✅ Pas de problème dans ce chemin. |
| **Push « tout committer »** (`paths is None` → `git add -A`) | `_unpack_zip_into` a wipé le fichier étranger du disque **avant** l'`add -A`, qui enregistre alors sa **suppression**. ⚠️ **Bug réel mais limité à ce chemin** : le mode « tout committer » efface les fichiers étrangers du remote. Correctif : ne pas faire `git add -A` sur un tree wipé — stager explicitement les chemins managés (comme `_stage_paths`) et gérer les suppressions managées à la main, en laissant les étrangers intacts. |
| **Pull** | Les fichiers étrangers du remote sont **ignorés par le merge d'entités** (on ne sait pas les mapper en base). On les **laisse dans le working tree git** (ils restent versionnés), mais ils n'entrent jamais dans la DB. |
| **Affichage** | Les lister dans l'UI de sync sous une section « Fichiers hors application (non gérés) » en lecture seule, pour transparence : l'utilisateur voit qu'ils existent, comprend qu'ils ne sont ni importés ni écrasés. |

> **Analyse confirmée en lisant le code** ([git_service.py:355-361](../../apps/api/app/services/git_service.py#L355-L361)
> pour le wipe, [604-611](../../apps/api/app/services/git_service.py#L604-L611) pour le
> staging) : le flux UI habituel passe un `paths` explicite → `_stage_paths` → les fichiers
> étrangers survivent. Le seul chemin dangereux est `paths is None` (`git add -A` sur un
> tree wipé). C'est donc un **correctif ciblé et à faible risque** (remplacer le `add -A`
> par un staging explicite des chemins managés), à faire avant le pull car c'est une
> question de sûreté des données, pas une feature.

---

## 5 — Découpage en itérations

1. **Détection seule** (§2). Table `git_sync_state` + endpoint sync-state + bandeau
   « N commit(s) en amont ». Écrit `synced_oid` au push. **Livrable autonome, faible risque.**
2. **Préserver les fichiers étrangers au push** (§4). Correctif ciblé du chemin
   `paths is None` (`add -A`). Sûreté des données, indépendant, à faire tôt.
3. **Pull mapping project** (§3) : merger dédié couvrant les 4 familles (mappings ligne à
   ligne, source concepts en bloc, scores distants en bloc, métadonnées par champ),
   endpoint `pull-preview` (3 versions des fichiers managés, LFS résolu), UI de résolution
   objet, écriture en base via les API mapping existantes, MAJ `synced_oid`. **Le gros
   morceau — c'est le périmètre v1.**

*(Hors v1, notés pour mémoire : généralisation aux autres scopes ; fusion fine
champ-par-champ des mappings ; commit de merge git.)*

---

## 6 — Décisions prises (validées avec l'utilisateur)

- **Périmètre v1** : **mapping project uniquement**. Test : même projet chargé dans 2
  workspaces, pull/push entre eux. Généralisation aux autres scopes hors périmètre.
- **Merge git** : **non**. Le pull écrit la DB + déplace `synced_oid` ; le prochain push
  reflète la fusion. Pas de commit de merge côté serveur.
- **Similarity scores** : **version distante en bloc** (donnée recalculable), avec infos de
  diff affichées (nombre local vs distant, date de modif) avant remplacement.
- **Source concepts** : merge **en bloc** (mien / leur pour la liste entière).
- **Mappings** : résolution **par mapping** (ligne par ligne) — conflit = choix binaire
  *le mien* / *le leur* pour ce mapping.
- **Métadonnées** : conflit résolu **par champ** (nom / description / badge indépendants).

- **Ancre de synchro** : **table dédiée partagée** `git_sync_state(scope, entity_id,
  branch, synced_oid, checked_at)`, commune à tous les scopes (validé). Écrite au push et
  au pull résolu.
- **Source concepts** : merge en bloc, mais avec **aperçu des différences** (nb de lignes
  local vs distant + 100–1000 premières lignes ajoutées/supprimées) avant de choisir —
  même exigence de lisibilité que les similarity scores.

---

## 7 — Ce que ça touchera (prévisionnel)

- **Backend** : `git_service.py` (endpoints sync-state + pull-preview ; correctif push
  fichiers étrangers), schémas `git.py`, modèle/migration `git_sync_state`, routes
  mapping-project.
- **Front** : extension de `git-sync-store` (ou nouveau `git-pull-store`), le merger
  `concept-mapping/merge.ts` couvrant les 4 familles, une UI `PullResolveDialog` (sections
  Métadonnées / Mappings / Source concepts / Similarity scores), extension de la
  classification (`isManaged`), i18n EN+FR.
- **Tests** (logique pure, cf. CLAUDE.md) : le merger 3-way est exactement le genre de
  logique critique à couvrir — `concept-mapping/merge.test.ts` : appariement des mappings
  par clé, détection ajout/modif/suppr/conflit, résolution par champ des métadonnées,
  bloc source-concepts, choix des scores.
