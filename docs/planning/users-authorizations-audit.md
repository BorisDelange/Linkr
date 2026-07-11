# Audit — Users & Authorizations (mode serveur / full-stack)

> **MàJ 2026-07-10 — tous les correctifs sont implémentés et committés** (branche
> `feature/fastapi-backend`). Voir la section « État d'implémentation » en fin de doc.
> À tester en mode serveur avant merge.

---

## ⏳ TODO — à faire avant de considérer le chantier terminé

### 1. 🔴 Revoir le MODÈLE de droits (décision produit — à valider par le PO)
**Non revu pour l'instant.** Le catalogue actuel a été construit au fil de l'eau
pendant l'implémentation ; il faut que le product owner le **valide de bout en bout** :
- **Quels blocs de droits on veut vraiment** (ressources × actions), et à quel niveau
  (global / workspace / projet). Le découpage actuel (voir « État d'implémentation »
  → catalogue) est une proposition, pas une décision arrêtée.
- **Quels rôles par défaut** et quelles permissions chacun a (viewer/editor/owner +
  admin global) — revoir la matrice, notamment : qui doit pouvoir exécuter du code,
  gérer les organisations, requêter la base applicative, gérer les membres.
- **Granularité** : garde-t-on le grain « rôle » (viewer<editor<owner) ou passe-t-on
  à du grain fin par ressource sur certaines surfaces ?
- **Cas limites** : ressources partagées/annuaires (organizations = lecture ouverte,
  décidé) ; rôle projet `none` (masquer un projet) ; héritage workspace→projet.
→ **Rien ne doit être considéré comme figé tant que le PO n'a pas revu ce modèle.**

### 2. Finir + vérifier le GATING UI
- **Vérifier** en mode serveur tout le gating déjà posé (settings, warehouse/lab
  list features, datasets, dashboards, wiki, projets, bases de données) avec des
  comptes viewer / editor / owner / non-membre.
- **Surfaces UI restantes non gatées** (backend déjà protégé — confort UI only) :
  concept-mapping (bulk-delete concept sets, delete import batch, edit mapping
  project, comments/approve, source-ID ranges), DQ checks editor (create/save),
  catalog config (age brackets, anonymisation), SQL scripts editor (create/save
  file), pipeline (add/remove node/edge/script), summary (README, tâches,
  attachments), patient-data widgets (add/edit/settings), dashboards détail
  (toggle edit, add widget, settings, tabs), IDE files (create/rename/upload),
  wiki (context-menu par nœud : create child/rename/delete, métadonnées/pièces
  jointes). Cartographie complète : voir l'inventaire produit le 2026-07-10.
- **Rappel** : le gating UI n'est que cosmétique — l'enforcement réel est serveur
  (403). À (re)prioriser une fois le modèle de droits validé (point 1), car
  certains gates changeront si le catalogue change.

---

## 📋 Catalogue de droits — VALIDÉ + IMPLÉMENTÉ (2026-07-11)

> **Validé par le PO le 2026-07-11 et implémenté** (backend `permissions.py`,
> migration `4d744166dce4`, UI `RolesTab.tsx`). Décisions PO sur les points ouverts :
> `reports` ajouté (verrouillé, stub) ; `databases` (workspace) + `project-databases`
> (projet) = deux ressources ; `concepts` (projet) = `read` seul ; **pas d'actions
> dédiées** (test/build/export) → tout en `read/write/delete`, seul `ide` ajoute
> `execute`. `code-execution` retiré → `ide:execute` (renommé par la migration).

> Reconstruit à partir des capacités réelles de l'app (sidebar + features +
> routes). **Trois tiers** : Global / Workspace / Projet. On garde le grain « rôle »
> (viewer < editor < owner) + admin global super-admin. L'héritage workspace→projet
> est conservé ; un override `project_members` peut affiner par projet.
>
> Convention : la plupart des ressources ont `read / write / delete`. Les
> ressources marquées ont des actions **non standard** (ex. `execute`). Les
> ressources **[N]** sont nouvelles (à ajouter au backend + migration).

