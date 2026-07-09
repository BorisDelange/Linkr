# Audit — Users & Authorizations (mode serveur / full-stack)

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
