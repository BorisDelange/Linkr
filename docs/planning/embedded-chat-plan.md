# Chat intégré — Linkr par-dessus l'API Agents de LibreChat

**Problème.** Aujourd'hui l'agent vit dans un autre onglet (LibreChat) et agit sur
Linkr par le MCP `linkr`. Ça marche, mais rien de ce que l'agent produit n'appartient
à l'app : un lien vers une cohorte ne l'ouvre pas, un aperçu reste du texte, une
confirmation se fait ailleurs que là où on travaille.

**Décision.** C'est l'option (a) de [`../design/ai-agents-plan.md`](../design/ai-agents-plan.md)
§5 : **Linkr affiche le chat, LibreChat fait tourner l'agent.** Modèles, clés de
fournisseurs, quotas, prompts et skills restent configurés dans LibreChat ; Linkr n'a
toujours aucune configuration de modèle (§2 du design).

**Périmètre.** Un panneau de chat **global, disponible partout dans l'app** (pas par
page, pas par projet), en mode serveur uniquement. Sans LibreChat configuré, le panneau
n'existe pas.

---

## 1. Ce que l'API de LibreChat permet — vérifié dans le code

Vérifié le 2026-10-05 dans le code source de LibreChat (`main`, commit `f10b1d9` du
2026-09-30). L'API est encore jeune : **à revérifier avant chaque étape**.

| Besoin | Possible ? | Comment |
|---|---|---|
| Envoyer un message, streamer la réponse | ✅ | `POST /api/agents/v1/responses` (spécification Open Responses), `model` = id de l'agent, `stream: true`. Il existe aussi `/v1/chat/completions` (compatible OpenAI). |
| Lister les agents disponibles | ✅ | `GET /api/agents/v1/responses/models` |
| S'authentifier | ✅ | **clé d'API d'agent** créée par l'utilisateur dans LibreChat, ou **jeton OIDC** (`endpoints.agents.remoteApi.auth.oidc`, IdP partagé). Le rôle doit avoir `interface.remoteAgents.use: true`. |
| Créer cette clé à la place de l'utilisateur | ❌ | `POST /api/api-keys` exige la session navigateur LibreChat (`requireJwtAuth`). |
| Enregistrer la conversation dans LibreChat | ✅ en option | `store: true` (désactivé par défaut) ; la suite passe par `previous_response_id`. |
| **Lister / supprimer les conversations** | ❌ | `/api/convos` exige la session navigateur LibreChat ; une clé d'API ou un jeton OIDC n'y donnent pas accès. `GET /v1/responses/:id` relit une réponse, rien de plus. |
| **Approbation des outils** (`toolApproval`) | ❌ par l'API | Les runs de l'API sont lancés avec `hitlCapable = false` : un outil réglé sur `ask` est **bloqué**, pas mis en pause. Seule l'interface de LibreChat sait demander une confirmation. |
| **Outils exécutés par l'appelant** (« client tools ») | ✅ | L'appelant déclare des `tools: [{type: "function", …}]`. Quand le modèle en appelle un, la run s'arrête et renvoie un `function_call` ; l'appelant l'exécute et relance en **rejouant tout l'historique** dans `input` (`function_call` + `function_call_output`). Contrainte : l'appel doit être le seul appel d'outil du tour. `previous_response_id` ne transporte pas ces échanges. |
| Gérer agents et skills | partiel | `/api/agents/v1/agents` et `/v1/skills` (lecture, mise à jour, fichiers), sous une authentification de gestion distincte. Rien n'est prévu côté Linkr à ce stade. |
| Ressources MCP-UI (`cohort_report`) | 🤔 | non vérifié pour l'API Responses ; sans objet si Linkr rend lui-même le rapport (§4). |

## 2. L'historique appartient à Linkr

Deux constats imposent ce choix : LibreChat ne permet pas de supprimer une conversation
par l'API, et dès qu'un client tool intervient, la seule continuation possible est le
rejeu complet de l'historique.

