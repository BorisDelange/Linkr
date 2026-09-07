## Introduction

Un seul plugin pour les graphiques du quotidien : nuage de points, lignes,
barres, histogramme, boîte à moustaches, violon. L'intérêt de les réunir est que
passer de l'un à l'autre ne demande qu'un réglage — et changer de graphique est
souvent la réponse honnête quand une figure ne dit pas ce qu'on croyait.

![Boîtes à moustaches de la durée de séjour en réanimation par motif
d'admission, les quatre nettement asymétriques à droite.](attachments/output.fr.png)

Ci-dessus : la durée de séjour par motif d'admission, un point par séjour et
non par ligne quotidienne. Chaque boîte est asymétrique à droite — la médiane
est basse dans la boîte et la moustache supérieure s'étire loin — ce qui est
déjà le résultat : c'est la médiane qu'il faut rapporter ici, pas la moyenne.

## Réglages

**Type de graphique** est le premier réglage, et les autres en découlent. Dans
**Données**, vous donnez ses colonnes au graphique — **Variable X**, **Variable
Y**, un **Groupe / Remplissage** facultatif — et vous décidez de ce qu'est une
ligne avec **Unique par** et **Fonction par entité**, puis de ce qui est écarté
avec **Exclure NA / manquants** et **Exclure les valeurs aberrantes** (et son
**Seuil**). Les histogrammes ajoutent un **Mode bins** avec **Barres** ou
**Largeur**, une **Orientation** et, en cas de groupe, un **Mode des barres**.
La section **Style** porte la présentation : **Titre** et légendes d'axes,
**Palette**, **Légende**, **Grille**, **Opacité (%)**, taille des points et des
barres, et **Axe X / Y commence à 0**.

### Quel graphique pour quelle question

Le type de graphique n'est pas un choix esthétique. Il découle de la question.

| Votre question | Type de graphique | Ce que vous fournissez |
| --- | --- | --- |
| Comment cette variable se distribue-t-elle ? | Histogramme | X = la variable numérique |
| Ces groupes ont-ils des distributions différentes ? | Boîte à moustaches, ou Violon | X = les groupes, Y = la variable numérique |
| Ces deux grandeurs sont-elles liées ? | Nuage de points | X et Y, tous deux numériques |
| Comment cela évolue-t-il dans le temps ? | Lignes | X = date ou temps, Y = la valeur |
| Combien, par catégorie ? | Barres | X = la catégorie, Y laissé vide |
| Quelle moyenne par catégorie ? | Barres | X = la catégorie, Y = la valeur numérique |

Un graphique en barres avec **Variable Y** vide compte les lignes ; avec un Y, il
en calcule la moyenne par catégorie — pas la somme. Les barres retiennent au plus
30 catégories, les boîtes et les violons au plus 20 : au-delà la figure est de
toute façon illisible, agrégez donc vos catégories en amont plutôt que d'espérer
que le graphique s'en sorte.

## Notes sur la méthode

### Une ligne par patient, ou une ligne par mesure ?

> [!WARNING]
> **L'unité de vos lignes est l'unité de votre graphique.** Un jeu de données
> comportant 40 créatinines par patient, tracé tel quel dans un histogramme,
> décrit des *mesures*, pas des *patients* — et les patients les plus graves, qui
> sont les plus prélevés, comptent 40 fois. Renseignez d'abord **Unique par**
> avec votre identifiant de patient ou de séjour, et choisissez une **Fonction
> par entité**, pour que le graphique décrive bien la population que vous croyez
> décrire.

**Unique par** réduit les lignes à une par entité avant tout le reste — avant la
suppression des valeurs manquantes, avant l'exclusion des valeurs aberrantes.
**Fonction par entité** décide comment :

- **Première valeur** / **Dernière valeur** conservent une ligne d'origine
  entière, dans l'ordre où les lignes arrivent dans le jeu de données. À réserver
  aux attributs constants sur toutes les lignes d'un patient (âge, sexe, unité
  d'admission) — ou triez votre jeu de données par date en amont si vous entendez
  « la dernière valeur mesurée », car le plugin ne trie pas pour vous.
- **Moyenne**, **Médiane**, **Min**, **Max**, **Somme** réduisent chaque colonne
  numérique du groupe. `Max` sur un score SOFA donne la gravité maximale du
  séjour ; `Moyenne` sur un lactate donne une exposition moyenne. Les colonnes
  non numériques conservent la valeur de la première ligne.

Ce choix est clinique, pas technique, et il a sa place dans vos méthodes : « SOFA
le plus élevé des 24 premières heures » et « SOFA moyen sur le séjour » sont deux
variables différentes, aux distributions différentes.

### Lire une boîte à moustaches, et quand préférer un violon

La boîte s'étend du premier au troisième quartile — la moitié centrale de vos
données. Le trait blanc à l'intérieur est la **médiane**, pas la moyenne. Les
moustaches vont jusqu'à la valeur la plus éloignée restant à moins de 1,5 fois
l'écart interquartile de la boîte, et s'arrêtent aux données si celles-ci
s'arrêtent avant.

Cette construction fait toute l'utilité de la boîte à moustaches : la hauteur de
la boîte donne la dispersion, la position de la médiane dans la boîte donne
l'asymétrie, la longueur des moustaches le comportement des queues. C'est aussi
ce qui la rend dangereuse — elle montre cinq nombres et masque tout le reste.
**Deux distributions très différentes peuvent produire la même boîte.** Le cas
d'école est une variable bimodale : un groupe partagé entre séjours courts et
séjours très longs reçoit une boîte centrée sur une durée que presque personne
n'a réellement eue.

Le **Violon** trace la densité estimée : une distribution à deux bosses ressemble
alors à deux bosses. Utilisez-le dès que les groupes sont assez fournis pour
qu'une forme ait un sens (quelques points produisent une courbe lisse
entièrement inventée), et gardez la boîte à moustaches pour comparer de nombreux
groupes côte à côte de façon compacte.