### Tier GLOBAL (onglet « Global »)
Gestion instance-wide, depuis Home / Settings.

| Ressource | Actions | Note |
|---|---|---|
| `workspaces` | **write** | **write = CRÉER** un workspace (Home) ; le créateur en devient owner. Éditer/supprimer = via l'appartenance (owner → `workspace-settings`) ou `all-workspaces`. |
| `users` | read / write / delete | Comptes utilisateurs. |
| `roles` | read / write / delete | Rôles & permissions. |
| `organizations` | read / write / delete | Annuaire organisations (lecture ouverte à tous, décidé). |
| `app-database` | read / write / delete | SQL sur la base applicative (sensible — admin-tier). |
| `all-workspaces` | read / write / delete | Grant transverse : accès à TOUS les workspaces sans être membre. |
| `all-projects` | read / write / delete | Grant transverse : accès à TOUS les projets sans être membre. |

### Tier WORKSPACE — section « Workspace » (ordre sidebar)
Données workspace-scoped. Héritées par les projets du workspace.

| # | Ressource | Actions | Note |
|---|---|---|---|
| 1 | `workspace-settings` | read / write / delete | Gérer CE workspace : éditer (write) / supprimer (delete). Nom distinct du `workspaces` global (= créer) — pas de collision. |
| 2 | `workspace-members` | read / write / delete | Membres du workspace (2ᵉ position). |
| 3 | `workspace-summary` | read / write | Accueil du workspace : overview + README. |
| 4 | `projects` | read / write / delete | Créer / gérer les projets du workspace. |
| 5 | `wiki` | read / write / delete | Pages + pièces jointes. |
| 6 | `plugins` | read / write / delete | Installer / éditer le code / tester un plugin. |
| 7 | `schemas` | read / write / delete | Presets de schéma (upsert + delete ; pas de create pur). |
| 8 | `databases` | read / write / delete | Connexions BDD : create, test/retest, query, refresh-cache, edit, delete. |
| 9 | `concept-mapping` | read / write / delete | Projets de mapping + concept sets : import, map, build table, export. |
| 10 | `sql-scripts` | read / write / delete | Collections + fichiers SQL (run = client-side contre une source). |
| 11 | `data-quality` | read / write / delete | Rule sets + checks (run + résultats = client-side). |
| 12 | `catalog` | read / write / delete | Data catalog : config, anonymisation, export DCAT. |
| 13 | `etl` | read / write / delete | Pipelines ETL + fichiers (build/run = client-side). |

### Tier WORKSPACE — section « Projet » (ordre sidebar)
Ces droits s'appliquent **dans** un projet (via l'héritage / l'override projet).

| # | Ressource | Actions | Note |
|---|---|---|---|
| 1 | `project-members` | read / write / delete | Overrides de rôle par projet (2ᵉ position). |
| 2 | `project-summary` | read / write | README + tâches + pièces jointes (pas de delete dédié). |
| 3 | `ide` | read / write / delete + **execute** | Fichiers IDE + connexions + **exécution R/Python/SQL** (remplace `code-execution`). |
| 4 | `pipeline` | read / write / delete | Éditeur de graphe de pipeline projet. |
| 5 | `project-databases` | read / write | Link/unlink + test/reconnect/disconnect d'une source workspace (pas de delete : ne supprime pas la connexion). |
| 6 | `concepts` | **read** | Parcourir le dictionnaire de concepts de la source active (lecture seule). |
| 7 | `cohorts` | read / write / delete | Builder + génération SQL + run + résultats. |
| 8 | `patient-data` | read / write / delete | Tabs + widgets du dossier patient (layout projet). |
| 9 | `datasets` | read / write / delete | Import/reimport/duplicate/edit/query + analyses. |
| 10 | `dashboards` | read / write / delete | Tabs + widgets + export. |
| 11 | `reports` | read / write / delete | ⚠️ **Stub** (page « à venir ») — verrouillé, réservé. |

