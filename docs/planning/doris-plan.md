# Apache Doris comme database externe — et calcul déporté sur la base distante

**Objectif.** Brancher un entrepôt Apache Doris comme database Linkr (mode serveur),
avec des calculs lourds aussi rapides que Doris le permet. Le travail profite aussi
aux databases Postgres et MySQL existantes : le problème de fond (§1.2) les touche
déjà.

Mode serveur uniquement : le navigateur (WASM) ne peut ouvrir ni connexion MySQL
ni gRPC.

---

## 1. Constats (mesurés le 2026-10-09)

Banc : Doris 4.1.4 en Docker (1 FE + 1 BE, annexe A), démo MIMIC-IV en OMOP
(accès ouvert, 32 tables, 460 k lignes) + `measurement_big` (3,4 M lignes).
Mesures prises depuis un conteneur du réseau Docker : depuis le Mac, le relais de
ports de Docker Desktop fausse tout (Flight y paraît prendre 20 s).

### 1.1 Doris parle MySQL — le connecteur actuel marche presque

- `introspect_external` liste tables et colonnes sans modification.
- `query_external` échoue : `_attach` ouvre en `READ_ONLY`
  (`db_connect.py:234`), DuckDB envoie alors `START TRANSACTION READ ONLY`, que
  Doris rejette (`mismatched input 'READ'`).
- Sans `READ_ONLY` : `COUNT`, jointures, `DATETIME(6)`, filtres poussés,
  `mysql_query` passent tous.
- Un compte Doris réduit à `SELECT_PRIV` refuse `DELETE` et `DROP` (testé), y
  compris via `mysql_execute`.

### 1.2 Le vrai coût : DuckDB n'envoie jamais les agrégats à la base distante

DuckDB pousse les filtres et les colonnes vers la base attachée, **jamais les
`GROUP BY` / `COUNT`**. Un agrégat rapatrie donc toutes les lignes.

| `GROUP BY` concept, `COUNT`, `COUNT(DISTINCT person_id)` sur 3,4 M lignes | Temps |
|---|---|
| `ATTACH`, SQL DuckDB (ce que fait Linkr aujourd'hui, Postgres compris) | **24 s** |
| Même connexion, `mysql_query('ext', '<SQL Doris>')` : Doris calcule | **0,16 s** |
| Flight SQL, Doris calcule | 0,07 s |
| Lecture d'une ligne par clé : `ATTACH` / Flight | 0,01 s / 0,03 s |

→ Pour les agrégats, l'enjeu est **qui calcule**, pas le protocole.

### 1.3 Flight SQL ne sert qu'aux gros extraits

| Lire toutes les lignes | 338 k | 3,4 M |
|---|---|---|
| `ATTACH` MySQL → Parquet | 9,4 s | 100 s |
| Passthrough `mysql_query` | 13,8 s | 105 s |
| Client MySQL Python (pymysql) | 3,4 s | 29 s |
| **Flight SQL (ADBC) → DuckDB → Parquet** | **0,33 s** | **2,6 s** |

Pas d'`ATTACH` Flight possible : l'extension communautaire Airport parle son
propre protocole, pas Flight SQL (et les extensions communautaires sont bloquées,
`_lock_down_user_sql`). Le chemin qui marche : `adbc_driver_flightsql` →
`RecordBatchReader` → `con.register()` dans DuckDB, sans copie.

Piège de déploiement : le FE renvoie le client Flight vers chaque BE. Le serveur
Linkr doit joindre les BE, ou les BE doivent annoncer une adresse joignable
(`public_host` + `arrow_flight_sql_proxy_port` dans `be.conf`). Sinon, attente
de 20 s puis échec.

### 1.4 La traduction automatique du SQL DuckDB ne suffit pas

sqlglot (DuckDB → Doris), 6 requêtes types de l'app : 3 passent (`MEDIAN`,
`QUANTILE_CONT`, `STRFTIME`, `TRY_CAST`, `ILIKE`), 3 échouent (`FILTER (WHERE)`,
`GROUP BY ALL`, listes `[a,b]` + `UNNEST`). Tout le SQL généré par l'app est en
dialecte DuckDB (`::`, `FILTER`, `GROUP BY ALL`, `quantile_disc(x,[…])`,
`md5_number_lower`, `EPOCH`, `AGE()`…) : traduire l'ensemble serait fragile.

---

## 2. Décisions

1. **Moteur `doris`** = chemin `mysql` existant (`TYPE mysql`, port 9030 par
   défaut), `ATTACH` **sans** `READ_ONLY`. Le connecteur reste la base de toutes
   les requêtes légères.
2. **Calcul déporté pour les calculs lourds**, en deux étages :
   - *agrégation distante* : un SQL volontairement portable (`GROUP BY`, `COUNT`,
     `COUNT(DISTINCT)`, `SUM(CASE …)`, `CAST`, `MIN`/`MAX`), exécuté en
     passthrough (`mysql_query` pour Doris/MySQL, `postgres_query` pour Postgres),
     qui ne renvoie que des agrégats ;
   - *finition locale* dans DuckDB sur ce petit résultat (quantiles, fusions entre
     tables, jointures aux dictionnaires) : le SQL DuckDB actuel reste là.

   Pas de traduction automatique générale (§1.4). Un seul SQL portable par unité,
   pas un par moteur ; les rares fonctions non portables (percentiles) passent par
   une petite table de correspondance par moteur, ou par un histogramme distant
   (`FLOOR` + `COUNT`) dont on tire les quantiles localement.