Ni l'une ni l'autre n'affichent l'effectif. Avec des groupes petits ou
déséquilibrés, mettez les effectifs dans le titre ou les légendes d'axes : une
comparaison de 8 patients contre 400 mérite d'en avoir l'air.

### Histogrammes : les classes font le récit

**Barres** (le mode par défaut, 20 classes) découpe l'étendue observée en autant
de tranches égales. **Largeur de barre** fixe au contraire la largeur et aligne
les bornes sur des multiples ronds — à préférer chaque fois que la largeur a un
sens : 1 jour pour une durée de séjour, 5 ans pour un âge, 0,5 pour un lactate.

Le nombre de classes est un vrai choix d'analyse, pas une décoration :

- **Trop de classes** et chacune ne contient que quelques patients ; les
  fluctuations aléatoires ressemblent à une structure, et l'on se met à
  interpréter du bruit.
- **Trop peu** et une structure réelle disparaît. Une seule classe large peut
  absorber tout un second mode.

Essayez deux ou trois réglages avant de croire à une forme. Si un motif survit à
plusieurs largeurs de classe, il est probablement réel ; s'il se déplace ou
s'évapore, il venait du découpage. Un cliquer-glisser sur le graphique zoome sur
une plage — les valeurs qu'elle contient sont redécoupées, ce qui évite qu'une
longue queue n'écrase la partie intéressante.

Une colonne X non numérique n'est pas découpée du tout : l'histogramme se rabat
sur le comptage de chaque valeur distincte, triées de la plus à la moins
fréquente.

### Exclure les valeurs extrêmes

**Exclure les valeurs aberrantes** écarte des lignes avant le tracé, selon l'une
de trois règles appliquées aux axes numériques :

- **IQR (Tukey)**, seuil 1,5 — hors de Q1 − 1,5·IQR … Q3 + 1,5·IQR. La règle par
  défaut, et la seule qui s'adapte à une distribution asymétrique.