### Suppression / création d'un workspace — récap
- **Créer** : `workspaces:write` (global). Défaut : seul `admin`. Le rôle `user` ne
  l'a pas → à accorder explicitement.
- **Éditer** : `workspace-settings:write` (owner/editor du workspace) ou `all-workspaces:write`.
- **Supprimer** : `workspace-settings:delete` (owner du workspace) ou `all-workspaces:delete` ou admin.
- Chevauchement de nom voulu : `workspaces:write` (global, créer) ≠ `workspace-settings:write` (workspace, éditer) — strings distinctes.

### Points à trancher (PO)
1. `reports` = stub : on l'ajoute quand même (verrouillé) ou on attend la vraie page ?
2. Actions dédiées `test` / `build` / `export` : utiles, ou on simplifie à
   read/write/delete + `execute` uniquement pour l'IDE ?
3. `concepts` projet en lecture seule : OK ? (aucun CRUD côté projet aujourd'hui).
4. `summary` sans `delete` : OK ? (on ne supprime pas la page résumé).

---

> Audit du 2026-07-09, branche `feature/fastapi-backend`. Répond à : « est-ce
> effectif, côté UI **et** serveur, d'empêcher les accès non autorisés ? » et
> « manque-t-il des droits, notamment pour la requête SQL de la base applicative ».

## TL;DR

- **Serveur = solide sur 90 % des surfaces.** Le système de rôles/permissions
  (`app/core/permissions.py`) est réel et branché : chaque route CRUD résout la
  ressource puis vérifie le rôle workspace/projet (viewer < editor < owner ;
  admin global = super-admin). Cohorts, datasets, data sources, SQL scripts,
  wiki, pipelines, ETL, DQ, concept sets, catalogs, mappings, users, roles,
  workspaces, projects, **la requête SQL de la base applicative** — tous gardés.
- **UI = quasi aveugle à l'autorisation.** Le front ne connaît que le rôle
  **global** (`admin`/`user`) et **ne l'utilise nulle part** pour cacher/désactiver.
  Pas de `hasPermission()`, pas de garde de route par rôle. Tout utilisateur
  connecté **voit** tout (Settings, Users, Roles, outil SQL base applicative,
  boutons edit/delete d'un viewer). La sécurité tient **uniquement** parce que le
  backend renvoie 403 — mauvaise UX et posture fragile.
- **3 vraies failles serveur** (privilege escalation), à corriger.
- **Droits manquants dans le catalogue** : rien pour l'exécution de code (IDE /
  Python / R / terminal) ni pour la requête SQL de la base applicative (aujourd'hui
  cette dernière est `admin`-only en dur, sans passer par le catalogue).

---

## 1. Ce qui est effectif côté serveur (bon)

Catalogue : `RESOURCES × ACTIONS` (read/write/delete) + globales `users/roles/settings`.
Enforcement via `check_workspace_role` / `has_permission` / `require_*`.

| Surface | Garde | Verdict |
|---|---|---|
| workspaces / projects | `require_workspace_role` / `require_project_role` | ✅ |
| cohorts, datasets, dataset_files | `_require_project_access` (viewer read / editor write+delete) | ✅ |
| data_sources (+ `/query` SQL externe) | `_load_source` viewer/editor | ✅ |
| sql_scripts, pipelines, etl, dq, concept_sets, catalogs, mappings, source_concept_ids | `check_workspace_role` | ✅ |
| wiki, schema_presets, ide_connections, ide_files | idem | ✅ |
| users, roles | `get_current_admin` | ✅ |
| **base applicative `/database/query` + `/schema`** | `get_current_admin` + read-only (single SELECT + rollback) | ✅ |
| execution `/execute` (avec projet), `/kernels`, `/restart`, WS `/terminal` | rôle projet (editor pour exécuter) | ✅ |

Les endpoints de liste filtrent les workspaces non visibles (`list_for_user`) → pas
de fuite inter-workspace.

---

## 2. Failles serveur à corriger (priorisées)

### 🔴 P1 — Exécution de code sans contexte projet = RCE authentifié
`app/api/v1/routes/execution.py:99` — `POST /execute` ne vérifie le rôle projet
**que si `body.project_uid` est présent**. Sans `project_uid`, on tombe direct sur
`runtime.run_python` / `run_r` : **n'importe quel utilisateur connecté** (même un
`user` global sans aucune appartenance workspace) exécute du Python/R arbitraire
sur le serveur. Seul garde-fou : le flag `enable_code_execution` (défaut `True`).
→ **Fix** : exiger un contexte projet + rôle `editor` pour toute exécution, ou
gater l'exécution sans contexte derrière un droit explicite (cf. §4).

