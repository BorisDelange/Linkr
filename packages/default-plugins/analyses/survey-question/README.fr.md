Une question d'un questionnaire, analysée correctement : combien de personnes y
ont répondu, comment les réponses se distribuent, et le graphique réellement
adapté au type de la question. Le plugin lit les métadonnées exportées par les
outils d'eCRF — Goupile, REDCap, LimeSurvey — et sait donc distinguer une échelle
de 1 à 5 d'une liste libre, et reconnaître qu'une question à choix multiples
répartie sur huit colonnes booléennes est *une seule* question.

Un questionnaire n'est pas un jeu de colonnes indépendantes. Ses colonnes
portent un ordre de réponses déclaré, un texte de question et une structure
qu'un plugin de graphique générique jette dès qu'on le pointe sur une colonne.
Analyser un item de Likert comme une variable catégorielle triée par fréquence
détruit précisément ce qui en faisait une échelle ; analyser une question à
réponses multiples colonne par colonne donne huit nombres et aucune question.

Le plugin traite délibérément une question à la fois. Un questionnaire se lit
item par item, et le nombre le plus important pour chacun — son taux de réponse
— est propre à l'item, pas au questionnaire.

## Réglages

Un jeu de données avec une ligne par répondant, et une **Question**. Vous pouvez
choisir n'importe quelle colonne appartenant à la question ; pour une question à
choix multiples, sélectionner une de ses colonnes d'option sélectionne la
question entière, et le widget réassemble les options en une distribution
unique.

**Graphique** ne propose ensuite que les représentations adaptées à cette
question. C'est une contrainte, pas un oubli : un camembert affirme que les
parts sont des portions exclusives d'un tout, ce qu'une question à choix
multiples n'est justement pas — il n'y est donc pas proposé. *Auto* choisit pour
vous : des barres pour des catégories, un histogramme pour une réponse
numérique, une liste de réponses pour du texte libre.

- **Liste des réponses** pour les questions ouvertes, où les réponses sont le
  résultat.
- **Barres horizontales** dès que les libellés d'options sont longs, ce qui est
  le cas de la plupart des questionnaires.
- **Barres verticales** quand les réponses ont un ordre naturel de gauche à
  droite.
- **Camembert** / **Anneau** uniquement pour une question à réponse unique et à
  peu d'options.
- **Histogramme** pour les réponses numériques, avec **Classes** et une
  **Médiane**.
- **Statistiques descriptives** et **Tableau** quand les chiffres comptent plus
  que la forme.

## Notes sur la méthode

### Le taux de réponse est le premier chiffre à lire

**Taux de réponse** affiche n/N : combien de répondants ont répondu à *cette*
question, sur l'ensemble du jeu de données. Laissez-le activé. C'est ce chiffre
qui détermine sur quoi porte le reste du graphique.

Une distribution calculée sur 40 % des répondants décrit ces 40 %, pas votre
cohorte — et les personnes qui sautent une question sont rarement un
échantillon aléatoire de celles qui y répondent. Celles qui n'ont pas répondu à
« combien d'heures supplémentaires avez-vous faites le mois dernier ? » diffèrent
systématiquement de celles qui l'ont fait, et précisément dans la direction dont
traite la question. Un taux de réponse de 92 % rend la distribution à peu près
interprétable comme un énoncé sur la cohorte ; un taux de 45 % en fait un énoncé
sur les répondants, et un compte rendu honnête le dit.

C'est la non-réponse partielle, qui vient s'ajouter au taux de réponse du
questionnaire lui-même. Une enquête envoyée à 400 cliniciens, remplie par 180,
avec 96 personnes répondant à cet item, décrit 24 % des personnes sollicitées.
Ces trois chiffres ont chacun leur place dans la section méthodes.

### Manquant, « non applicable » et « ne souhaite pas répondre » sont trois choses différentes

> [!WARNING]
> **Un graphique en barres écrase trois types de non-réponse en un seul vide.**
> Un répondant qui n'a jamais vu la question (la logique du questionnaire l'a
> contournée), un autre qui l'a vue et a coché « non applicable », et un
> troisième qui a refusé de répondre ne sont pas interchangeables, et seuls les
> deux derniers figurent dans vos données comme des valeurs. Avant de lire le
> moindre pourcentage, sachez sur quel dénominateur vous êtes : exclure de N les
> répondants contournés est en général correct, exclure les refus l'est en
> général pas, et un graphique ne vous dit pas à quel type de vide vous avez
> affaire. Deux graphiques d'apparence identique, l'un sur un dénominateur de
> 400 et l'autre de 96, soutiennent des affirmations entièrement différentes.

La règle pratique : fixez le dénominateur dans le jeu de données, en amont,
avant le graphique. Si une question n'a été posée qu'au sous-groupe ayant
répondu oui à une question filtre, son dénominateur est ce sous-groupe, et le
n/N du widget doit le refléter. Alimenter le widget avec toute la cohorte puis
corriger mentalement après coup, c'est ainsi qu'un 78 % devient un 34 % entre le
tableau de bord et l'article.

Indépendamment du comportement d'**Exclure NA / vide**, une option explicite
« ne souhaite pas répondre » est une donnée réelle et mérite de rester sur le
graphique. **Masquer non choisies** est décoché par défaut pour la même raison :
une option que personne n'a retenue est un résultat, pas du bruit visuel. Ne
l'activez que lorsqu'une longue liste d'options rend le graphique illisible, et
dites-le.