3. **Flight SQL = dépendance facultative**, réservée aux gros extraits, en phase 2.
   - Extra `doris` dans `apps/api/pyproject.toml` (`adbc_driver_manager` +
     `adbc_driver_flightsql`, ≈ 24 Mo installés), importé seulement à l'usage.
   - Absent ou injoignable → **repli sur MySQL, et l'utilisateur est prévenu**
     (message visible là où l'extrait est lancé, et sur la page de la database :
     « Flight indisponible : transferts lents »).
4. **Aucun changement de format d'export.** L'export d'une database ne garde que
   `engine` (`EXPORTED_CONNECTION_KEYS`, `entity-io.ts:4295`) ; le port Flight
   reste local à la machine, comme hôte et identifiants. `packages/linkr-format`
   n'énumère pas les moteurs : `engine: "doris"` passe tel quel.

---

## 3. Inventaire des chemins lourds

Tous passent aujourd'hui par `POST /data-sources/{id}/query` → `query_external`
(`ATTACH`), sauf mention. Seul `introspect_external` utilise déjà le passthrough.

### 3.1 Agrégats sur les tables cliniques → calcul déporté (§2.2)

| Chemin | Entrée | Lots / pause |
|---|---|---|
| Comptage des concepts | `concept-count-plan.ts:77,87` (unités), serveur `materialize_parquet` | ✅ unités reprenables |
| Data catalog | `catalog-compute.ts:238,355`, `catalog-queries.ts` ; MCP `compute_data_catalog` | ✅ tranches |
| Extraction du concept mapping : passe de classement + profils par concept | `source-extraction.ts:127,203` ; `concept-profile.ts:305-668` | ✅ pause/reprise |
| Contrôles DQ | `data-quality.ts:59`, `dq-templates.ts` ; MCP `run_dq_rule_set` | ⚠️ par contrôle, sans reprise |
| Statistiques de la database | `database-stats.ts:34`, `table-counts.ts:110` | ❌ |
| Liste des patients (`GROUP BY` sur toute la population à chaque page/filtre) | `patient-data-queries.ts:30,50` | ❌ |
| Comptages/attrition des cohortes, rapport de cohorte | `cohort-store.ts:460`, `cohort-report/queries.ts` | ❌ |
| Statistiques de colonnes du SchemaBrowser | `SchemaBrowser.tsx:325-476` | ❌ |

### 3.2 Gros extraits → Flight (§2.3)

| Chemin | Entrée |
|---|---|
| Datasets du Lab depuis une requête | `routes/dataset_files.py:389` (MCP `create_dataset_from_query`) |
| Figer une cohorte | `routes/cohorts.py:143` |
| Dériver une database depuis une cohorte | `cohort_derive.py:330,467` |
| ETL dont la source est la base externe | `db_connect.run_etl_sql` → `_attach_role` |
| Librairies R / Python | `client_recipe` → `ATTACH` côté client (`linkr-py/_databases.py:140`) |

---

## 4. Étapes

### Phase 1 — moteur `doris` (S)

1. Backend : `_ENGINES["doris"]` (extension et type `mysql`, `read_only=False`) ;
   `_dsn` / `_scope` traitent `doris` comme `mysql` ; ajouter `doris` aux listes
   codées en dur (`data_source_service.py:44`, `database_credential_service.py:33`,
   `db_connect.py:1052`).
2. Frontend : `DatabaseEngine` (`types/index.ts:272`), `AddConnectionDialog.tsx:348`,
   `data-source-store.ts:580`, `DatabaseDetailPage.tsx:162` ; port 9030 par défaut ;
   texte d'aide sur le compte en lecture seule. i18n EN/FR.
3. MCP : `tools-databases.ts:229`, `live/workspace.ts:306`.
4. Tests : `_dsn`/`_scope`/`attach` pour `doris` (pas de `READ_ONLY`).
5. Doc utilisateur (linkr-website) : connecter un Doris, compte en lecture seule.

### Phase 2 — calcul déporté (L)

1. Serveur : un mode « requête distante » sur `/query` (ou une route dédiée) qui
   exécute un SQL portable en passthrough et renvoie le résultat, avec les
   garde-fous du §5.1 et l'annulation du §5.2.
2. Comptage des concepts : chaque unité porte une variante distante ; la finition
   (`buildConceptsAssembleQuery`) reste locale. Premier cas, pour valider le
   principe sur Doris **et** Postgres.
3. Data catalog : même découpage par unité.
4. Passe de classement de l'extraction du concept mapping ; profils par concept
   (percentiles : table de correspondance ou histogramme distant).
5. Contrôles DQ (les modèles `dq-templates.ts` ; le SQL libre de l'utilisateur reste
   en `ATTACH`).
