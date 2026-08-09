# README + LICENSE pour tous les contenus versionnables

> Première étape d'implémentation : copier ce plan dans `docs/planning/readme-license-plan.md` + l'ajouter à l'index `docs/planning/README.md` (demande utilisateur).

## Context

Aujourd'hui seuls workspace et project ont un README (champ `readme?: LocalizedString`, UI d'affichage/édition + attachments). Les ETL pipelines et SQL collections reçoivent à la création un fichier `README.md` auto-seedé dans leur arborescence — un pis-aller. Aucune entité n'a de licence, alors que tout contenu versionnable est destiné à être partagé via git.

Objectif : chaque contenu versionnable (mapping projects, SQL collections, ETL pipelines, DQ rule sets, data catalogs, schema presets, user plugins — en plus de workspace/project) reçoit un **README** (même UI que projects/workspaces : affichage, édition split, attachments images) et une **LICENSE** (12 licences standard + custom), exportés respectivement en `README.md` / `LICENSE.md` à la racine du dossier d'export de l'entité (convention GitHub/GitLab : les deux plateformes détectent `LICENSE.md`).

Décisions utilisateur : toutes les entités versionnables · fichier `LICENSE.md` · UI hors project/workspace = dialog large à onglets Readme|Licence accessible depuis le badge header et les "..." des cartes · licences : MIT, Apache-2.0, GPL-3.0, AGPL-3.0, BSD-3-Clause, MPL-2.0, CC-BY-4.0, CC-BY-SA-4.0, CC0-1.0, ODbL-1.0, EUPL-1.2, CeCILL-2.1 (+ custom).

## Décisions de design

**D1 — Licence = snapshot du texte dans l'entité.**
```ts
// types/index.ts
export type StandardLicenseId = 'MIT' | 'Apache-2.0' | 'GPL-3.0' | 'AGPL-3.0' | 'BSD-3-Clause'
  | 'MPL-2.0' | 'CC-BY-4.0' | 'CC-BY-SA-4.0' | 'CC0-1.0' | 'ODbL-1.0' | 'EUPL-1.2' | 'CeCILL-2.1'
export interface EntityLicense {
  id: StandardLicenseId | 'custom'
  name?: string          // titre custom (les titres standard viennent du registre)
  text: string           // texte complet markdown, snapshotté au pick
}
```
Le texte est snapshotté au choix de la licence → export déterministe byte-for-byte (goldens), le serveur FastAPI n'a jamais besoin des 12 textes embarqués, round-trip git exact. Split JSON/fichier comme le readme : le JSON de l'entité porte `license: { id, name? }` (via `licenseMeta()`), `LICENSE.md` porte le texte ; l'import recombine (`LICENSE.md` sans meta → `{ id: 'custom', text }`).

**D2 — Registre de licences client-only** : `apps/web/src/lib/licenses/` — 12 fichiers `.md` (textes officiels anglais, MIT/BSD avec tokens `{{year}}`/`{{holder}}`) lazy-loadés (`import.meta.glob('./texts/*.md', { query: '?raw', import: 'default' })`, ~200 KB jamais dans le bundle principal) + `index.ts` : `STANDARD_LICENSES` (id, `title: LocalizedString` FR/EN, `descKey`, `catKey` permissive/copyleft/weak-copyleft/data/public-domain, spdxUrl, loadText) et `fillLicensePlaceholders(text, { year, holder })`.

**D3 — Attachments généralisés `(ownerType, ownerId)`** (remplace les 2 FK nullables, sans couche de compat) :
```ts
export type ReadmeOwnerType = 'workspace' | 'project' | 'mapping-project' | 'sql-collection'
  | 'etl-pipeline' | 'dq-rule-set' | 'data-catalog' | 'schema-preset' | 'user-plugin'
export interface ReadmeAttachment {
  id: string; ownerType: ReadmeOwnerType; ownerId: string
  workspaceId?: string   // dénormalisé : cascade au delete du workspace
  fileName: string; mimeType: string; fileSize: number; data: ArrayBuffer; createdAt: string
}
```
Interface storage : `getByOwner / getById / create / delete / deleteByOwner / deleteByWorkspace`. Côté serveur : `owner_type`/`owner_id` (index composite) + `workspace_id` FK CASCADE conservé ; cascade manuelle (`delete_readme_for_owner`) dans les 8 services de delete d'entité.

**D4 — `_meta.json` d'attachments portable** : `[{id, fileName, mimeType, fileSize, createdAt}]` sans champs owner (re-stampés à l'import) — corrige le leak actuel `projectUid`/`workspaceId: null` dans le golden project.