### 🟠 P2 — Terminal WS : connexion SQL non gardée par le workspace
`execution.py:171-184` (`_make_ws_resolver`) charge la data source par
`connectionId` **sans** `check_workspace_role`, contrairement au chemin HTTP
(`_require_connection_access`, l:42-52). Un editor du projet A peut passer
`?connectionId=<source du workspace B>` et requêter dessus.
Note : actuellement **masqué** par un bug (§3) qui casse `sql_query()`, mais à
corriger avec.

### 🟠 P3 — Plugins globaux modifiables par tous
`app/api/v1/routes/user_plugins.py` — `_check_access` **no-op quand
`workspace_id is None`**. Tout utilisateur connecté peut créer/éditer/supprimer un
plugin **global** (= instance-wide, code exécutable). Escalade via surface partagée.

### 🟡 Mineurs
- `organizations.py:17-43` — lecture/énumération de **toutes** les organisations
  par tout utilisateur connecté (ressource pourtant au catalogue). Lecture seule.
- `data_sources.py:93` `test-connection` — connexion sortante vers un hôte
  arbitraire du body, `get_current_user` seul (goût SSRF, sans persistance).
- `setup.py` `GET /setup/db-info` — moteur + host/chemin DB exposés **sans auth**.
- Pattern transverse : **toute ressource `workspace_id IS NULL`** (data sources,
  plugins, schema presets, projets non assignés) est world-accessible aux
  authentifiés — cohérent par design, mais c'est le point mou (P1–P3 y vivent).

---

## 3. Bug latent (à corriger avec P2)
`execution.py:116` et `:182` appellent `data_source_service.query(source, sql)`
alors que la signature est `query(db, source, sql)` (`data_source_service.py:197`).
→ `sql_query()` depuis un kernel/terminal lève un `TypeError`. Fonctionnalité
cassée aujourd'hui.

---

## 4. Droits manquants dans le catalogue

Le catalogue (`RESOURCES`/`GLOBAL_RESOURCES`) ne couvre **pas** les capacités
nouvelles/sensibles :

- **Exécution de code** (IDE, Python/R, kernels, terminal) — aujourd'hui gérée par
  le rôle `editor` sur le projet, sans droit dédié. Un CHU voudra sans doute
  distinguer « peut voir les datasets » de « peut exécuter du code serveur ».
- **Requête SQL de la base applicative** — aujourd'hui `admin`-only **en dur**
  (`get_current_admin`), hors catalogue. À exposer comme droit global explicite
  (`settings:*` ou nouveau `app-database:read`) si on veut le déléguer un jour.
- **Terminal / shell serveur** (PTY bash) — même remarque que l'exécution : accès
  très puissant (shell dans le dossier projet), mérite son propre droit.

Proposition d'ajouts (à valider) :
- `RESOURCES += ["pipelines", "etl", "sql", "code-execution"]` (aligner le
  catalogue sur les entités réelles — plusieurs sont gardées par rôle sans droit
  nommé).
- `GLOBAL_RESOURCES += ["app-database"]` pour la requête SQL de la base app.

---

## 5. UI — quasi aucune barrière d'autorisation

- `AuthUser` (`stores/auth-store.ts:4-10`) n'expose qu'un `role: string` global,
  **jamais lu** pour gater. Pas de liste de permissions côté client.