6. Statistiques de la database, liste des patients, cohortes.

### Phase 3 — Flight pour les gros extraits (M)

1. Extra `doris` ; champ « port Flight » (défaut 8070) dans la configuration locale
   de la database ; test de joignabilité FE **et** BE au « Tester la connexion ».
2. Lecteur Flight → `RecordBatchReader` → DuckDB, branché sur les chemins du §3.2
   côté serveur.
3. Repli MySQL + avertissement (§2.3).

---

## 5. À trancher 🤔

1. **Sécurité du passthrough.** Les garde-fous actuels analysent le SQL avec DuckDB
   (`_reject_forbidden_statements`, `_reject_copy_to_file`), et `READ_ONLY` sert de
   filet. Ni l'un ni l'autre ne couvrent une chaîne envoyée brute à Doris.
   Proposition : passthrough réservé au SQL généré par l'app (jamais au SQL libre),
   vérifié côté serveur comme un unique `SELECT` dans le dialecte cible. Faut-il en
   plus **exiger** un compte en lecture seule pour `doris` (test à la connexion :
   un `CREATE TABLE` doit échouer), ou seulement avertir ?
2. **Annulation.** Interrompre DuckDB ne tue pas forcément la requête côté Doris.
   À vérifier ; sinon `KILL QUERY` (Doris/MySQL) ou `pg_cancel_backend` (Postgres)
   à l'arrêt et à la pause.
3. **Ordre de la phase 2** : proposé comptage des concepts → catalog → extraction du
   mapping → DQ → statistiques/patients/cohortes.
4. **Librairies R / Python** : leur ajouter un `remote_query()` dans ce chantier, ou
   plus tard ?
5. **Dériver une database depuis une cohorte** : le filtre
   `IN (SELECT … FROM _members)` porte sur une table temporaire locale, donc n'est
   pas poussé ; chaque table source est rapatriée en entier, **déjà aujourd'hui
   avec Postgres**. Corriger ici ou à part ?
6. **Image Docker** : y installer l'extra `doris` (+ ≈ 24 Mo) pour que les
   installations Docker aient Flight sans rien faire, ou non ?
7. **Incohérence trouvée en passant** (hors Doris) : le validateur de
   `linkr-format` refuse tout `connectionConfig` dans un manifeste de database
   (`validate/entities.ts:248-254`), alors que l'app en exporte un réduit à
   `{engine, …}`. À traiter à part.

---

## Annexe A — Doris de test en local

`docker compose -p linkr-doris -f <fichier> up -d`, puis base `omop` chargée par
Stream Load Parquet (`curl -H "format: parquet" -T f.parquet
http://127.0.0.1:8040/api/omop/<table>/_stream_load` depuis le conteneur BE).
Tables : `DUPLICATE KEY(<1re colonne>) DISTRIBUTED BY HASH(…) BUCKETS 1`,
`replication_num = 1` ; une clé ne peut pas être `DOUBLE`. Compte en lecture
seule : `CREATE USER 'linkr_ro'@'%' IDENTIFIED BY '…'; GRANT SELECT_PRIV ON
internal.omop.* TO 'linkr_ro'@'%';`.

```yaml
name: linkr-doris
services:
  fe:
    image: apache/doris:fe-4.1.4
    environment: { FE_SERVERS: "fe1:172.30.80.2:9010", FE_ID: "1" }
    # Le FE réserve 8 Go de heap par défaut : trop pour une VM Docker Desktop.
    entrypoint: ["bash", "-c", "sed -i 's/-Xmx8192m -Xms8192m/-Xmx2048m -Xms1024m/' /opt/apache-doris/fe/conf/fe.conf && exec bash init_fe.sh"]
    working_dir: /opt/apache-doris
    ports: ["8030:8030", "9030:9030", "8070:8070"]
    volumes: ["fe-meta:/opt/apache-doris/fe/doris-meta"]
    networks: { doris: { ipv4_address: 172.30.80.2 } }
  be:
    image: apache/doris:be-4.1.4
    environment: { FE_SERVERS: "fe1:172.30.80.2:9010", BE_ADDR: "172.30.80.3:9050", SKIP_CHECK_ULIMIT: "true" }
    # public_host : adresse que le FE donne aux clients Flight pour joindre ce BE.
    entrypoint: ["bash", "-c", "sed -i 's/-Xmx2048m/-Xmx1024m/' /opt/apache-doris/be/conf/be.conf && printf 'mem_limit = 3G\\npublic_host = 127.0.0.1\\narrow_flight_sql_proxy_port = 8050\\n' >> /opt/apache-doris/be/conf/be.conf && exec bash entry_point.sh"]
    working_dir: /opt/apache-doris
    ports: ["8040:8040", "8050:8050"]
    volumes: ["be-storage:/opt/apache-doris/be/storage"]
    depends_on: [fe]
    networks: { doris: { ipv4_address: 172.30.80.3 } }
volumes: { fe-meta: {}, be-storage: {} }
networks:
  doris: { ipam: { config: [{ subnet: 172.30.80.0/24 }] } }
```