- **LibreChat sans état** : Linkr envoie `store: false` et rejoue l'historique dans
  `input` à chaque tour.
- **Linkr stocke** les conversations (`ChatConversation`, `ChatMessage`, propres à
  l'utilisateur) : liste, recherche, renommage, **suppression réelle**, « tout
  supprimer », et une durée de rétention configurable par l'admin.
- **Conséquence acceptée** : ces conversations n'apparaissent pas dans l'interface de
  LibreChat. C'est le prix de la suppression. En contexte clinique, une conversation
  peut contenir des données patients : elle doit rester visible et supprimable par son
  auteur (design §10).
- Rejeté : `store: true`, qui crée une copie dans LibreChat que Linkr ne peut ni lister
  ni supprimer.

## 3. Qui exécute les outils, et avec quelle clé — 🤔 à trancher par le spike

Pour parler à LibreChat, Linkr doit présenter une identité que LibreChat connaît, et
LibreChat ne délivre ses clés qu'à une session ouverte dans son interface. Linkr ne peut
donc pas la créer pour l'utilisateur. Il reste deux montages.

| | **A. Outils côté LibreChat** | **B. Outils côté Linkr** (recommandé) |
|---|---|---|
| Qui appelle `linkr` | LibreChat, par le MCP, avec la clé `lnk_…` de l'utilisateur | Linkr lui-même, comme l'utilisateur connecté : les outils sont déclarés comme client tools |
| Clé côté Linkr | **une clé LibreChat par utilisateur**, collée une fois dans son profil (scellée AES-GCM, jamais renvoyée) | **une seule clé de service**, posée par l'admin (`LINKR_LIBRECHAT_API_KEY`) ; rien à faire pour l'utilisateur |
| Clé `lnk_…` dans LibreChat | nécessaire | inutile pour le chat intégré (toujours utile pour LibreChat en direct) |
| Confirmation des écritures | impossible par l'API → outils en `allow` ; seul filet : journal + annulation | **native dans Linkr** : carte « Confirmer / Annuler » avant chaque écriture ou suppression |
| Navigation, aperçus | par convention dans le texte | **outils d'interface** (§4) dans le même mécanisme |
| Quotas et audit LibreChat | par utilisateur | sur le seul compte de service ; l'audit par utilisateur est dans Linkr |
| Coût | normal | un aller-retour Linkr ↔ LibreChat par appel d'outil, historique rejoué à chaque fois |

**Recommandation : B.** C'est le plus simple pour l'utilisateur (aucune clé), la
confirmation revient dans l'app, et les droits restent ceux de l'utilisateur connecté,
puisque c'est Linkr qui exécute. Les outils restent ceux du MCP `linkr` : le backend Linkr
les appelle avec un jeton court émis pour l'utilisateur connecté, sans réécrire de
logique. Ce qu'il faut mesurer avant de s'engager : la latence et le volume de tokens
du rejeu, et la discipline du modèle sur « un seul client tool par tour ». Si la latence
est rédhibitoire, A reste possible sans toucher à l'interface.

Plus tard, si Linkr gagne l'OIDC (`auth_provider` n'implémente que `local`
aujourd'hui), un IdP partagé avec LibreChat ferait passer le jeton de l'utilisateur
directement : quotas par utilisateur, sans aucune clé.

## 4. Ce que le chat intégré apporte — l'intérêt même du projet

Tout ce qui suit passe par des client tools : le modèle les appelle, et c'est le front
de Linkr qui les exécute.

- **Navigation dans l'app** : `open_in_linkr(route)` ouvre la page sans quitter le
  chat. Les liens Markdown vers des routes Linkr sont interceptés et passent par le
  router, sans nouvel onglet.
- **Entités cliquables** : une cohorte, un dataset, un dashboard ou un patient cité
  s'affiche comme une puce (icône + nom) qui ouvre l'entité.
- **Aperçus intégrés** : effectif + attrition d'une cohorte, extrait d'un dataset,
  rapport de cohorte en HTML, rendus avec les composants de l'app plutôt qu'en texte.
- **Confirmation** (montage B) : carte avant écriture ou suppression, avec l'action en
  langage métier ; l'exécution de scripts reste confirmée (design décision 12).
- **Contexte implicite** : le résultat de `get_ui_context` (page, projet, entité
  ouverte) part dans `instructions` à chaque tour, sans appel d'outil, pour que « cette
  cohorte » soit compris d'emblée.
- **Après coup** : chaque écriture remonte déjà dans la cloche avec son annulation
  (`Notification.undo`) ; le chat affiche « Annuler ce tour » en reprenant ce mécanisme.

## 5. Interface

- **Panneau latéral global**, ouvert depuis le header (bouton + raccourci), redimensionnable,
  qui **reste ouvert pendant la navigation** : c'est ce qui permet « ouvre-moi ça » sans
  perdre la conversation.
- Liste des conversations (recherche, renommage, suppression, tout supprimer), nouvelle
  conversation, choix de l'agent (liste tirée de LibreChat), streaming, bouton Stop.
- Lignes d'outils en deux modes, repris du design §5 : **clinicien** (une phrase métier
  par appel, table `nom d'outil → phrase i18n`) et **développeur** (arguments, sortie).