**D5 — Les entités "fichier plat" deviennent des dossiers dans l'export workspace** (pour héberger README/LICENSE/attachments) : `data-quality/<eid>/_ruleset.json`, `catalogs/<eid>/catalog.json`, `schemas/<eid>/preset.json` (+ docs). Import réécrit en parsing par dossier (modèle : boucles sql/etl existantes). Pas de dual-format legacy ; le bump de VERSION signale la rupture.

**D6 — Noms réservés dans les arbres de fichiers** : `README.md` (+ `README.<lang>.md`), `LICENSE.md` et `attachments` sont réservés **à la racine** des arbres versionnés (SQL, ETL ; projet : la racine de l'arbre IDE = racine du ZIP, `RESERVED_ROOT_FOLDERS` existe déjà dans `stores/file-store.ts:10`) — ils entreraient en collision avec les fichiers émis à l'export. Migration : les `README.md` racine existants (ETL/SQL) sont hoystés dans `entity.readme` puis supprimés (IDB v36 + alembic), conformément à la préférence "on nettoie la base, pas de compat complexe".

## Implémentation

### Phase A — Modèle de données & storage

1. **Types client** — `types/index.ts` : `StandardLicenseId`, `EntityLicense`, `ReadmeOwnerType`, nouveau `ReadmeAttachment` (remplace L376-388) ; `license?: EntityLicense` sur `Workspace` (~L152) et `Project` (~L181) ; `readme?: LocalizedString` + `license?` sur `EtlPipeline` (~L785), `SqlScriptCollection` (~L875), `DqRuleSet` (~L911), `UserPlugin` (~L986). Idem `MappingProject` (`types/concept-mapping.ts:168`), `CustomSchemaPreset` (`types/schema-mapping.ts:230`), `DataCatalog` (`types/catalog.ts:132`).
2. **Registre licences** — `apps/web/src/lib/licenses/` (12 `.md` + `index.ts`, D2).
3. **Storage client** — `lib/storage/index.ts` : nouvelle `ReadmeAttachmentStorage` (D3). `idb-storage.ts` : `DB_VERSION` 35→36 — index `by-owner` `['ownerType','ownerId']` (drop `by-project`, garde `by-workspace`), migration des lignes (projectUid→`project`, workspaceId→`workspace`, backfill `workspaceId` via le store `projects`) **+ hoist des README.md racine** ETL/SQL vers `entity.readme` (D6). `lib/api/readme-attachments.ts` : params `ownerType`/`ownerId`. Hook unique `useReadmeAttachments(ownerType, ownerId)` (fusion des 2 wrappers, `use-workspace-readme-attachments.ts` supprimé). Deletes : `entity-io.ts` `deleteProjectData` → `deleteByOwner('project', uid)` ; chaque store d'entité appelle `deleteByOwner` dans son delete.
4. **Serveur** — modèles : `readme` + `license` (colonnes JSON) sur les 7 modèles d'entité (`apps/api/app/models/{mapping_project,sql_script,etl_pipeline,dq_rule_set,data_catalog,schema_preset,user_plugin}.py`) ; `license` sur `workspace.py`/`project.py` ; `attachment.py` réécrit (D3). Schemas : champs sur **Create, Update ET Response** (leçon createdAt-roundtrip : un champ absent de l'Update est silencieusement droppé). Une migration alembic (`down_revision='f6a7b8c9d0e1'`) : colonnes + backfill attachments + drop `project_uid` + index `(owner_type, owner_id)` + hoist README ETL/SQL (miroir de l'IDB v36). Routes `attachments.py` : `_require_readme_scope` → `_require_owner_scope` (dispatch table ownerType → resource : `workspace-summary`, `project-summary`, `concept-mapping`, `sql-scripts`, `etl`, `data-quality`, `catalog`, `schemas`, `plugins` ; résolution entité→workspace via table modèle) ; `workspace_id` calculé côté serveur au create. `attachment_service.py` : `list_readme_by_owner`/`delete_readme_for_owner` ; `blob_cleanup.py` adapté ; cascade manuelle dans les 8 services de delete.

### Phase B — Export / import / seed / git

5. **Helpers export** (`entity-io.ts`, à côté de `writeReadmeFiles` L40) : `writeLicenseFile(zip, dir, license)`, `licenseMeta(license)`, `writeEntityDocs(zip, dir, entity, ownerType, ownerId, storage)` (README + LICENSE + `attachments/`+`_meta.json` D4).
6. **Builders client** : chaque builder strip `readme`/remplace `license` par `licenseMeta` dans son JSON et appelle `writeEntityDocs` — `buildProjectZip` (L576/600/604), `buildSqlCollectionFolder` (L1547), `buildEtlPipelineFolder` (L1973), `buildDataCatalogFolder` (L1685), `buildDqRuleSetFolder` (L1709), `buildSchemaPresetFolder` (L1736), `buildUserPluginFolder` (L1759), `cleanMappingProjectMeta`/`buildMappingProjectFolder` (`concept-mapping/export.ts:614/634`). `buildWorkspaceZip` : LICENSE racine, **fix du gap existant** (attachments README workspace jamais exportés), projets lightweight + entrées sql/etl metadata-only (L2237/2263, JSON non-strippé aujourd'hui), dq/catalogs/schemas → dossiers (D5). Branches git-pointer inchangées.
7. **Import client** : `parseProjectZip` — LICENSE.md à côté du regex README (L1217-1226) ; `parseWorkspaceZip` — LICENSE + attachments racine, regex `lightweightFile` élargi, sections d'entités lisent les fichiers frères, dq/catalogs/schemas par dossier ; boucle plugins : `README*.md`/`LICENSE.md`/`attachments/**` réservés (→ champs, pas `plugin.files`). `WorkspacesPage.tsx` (application L427-722) : re-stamp des attachments par entité. `applyClonedEntity` (L1840) + `project-pull.ts` (`computeReadmeChanged` L165 inclut la licence).
8. **Miroirs serveur** : `workspace_export.py` — `_license_file`/`_license_meta` à côté de `_readme_files` (L117), chaque section miroir exact du point 6 (ordre des clés = discipline byte-parity existante) ; `workspace_export_assemble.py` + `project_export.py`/`project_export_assemble.py` + `mapping_project_export.py`.
9. **Seed loader** (`seed-loader.ts`) : `fetchEntityDocs(base, folder)` (README par langue + LICENSE.md) + attachments, appliqué au workspace racine, projets, mapping projects, dq (dirname du path pour tolérer les seeds plats existants), catalogs, etl, sql, schemas.
10. **Git file meta** (`git-file-meta.ts`) : `LICENSE_RULE` (`/^LICENSE\.md$/i`) + `ATTACHMENTS_RULE` (`/^attachments\//`) ajoutés partout où `README_RULE` existe, et README+LICENSE ajoutés aux scopes qui n'ont pas encore README (etl-pipelines, data-catalogs, dq-rule-sets, schema-presets). Clés i18n `versioning.file_desc_license` / `file_desc_readme_attachment`.
11. **VERSION** : `2.2.1` → `2.3.0` (layout d'export modifié). **Goldens** : étendre les `input.json` (licence + readme + un attachment) puis `GOLDEN_UPDATE=1` côté TS (8 tests export-golden) puis côté Python (byte-parity). Tests unitaires : `entity-io.test.ts`, `project-pull.test.ts`, `git-file-meta.test.ts`, `entity-tree.test.ts` (validateur D6), serveur `test_attachments.py` (dispatch permissions par ownerType). `docs/architecture.md` : noter le nouveau layout.

### Phase C — UI

12. **Validateur partagé** — `entity-tree.ts` : `isReservedTreeName(name, parentId)` (root only, case-insensitive : `attachments`, `license.md`, `readme(.lang)?.md`) + tests. Câblé sur les 8 sites : `EtlFileTree.tsx` (rename L213-224), `EtlScriptsTab.tsx` `handleCreateFile` L258-282 (**ajouter aussi le check doublon manquant** + erreur visible + bouton disabled), `SqlScriptsFileTree.tsx` (L246-257), `CreateSqlScriptFileDialog.tsx` (L96-104), `features/projects/files/FileTreeItem.tsx` (L221-237), `CreateFileDialog.tsx` (L141-150), `CreateFolderDialog.tsx` (étend `isReserved` L61), `stores/file-store.ts` (`createFolder` L907, `renameNode` L1020). Message : clé existante `files.name_reserved`.
13. **Retrait des seeds README** — `CreateEtlDialog.tsx:121-134` et `CreateSqlScriptsDialog.tsx:116-127` : suppression des blocs `createFile`. La description SQL ne migre pas dans le readme (elle vit déjà sur l'entité).
14. **AttachmentsDialog générique** — `features/projects/summary/ReadmeAttachmentsDialog.tsx` → `components/editor/AttachmentsDialog.tsx`, typé structurellement (`BaseAttachment`), 2 importeurs mis à jour.
15. **`LicenseEditor`** (`components/editor/LicenseEditor.tsx`) — props `{ license: EntityLicense | null, onSave, canEdit?, className? }`, modes view/pick/edit : view = titre (registre pour standard, `name` pour custom) + `MarkdownRenderer`, actions Changer/Éditer/Retirer (AlertDialog), empty state + CTA ; pick = grille de Cards (12 standards : titre localisé, Badge catégorie, one-liner, + carte Custom) ; edit = Input nom + split `MarkdownToolbar`/`applyMarkdownFormat` + textarea | `MarkdownRenderer` (pattern wiki — **pas de modif de ReadmeEditor**). Pick standard : `loadText()` → `fillLicensePlaceholders` (year courant, holder = org liée si résoluble) → mode edit.
16. **`EntityDocsDialog`** (`components/ui/entity-docs-dialog.tsx`) — modèle `entity-versioning-dialog.tsx` : `h-[90vh] sm:max-w-5xl`, Tabs Readme|Licence, `initialTab`, état local post-save (les items de menu sont des snapshots) ; Readme = `ReadmeEditor` + `setLocalized`/`localized` + attachments (hook généralisé + Paperclip → `AttachmentsDialog`) si `attachmentOwner` fourni ; Licence = `LicenseEditor`.
17. **`EntityActionsMenu`** — prop optionnelle `docs { getReadme, onSaveReadme, getLicense, onSaveLicense, attachmentOwnerType? }` ; items "Readme" (`BookOpen`) et "Licence" (`Scale`) après Versioning, ouvrant `EntityDocsDialog` sur l'onglet voulu (lecture seule si `!canEdit`, items visibles seulement si `docs` fourni — dashboards/cohorts inchangés). `ListPageTemplate` : pass-through `docs`.
18. **7 hooks d'actions** — `use-etl-actions`, `use-sql-collection-actions`, `use-dq-rule-set-actions`, `use-catalog-actions`, `use-mapping-project-actions` : accessors + save via `updateX(id, { readme|license })` ; `use-schema-preset-actions` : sauver via `savePreset` sur le preset brut du store (pas le wrapper) ; `use-plugin-actions` : lire frais depuis `pluginList`, sauver via `getStorage().userPlugins.update` + refresh.
19. **Onglets Licence project/workspace** — `SummaryPage.tsx` : trigger `license` (URL `?tab=license`) + nouveau `features/projects/summary/SummaryLicenseTab.tsx` (miroir de `SummaryReadmeTab`, `updateProjectLicense` dans app-store, permission `project-summary:write`) ; `WorkspaceHomePage.tsx` : TabsContent licence inline (`updateWorkspaceLicense` dans workspace-store).
20. **`ReadmePreviewCard`** partagé (`components/editor/ReadmePreviewCard.tsx`) remplaçant les 2 `ReadmePreview` dupliqués (`SummaryOverviewTab.tsx:282-312`, `WorkspaceHomePage.tsx:344-372`).
21. **i18n** (en+fr) : `summary.tab_license`, groupe `entity_docs` (title/description), groupe `license` (title, no_license, choose, custom, custom_description, name, name_placeholder, change, edit_text, remove, remove_confirm_*, cat_* ×5, desc_* ×12), `versioning.file_desc_license`/`file_desc_readme_attachment`.

### Ordre d'exécution
Phase A (types/storage/serveur) → Phase B (export/import/goldens, TS et Python ensemble pour la byte-parity) → Phase C (UI). Le plan sera copié dans `docs/planning/readme-license-plan.md` en tout premier.

## Vérification

- `npm run test` (front : goldens ×8 régénérés puis verts, entity-io/entity-tree/project-pull/git-file-meta) ; `pytest` (apps/api : goldens Python byte-identiques aux TS, test_attachments, migration).
- `npm run lint` + typecheck.
- Manuel (npm run dev) : ① créer un ETL → plus de README.md seedé ; tenter de créer/renommer un fichier `README.md`/`LICENSE.md`/dossier `attachments` à la racine → bloqué avec message ; ② badge header ETL → "Readme" : éditer, ajouter une image en attachment, vérifier le rendu ; idem depuis les "..." de la list page ; ③ "Licence" → choisir MIT (year/holder remplis), puis une custom ; ④ project : onglet Licence (`?tab=license`) ; workspace idem ; ⑤ export ZIP d'un pipeline → `README.md` + `LICENSE.md` + `attachments/` à la racine du ZIP, réimport → tout revient ; ⑥ export workspace → LICENSE racine + attachments workspace (gap corrigé) + dossiers dq/catalogs/schemas ; ⑦ mode serveur : alembic upgrade, upload/suppression d'attachment sur un ETL (permissions), export serveur identique au front.
- Post-merge : la doc utilisateur (`../linkr-website`) devra documenter README/licence par entité (à signaler, hors scope de ce change).