- Aucune garde de route par rôle (`app/App.tsx`), Settings/Users/Roles/outil SQL
  base app visibles par **tout** connecté (seul `isServerMode()` les conditionne —
  capacité, pas autorisation).
- Un **viewer** voit les boutons create/edit/delete partout (cohorts, datasets,
  connexions, mappings…). Le backend bloque (403) mais l'UX est trompeuse.
- Pas d'écran de gestion des membres de workspace (attribution viewer/editor/owner).

**Primitive manquante** : faire renvoyer par `GET /auth/me` les permissions
effectives + le rôle par workspace, puis introduire `hasPermission()` / `useCan()`
+ un wrapper `RequireRole` pour gater la route `/settings`, les onglets admin,
l'outil SQL base app, et les contrôles edit/delete.

---

## Ordre de traitement recommandé
1. **P1** (exécution sans contexte) — le plus grave, RCE authentifié.
2. **P2 + bug §3** (terminal WS + signature `query`).
3. **P3** (plugins globaux).
4. **Catalogue** (§4) : ajouter les droits code-execution + app-database.
5. **UI** (§5) : exposer permissions dans `/auth/me`, helper `hasPermission`,
   gater Settings/admin/outil SQL + contrôles edit/delete.
6. Mineurs (organizations, db-info, test-connection).

---

## État d'implémentation (2026-07-10)

Livré en 6 lots committés sur `feature/fastapi-backend`. 248 tests backend verts.

| Lot | Contenu | Commit |
|---|---|---|
| **0** | P1 (`/execute` exige projet + editor), P2 (garde connexion terminal WS + bug signature `query(db,source,sql)`), `setup/db-info` admin après setup | `49a49dca` |
| **2** | Dimension **projet** : table `project_members`, résolution 3D (admin > override projet > rôle workspace hérité), API membres (workspace + projet), garde dernier-owner | `75c2601f` |
| **5** | **Pages Membres** (onglet dans settings workspace ET projet), ajout par username, client `lib/api/members.ts` | `697a209d` |
| **3** | **Catalogue scopé** : droits `code-execution` (projet) + `app-database` (global) ; exécution gatée par `code-execution:write` ; outil SQL base app gaté par `app-database:read` | `660b0c22` |
| **4** | `/auth/me` renvoie les permissions ; `hasGlobalPermission()` ; onglets Users/Roles + outil SQL cachés sans droit ; rôle projet **`none`** (masquer un projet) ; migration de backfill des rôles existants | `7553f08f` |
| **1** | **Plugins strictement workspace-scopés** : `workspace_id` NOT NULL, migration supprime les globaux, création exige un workspace (front + back) | `9cfa3a4b` |

### Décisions actées (product owner)
- Appartenance projet = **héritage + override** (l'override remplace : élargit, restreint, ou `none` = masqué).
- Créateur d'un workspace = **owner** (déjà en place).
- Exécution de code = **droit dédié** `code-execution` (pas juste `editor`).
- Plugins = **workspace-scopés stricts**, globaux existants **supprimés**, defaults built-in restent en registre mémoire (pas de rows `user_plugins`).
- UI : pages/onglets admin **cachés** sans droit ; actions inline edit/delete → **désactivées** (posture retenue ; le gating inline fin reste à étendre surface par surface — voir Reste).

### Reste (non bloquant, à planifier si besoin)
- **Gating inline edit/delete** par rôle workspace/projet dans les surfaces (cohorts, datasets, connexions, mappings…) : nécessite d'exposer aussi le rôle **par contexte** (endpoint `GET /workspaces|projects/{id}/my-permissions`) puis désactiver les boutons. `/auth/me` ne porte aujourd'hui que les droits **globaux**.
- **Mineurs** : lecture `organizations` ouverte à tout connecté (laissée volontairement) ; `test-connection` reste en authn (goût SSRF non traité).
- **Portal/export** : les exports antérieurs contenant un plugin global (`workspaceId` absent) devront être ré-associés à un workspace à l'import (le flux d'import est déjà par-workspace).
