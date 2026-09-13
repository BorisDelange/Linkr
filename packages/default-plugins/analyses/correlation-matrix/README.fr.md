## Introduction

Une matrice de corrélation répond d'un coup, pour chaque paire de variables, à
une seule question : quand celle-ci augmente, est-ce que celle-là augmente
aussi, et avec quelle régularité ?

C'est un outil d'exploration. Bien utilisée, c'est le moyen le plus rapide de
voir la structure d'un tableau de nombres — quelles variables voyagent
ensemble, lesquelles sont redondantes, où un modèle va buter sur de la
colinéarité. Mal utilisée, c'est une machine à produire des résultats qui
n'existaient pas.

![Heatmap de corrélation de huit variables de réanimation, avec une case rouge
foncé à 0,95 entre la CRP et la ferritine.](attachments/output.fr.png)

Ci-dessus : le 0,95 rouge foncé entre CRP et ferritine est la case sur laquelle
agir — deux colonnes porteuses de la même information, dont l'entrée conjointe
dans une régression rendrait les deux coefficients instables. Sur la ligne de
la durée de séjour, le 0,35 avec le score de gravité mérite d'être creusé ; le
−0,05 avec la créatinine n'est pas une preuve que la créatinine ne joue aucun
rôle, seulement qu'aucune relation *monotone* n'apparaît ici.

## Réglages

Des colonnes numériques, au moins deux. Les identifiants sont décochés par
défaut dans **Variables** — un identifiant patient ne corrèle avec rien d'utile
et ne fait qu'encombrer une grille dont le côté est le nombre de variables
retenues.

Chaque paire est calculée sur les lignes où les **deux** variables sont
renseignées : une colonne avec beaucoup de données manquantes contribue donc
discrètement moins de paires que ses voisines. L'en-tête affiche l'effectif
total ; le nombre de paires derrière une case donnée peut être bien inférieur.

## Notes sur la méthode

### Ce que mesure le coefficient

Chaque case contient un coefficient compris entre −1 et +1 :

- le **signe** — positif, les deux variables évoluent dans le même sens ;
  négatif, l'une monte quand l'autre descend ;
- l'**intensité** — à quel point les points suivent cette tendance. 1 est une
  droite parfaite, 0 est l'absence de toute tendance ;
- la **diagonale** est chaque variable face à elle-même, donc toujours 1
  exactement. Elle est dessinée en gris neutre car elle ne porte aucun résultat.

La matrice est symétrique : la case au-dessus de la diagonale et celle
au-dessous portent le même nombre.

### Pearson ou Spearman

La **Méthode** est le réglage qui change ce que vous mesurez, et pas seulement
la façon de le calculer.

| | Pearson | Spearman |
| --- | --- | --- |
| Détecte | les relations linéaires | toute relation monotone |
| Travaille sur | les valeurs | les rangs des valeurs |
| Suppose | des données à peu près normales et symétriques | rien sur la forme de la distribution |
| Valeurs aberrantes | un seul point extrême peut créer ou détruire la corrélation | ne la déplacent quasiment pas |

C'est en santé que ce choix pèse le plus. Durées de séjour, durées de
ventilation, lactate, CRP, ferritine : distributions fortement asymétriques à
droite, avec une longue traîne de valeurs extrêmes parfaitement réelles.
**Spearman est en général le choix le plus sûr pour ces variables.** Gardez
Pearson quand les variables sont à peu près symétriques (âge, poids,
hémoglobine, une pression physiologique) ou quand vous voulez précisément
décrire une relation linéaire.

Une bonne habitude : lancer les deux. Quand Pearson et Spearman divergent
nettement, l'écart est en soi une information — il signale que quelques points
extrêmes, ou une relation courbe, pilotent l'un des deux coefficients.

### Lire la heatmap

La couleur porte la structure, le nombre porte l'ampleur. L'échelle va du bleu
en −1 au rouge en +1, en passant par le blanc en 0 : un bloc de cases fortement
colorées se voit avant même d'avoir lu un seul chiffre.

C'est à cela que sert l'**Ordre des variables**. En *Ordre du jeu de données*,
les variables restent telles qu'elles sont dans le fichier ; faites-les glisser
dans un ordre *Personnalisé* qui rapproche celles qui vont ensemble —
l'hémodynamique groupée, la biologie groupée, les critères de jugement à la fin
— et les familles de variables corrélées apparaissent comme des blocs.

**Afficher les valeurs** imprime le coefficient dans chaque case, **Afficher la
significativité** marque celles dont la p-value passe sous le **Seuil de
significativité (α)**, avec la convention habituelle (`*` p < 0,05, `**`
p < 0,01, `***` p < 0,001).

Il n'existe pas d'échelle universelle du « fort ». En données cliniques, un
r ≈ 0,7 entre deux mesures distinctes est déjà élevé, et au-delà de 0,9 les deux
colonnes mesurent en général deux fois la même chose.

### Les pièges