- **Écart-type**, seuil 3 — hors de moyenne ± 3 écarts-types. Suppose une
  distribution à peu près symétrique ; sur une durée de séjour, elle coupera la
  queue de droite et rien à gauche.
- **Percentiles**, seuil 1 — conserve du 1er au 99e percentile. Elle retire
  toujours la même *proportion* de vos données, quelle que soit leur forme.

Servez-vous-en pour empêcher une erreur de saisie (un poids de 700 kg, une
fréquence cardiaque de 9000) d'aplatir tout le graphique. Ne vous en servez pas
pour rendre une distribution plus présentable : en réanimation, les valeurs
extrêmes sont fréquemment les patients dont l'analyse traite. Le plugin indique
sous le graphique « *n* valeurs aberrantes exclues » — reprenez ce nombre partout
où la figure circule, en précisant la règle qui l'a produit.

Notez que les bornes sont calculées *après* **Unique par**, sur les valeurs par
entité. C'est le bon ordre, mais cela signifie que changer d'agrégation change
les lignes exclues.

### Des axes qui ne partent pas de zéro

Par défaut, les axes s'ajustent aux données, arrondis vers l'extérieur jusqu'à la
graduation ronde suivante. **Axe X commence à 0** et **Axe Y commence à 0**
imposent l'origine.

La règle : **la longueur d'une barre code une quantité, une position non.** Un
graphique en barres tronqué à la base multiplie les écarts apparents par un
facteur arbitraire — c'est pourquoi les barres démarrent ici toujours leur axe
des valeurs à zéro. Sur un nuage de points ou une courbe, un axe resserré est
légitime et souvent nécessaire — personne ne veut d'une courbe de température
partant de 0 °C — à condition que l'axe soit légendé et l'étendue visible.

## Un exemple travaillé

*Les patients admis pour sepsis restent-ils plus longtemps que les autres ?*

Une ligne par journée de réanimation, avec un identifiant de séjour, une durée de
séjour et un motif d'admission.

1. **Type de graphique** → Boîte à moustaches.
2. **Unique par** → l'identifiant de séjour, **Fonction par entité** →
   *Première valeur*. La durée de séjour est un attribut du séjour, répété sur
   chaque ligne quotidienne ; sans ce réglage, le graphique pondère chaque séjour
   par sa propre durée, c'est-à-dire exactement par la variable étudiée.
3. **Variable X** → le motif d'admission, **Variable Y** → la durée de séjour.
4. Laissez **Exclure NA / manquants** activé ; laissez **Exclure les valeurs
   aberrantes** sur *Tout garder* pour un premier regard, afin de voir la longue
   queue avant de décider quoi que ce soit.

Les boîtes seront fortement asymétriques à droite — médianes basses dans la
boîte, longues moustaches supérieures. C'est normal pour une durée de séjour, et
c'est déjà un résultat : la moyenne résume mal ces données, et la médiane est le
nombre à rapporter.

Basculez ensuite le **Type de graphique** sur *Violon*. Si un groupe montre deux
bosses, vous regardez probablement deux populations mélangées — par exemple des
décès rapides et des convalescences lentes — et la médiane de ce groupe ne décrit
ni l'une ni l'autre. C'est une question qu'une boîte à moustaches n'aurait jamais
soulevée.

## Pour aller plus loin

- [Weissgerber TL et al., *Beyond bar and line graphs*](https://journals.plos.org/plosbiology/article?id=10.1371/journal.pbio.1002128) — pourquoi les barres de résumé masquent les données, et par quoi les remplacer.
- [Krzywinski M & Altman N, *Visualizing samples with box plots*](https://www.nature.com/articles/nmeth.2813) — ce qu'une boîte montre et ce qu'elle cache.
- [Streit M & Gehlenborg N, *Bar charts and box plots*](https://www.nature.com/articles/nmeth.2807) — quand chacun est approprié.
- [Cleveland WS & McGill R, *Graphical perception*](https://www.jstor.org/stable/2288400) — les expériences derrière « la position bat la longueur, qui bat l'aire ».