### Choix multiples : les pourcentages ne feront pas 100

Quand une question autorise plusieurs cases, le plugin réassemble ses colonnes
et indique, pour chaque option, combien de répondants l'ont sélectionnée. Ces
pourcentages totalisent bien plus de 100 — c'est arithmétiquement correct, et
cela se lit comme une erreur pour qui n'a pas été prévenu.

Énoncez donc le dénominateur sur le graphique lui-même. Utilisez **Titre** pour
l'écrire : « Quels dispositifs de monitorage utilisez-vous ? (% de 180
répondants, plusieurs réponses possibles) » ne laisse rien à deviner. Régler
**Étiquettes** sur *n et %* aide encore, car l'effectif brut est sans ambiguïté
là où un pourcentage ne l'est pas.

**Options au maximum** regroupe tout ce qui dépasse les *n* premières en
« Autres » plutôt que de l'écarter, si bien que les effectifs restent justes ;
laissez ce réglage à 0 pendant l'exploration et ne le fixez que pour la
présentation. Notez que sur une question à réponses multiples, « Autres » est un
sac d'options sans rapport entre elles, pas une catégorie : c'est honnête comme
troncature visuelle et trompeur comme résultat.

### Les réponses ordinales doivent conserver leur ordre

Un item de Likert — *jamais / rarement / parfois / souvent / toujours* — porte
son sens dans la séquence. Le trier par fréquence produit un graphique où
« parfois » se retrouve entre « jamais » et « toujours » parce qu'il a été choisi
plus souvent, et la forme de la distribution, qui est tout l'enjeu, est détruite.

**Tri** est donc réglé par défaut sur *Par fréquence* pour les catégories non
ordonnées, et les échelles détectées comme telles conservent toujours l'ordre du
questionnaire quoi qu'il arrive. Quand le plugin ne parvient pas à détecter
l'ordre — une colonne importée sans métadonnées, ou des options formulées d'une
manière qu'il ne sait pas analyser — réglez **Tri** sur *Personnalisé* et
utilisez **Ordre des réponses** pour glisser les réponses dans la bonne séquence
à la main. Faites-le une fois et le graphique est correct ensuite.

*Ordre du questionnaire* est l'autre réglage utile : il reprend l'ordre de
déclaration des options, c'est-à-dire celui dans lequel les répondants les ont
effectivement vues. Cela compte quand vous suspectez un effet d'ordre, car les
répondants choisissent de façon disproportionnée les premières options d'une
longue liste.

## Un exemple travaillé

*À quelle fréquence nos infirmiers de réanimation utilisent-ils le protocole de sédation ?*

Un export Goupile, une ligne par répondant, 180 réponses à une enquête envoyée à
400 professionnels.

1. **Question** → l'item de fréquence d'utilisation du protocole de sédation.
2. **Taux de réponse** → activé. Il affiche 152/180 : 28 personnes ont sauté
   l'item, donc tous les pourcentages ci-dessous sont sur 152.
3. **Tri** → *Ordre du questionnaire* si l'échelle est détectée, sinon
   *Personnalisé* avec **Ordre des réponses** glissé en jamais / rarement /
   parfois / souvent / toujours.
4. **Graphique** → *Barres verticales*, pour que l'échelle se lise de gauche à
   droite.
5. **Étiquettes** → *n et %*, et **Titre** → « Utilisation du protocole de
   sédation (n = 152 sur 180 répondants, 400 sollicités) ».

Lisez la forme, pas la réponse modale. Une distribution qui s'accumule sur
« toujours » avec une petite queue sur « jamais » décrit une unité différente
d'une distribution plate sur les cinq niveaux, même si « toujours » est la
réponse la plus fréquente dans les deux cas.

Ce qui rendrait ce résultat trompeur : annoncer 71 % de « souvent ou toujours »
sans les dénominateurs. Ces 71 % portent sur 152 répondants à l'item, qui
représentent 38 % des professionnels sollicités — et les infirmiers qui
n'utilisent jamais le protocole sont précisément les moins susceptibles d'avoir
répondu à une enquête à son sujet. Le chiffre est défendable avec ses trois
dénominateurs et indéfendable sans eux.

## Pour aller plus loin

- [Eysenbach G, *Improving the quality of web surveys: CHERRIES*](https://pmc.ncbi.nlm.nih.gov/articles/PMC1550605/) — la liste de contrôle des enquêtes en ligne : taux de vue, de participation, de complétion, et pourquoi les trois sont nécessaires.
- [Sullivan GM & Artino AR, *Analyzing and interpreting data from Likert-type scales*](https://pmc.ncbi.nlm.nih.gov/articles/PMC3886444/) — ce qu'on peut et ne peut pas faire de réponses ordinales, en deux pages.
- [Sterne JAC et al., *Multiple imputation for missing data: potential and pitfalls*](https://pmc.ncbi.nlm.nih.gov/articles/PMC2714692/) — quand la non-réponse peut être traitée statistiquement, et quand elle ne le peut pas.
- [Little RJ et al., *The prevention and treatment of missing data in clinical trials*](https://pmc.ncbi.nlm.nih.gov/articles/PMC3771340/) — la thèse selon laquelle les données manquantes se préviennent par le protocole, pas par l'analyse.
- [Streit M & Gehlenborg N, *Bar charts and box plots*](https://www.nature.com/articles/nmeth.2807) — quand un graphique en barres est la bonne représentation et quand il masque la distribution.