> [!WARNING]
> **Un coefficient proche de 0 ne signifie pas « pas de relation », mais « pas
> de relation *linéaire* ».** Une relation en U donne un r ≈ 0 tout en étant un
> effet fort et cliniquement majeur : pensez à la mortalité en fonction de la
> natrémie, ou de la fréquence cardiaque, où les deux extrêmes sont dangereux et
> le milieu protecteur. La matrice ne signalera rien. Le quartet d'Anscombe en
> est la démonstration classique : quatre jeux de données qui n'ont rien en
> commun visuellement, et rigoureusement le même coefficient de corrélation.
> Regardez le nuage de points avant de croire une case — dans un sens comme dans
> l'autre.

**Corrélation n'est pas causalité.** Deux variables peuvent évoluer ensemble
parce que l'une cause l'autre, parce que l'autre cause l'une, ou parce qu'une
troisième variable les détermine toutes les deux. En réanimation, la gravité
pilote presque tout, donc presque tout corrèle avec presque tout. Une matrice
classe des associations ; elle ne les explique pas.

**Les comparaisons multiples.** Une matrice 10 × 10 représente 45 tests
distincts. À α = 0,05, on s'attend à ce que deux d'entre eux environ soient
étoilés par pur hasard, même en l'absence totale de relation. À 20 variables, ce
sont 190 tests et une dizaine de fausses étoiles. Lisez les marqueurs comme un
« à regarder de plus près », jamais comme un verdict — et si une corrélation est
votre véritable hypothèse, testez-la seule, définie à l'avance.

**La taille d'échantillon rend tout significatif.** La p-value teste si r
diffère de zéro, pas s'il est assez grand pour avoir un intérêt. Sur
n = 10 000, un r de 0,03 — une relation qui explique 0,09 % de la variance —
ressort avec trois étoiles. Sur n = 30, un r réel de 0,4 peut ressortir sans
aucune étoile. Lisez toujours le coefficient d'abord, le marqueur ensuite.

**Les données manquantes.** Comme chaque paire utilise ses propres lignes
complètes, les cases d'une même matrice reposent sur des sous-populations
différentes — et des sous-populations différentes peuvent être des populations
différentes : si le lactate n'est dosé que chez les patients les plus graves,
ses corrélations décrivent ces patients-là, pas votre cohorte. Vérifiez le taux
de remplissage de chaque colonne avant de lire sa ligne.

## Un exemple travaillé

*Quels paramètres biologiques suivent la durée de séjour en réanimation ?*

Une ligne par séjour, avec les valeurs biologiques du jour d'admission
(lactate, créatinine, CRP, plaquettes, albumine), un score de gravité et la
durée de séjour en jours.

1. **Variables** → les colonnes de biologie, le score de gravité et la durée de
   séjour. Décochez l'identifiant de séjour.
2. **Méthode** → Spearman. La durée de séjour est très asymétrique et le lactate
   a une longue traîne ; avec Pearson, une poignée de séjours de 60 jours
   dicterait la réponse.
3. **Ordre des variables** → Personnalisé, en groupant la biologie et en plaçant
   la durée de séjour en dernier, pour que sa ligne se lise comme une bande le
   long du bord.
4. **Seuil de significativité (α)** → laissez 0,05, en gardant en tête que la
   matrice lance une vingtaine de tests.

Supposons que la ligne « durée de séjour » affiche ρ = 0,42 avec le score de
gravité, 0,31 avec le lactate et 0,04 avec la créatinine. Les deux premiers
méritent d'être creusés ; le troisième n'est pas une preuve que la créatinine
n'a aucun rôle — la relation peut simplement ne pas être *monotone*, et c'est le
nuage de points qui vous le dira.

Regardez ensuite le reste de la grille, pour l'autre usage d'une matrice : si la
CRP et la ferritine corrèlent à 0,88, n'introduisez pas les deux dans une
régression. C'est de la colinéarité, et elle rendra les deux coefficients
instables.

## Pour aller plus loin

- [Schober P et al., *Correlation Coefficients: Appropriate Use and Interpretation*](https://journals.lww.com/anesthesia-analgesia/fulltext/2018/05000/correlation_coefficients__appropriate_use_and.50.aspx) — Anesthesia & Analgesia ; le guide pratique, y compris sur le choix de Spearman.
- [Bland JM & Altman DG, *Correlation, regression, and repeated data*](https://www.bmj.com/content/308/6933/896) — BMJ Statistics Notes ; une page sur une erreur encore très répandue.
- [Bland JM & Altman DG, *Correlation in restricted ranges of data*](https://www.bmj.com/content/342/bmj.d556) — pourquoi la même relation donne un r différent dans une population plus étroite.
- [Anscombe FJ, *Graphs in Statistical Analysis*](https://www.jstor.org/stable/2682899) — le quartet : statistiques identiques, quatre jeux de données incompatibles.
- [Altman DG & Krzywinski M, *Association, correlation and causation*](https://www.nature.com/articles/nmeth.3587) — Nature Methods, série Points of Significance.
