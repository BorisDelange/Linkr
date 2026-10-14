# Apache Doris comme database externe — et calcul déporté sur la base distante

**Objectif.** Brancher un entrepôt Apache Doris comme database Linkr (mode serveur),
avec des calculs lourds aussi rapides que Doris le permet. Le problème de fond
(§1.2) touche aussi Postgres et MySQL ; seul Doris est déporté pour l'instant
(§1.4, §3.2).

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

### 1.4 Traduire, oui — mais typé, vérifié, et en liste blanche

sqlglot seul (DuckDB → Doris) : 3 requêtes types sur 6. Avec les règles de
`remote_sql.py` (types lus dans l'`information_schema` distant, liste blanche,
réécritures `FILTER`/`GROUP BY ALL`/`BY NAME`/`UNNEST`/`AGE`/`md5_number_lower`/
percentiles), sur 555 requêtes réelles de l'app (mapping OMOP 5.4, démo MIMIC-IV) :
**437 calculées par Doris, 0 résultat différent** de l'`ATTACH`, les autres restant
sur l'`ATTACH`. Banc de comparaison : annexe B.

| Sur 3,4 M lignes, Doris | `ATTACH` | Calcul déporté |
|---|---|---|
| Unité « records » du comptage des concepts | 14,7 s | **0,48 s** |
| Unité « patients » | 3,3 s | 0,79 s |

Postgres local, mêmes unités : 0,65 → 0,37 s pour « records », mais 0,48 → **3,16 s**
pour « patients » (`COUNT(DISTINCT)` mono-cœur) — d'où Postgres non déporté (§3.2).

---

## 2. Construit (2026-10-09, branche `feature/doris`)

Le détail est dans `docs/architecture.md` § Fullstack Storage & Compute
(« External databases & compute pushdown »). En bref :

- moteur `doris` (MySQL, port 9030), `ATTACH` sans `READ_ONLY`, **compte en lecture
  seule exigé** (vérifié par `SHOW GRANTS` à chaque connexion) ;
- calcul déporté par traduction typée côté serveur, activé par défaut pour le SQL de
  l'app, jamais pour le SQL d'un utilisateur ou du modèle ; repli `ATTACH` pour ce qui
  n'est pas portable ou que Doris refuse de préparer, jamais pour une erreur
  d'exécution ;
- annulation réelle : `KILL QUERY` envoyé à Doris (Pause/Stop) ;
- Flight SQL (extra `doris`, facultatif) pour les résultats volumineux, sondé, avec
  bandeau d'avertissement sur la page de la database quand il manque ou est
  injoignable ; port Flight local à la machine, son changement oublie les logins ;
- générateurs réécrits en SQL standard : bornes des tranches de patients, pyramide
  des âges.

Décisions prises en chemin (anciennes questions du §5) : compte en lecture seule
**exigé** ; passthrough limité au SQL de l'app ; `KILL QUERY` pour l'annulation.

---

## 3. Reste à faire

### 3.1 À tester dans l'app (Doris de l'annexe A)

- Ajouter une database Doris : compte `linkr_ro` accepté, `root` refusé avec le motif.
- Comptage des concepts, catalog, extraction du mapping, DQ, statistiques, liste des
  patients, cohorte figée : résultats identiques à une copie Parquet de la même base.
- Pause/Stop pendant une unité longue : la requête disparaît de `SHOW PROCESSLIST`.
- Bandeau Flight : extra absent, puis port Flight faux, puis correct.

### 3.2 Ouvert 🤔

1. **Image Docker** : extra `doris` installé dans `Dockerfile.api` (+ ≈ 24 Mo) et
   `host.docker.internal` défini dans `docker-compose.yml`. Les images du Hub ne
   l'auront qu'à la prochaine release.
2. **Postgres** : traduit mais non déporté (`PUSHDOWN_ENGINES`). À mesurer sur un vrai
   Postgres distant (réseau) avant de l'activer, éventuellement par type de requête.
3. **SQL écrit par l'utilisateur** : la liste blanche le rendrait sûr et identique ;
   le déporter aussi (éditeurs SQL, `create_dataset_from_query`) ?
4. **Librairies R / Python** : `remote_query()` ?
5. **Dériver une database depuis une cohorte** : `IN (SELECT … FROM _members)` sur
   une table locale n'est pas poussé ; chaque table source est rapatriée en entier,
   **déjà avec Postgres**. À corriger à part.
6. **Incohérence hors Doris** : le validateur de `linkr-format` refuse tout
   `connectionConfig` dans un manifeste de database (`validate/entities.ts:248-254`),
   alors que l'app en exporte un réduit à `{engine, …}`.

### 3.3 Chemins encore lents sur Doris

| Chemin | Pourquoi | Piste |
|---|---|---|
| Assemblage de la liste des concepts | `LEFT JOIN` du dictionnaire entier sur une vue locale (les unités) : non portable, tout le dictionnaire passe par MySQL | lire le dictionnaire seul en calcul déporté (Flight), joindre localement |
| `MIN(ts)::VARCHAR` des statistiques | DuckDB n'écrit les fractions de seconde que non nulles | renvoyer le timestamp, le formater côté client |
| Profils de l'extraction (`mode()`) | départage des égalités propre à chaque moteur | `mode` portable par `GROUP BY … ORDER BY count DESC, valeur LIMIT 1` |
| Une colonne NULL comblée puis `CAST` | type inconnu après comblement | typer le `NULL` d'après la colonne attendue |
| ETL source Doris, dérivation de cohorte, librairies R/Python | `ATTACH` direct | Flight / calcul déporté par table |

### 3.4 Documentation utilisateur (linkr-website)

Connecter un Doris : compte en lecture seule, port Flight, BE joignables
(`public_host`), ce que dit le bandeau.

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

## Annexe B — Banc de comparaison calcul déporté / `ATTACH`

Échantillonner le SQL réel de l'app (comptage des concepts, catalog, extraction,
DQ, statistiques, patients) avec un test Vitest temporaire qui enregistre les
requêtes des générateurs sur le mapping OMOP 5.4, puis exécuter chacune deux fois
sur Doris — telle quelle (`ATTACH`) et via `db_connect._pushed_down` — et comparer
noms de colonnes et lignes (ensembles, flottants arrondis à 1e-6, booléens typés).
Toute différence est un bug de `remote_sql.py` : la règle fautive doit refuser la
construction (`NotPortable`), pas l'approcher.