- À récupérer dans l'historique git : l'interface de confirmation et d'annulation et le
  rendu replié des appels d'outils de `DashboardAgentSidebar.tsx` (commit `4a1681fd`).

## 6. Configuration

| Où | Quoi |
|---|---|
| LibreChat (`librechat.yaml`) | rôle avec `interface.remoteAgents.use: true` ; un ou plusieurs agents partagés avec le compte qui appellera l'API ; en montage A, le MCP `linkr` déclaré avec « chaque utilisateur fournit sa clé ». |
| Linkr (`.env` / compose) | `LINKR_LIBRECHAT_URL` (absente = pas de chat) ; montage B : `LINKR_LIBRECHAT_API_KEY` ; option : agent par défaut, durée de rétention. |
| Linkr (profil, montage A seulement) | carte « Connexion à LibreChat » : lien vers la page des clés de LibreChat, champ pour coller la clé, bouton Tester. |

Docker compose (service LibreChat optionnel, `librechat.yaml` pré-rempli) : plus tard.

## 7. Ordre

| St | # | Étape | Effort |
|----|---|---|---|
| 🔜 | 1 | **Spike** : LibreChat local, un agent, appel Responses depuis un script ; mesurer le montage B (client tools, rejeu, latence, tokens, un appel par tour) sur 3–4 tâches de cohorte | S |
| 🤔 | 2 | Trancher A / B (§3) au vu du spike | — |
| 🔜 | 3 | Backend : proxy streaming `POST /chat/…` vers LibreChat (la clé ne sort jamais du serveur), modèles `ChatConversation` / `ChatMessage` + migration, routes de liste / suppression | M |
| 🔜 | 4 | Montage B : exécution des outils `linkr` par le backend pour l'utilisateur connecté, cartes de confirmation | M |
| 🔜 | 5 | Front : panneau global, liste des conversations, streaming, lignes d'outils, i18n EN/FR | M |
| 🔜 | 6 | Outils d'interface : `open_in_linkr`, puces d'entités, aperçus cohorte / dataset, interception des liens | M |
| 💤 | 7 | Docker compose avec LibreChat optionnel | S |
| 💤 | 8 | Docs utilisateur (linkr-website) | S |

## 8. Questions ouvertes

- Le montage B tient-il en latence avec ~6k tokens d'outils et l'historique rejoué à
  chaque appel d'outil ? (spike)
- Un modèle local respecte-t-il « un seul client tool par tour » ? Sinon, Linkr doit
  rejeter proprement un tour mixte.
- Rétention par défaut des conversations : aucune limite, ou N jours fixés par l'admin ?
