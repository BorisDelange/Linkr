Un diagramme de Sankey suit *où vont les choses*. Chaque ruban est un groupe de
patients passant d'une étape à la suivante, et sa largeur est leur nombre — l'œil
lit donc directement le volume d'un parcours, sans avoir à faire de l'arithmétique
sur un tableau d'effectifs.

Il répond à des questions qu'un tableau traite mal : où la cohorte se divise-t-elle,
quel itinéraire porte le plus de patients, et — souvent le plus intéressant — où
les perd-on.

![Diagramme de Sankey des parcours hospitaliers : provenances à gauche,
réanimation au centre, devenirs à droite.](attachments/output.fr.png)

Ci-dessus : 320 séjours, de leur provenance à leur devenir. Lisez-le pour les
bifurcations plutôt que pour les totaux — le flux qui quitte le service et
revient en réanimation est un signal de réadmission, exactement le genre de
chose à quantifier proprement plutôt qu'à conclure de l'image.

## Réglages

**Forme des données** vient en premier, car ce réglage détermine les suivants.

| Vos données | Réglage | Ce que vous configurez |
| --- | --- | --- |
| Une ligne par étape (table de mouvements) | Long | *Unique par*, *Étape*, *Ordonner par* |
| Une colonne par niveau, déjà en large | Colonnes de niveaux | les colonnes, dans l'ordre |
| Une colonne contenant `« A;B;C »` | Chaîne de parcours | la colonne et son séparateur |

**Long** est la forme recommandée, et celle sous laquelle arrivent habituellement
les données hospitalières. **Unique par** est l'identifiant auquel appartiennent
les étapes — un identifiant de séjour ou de venue, pas un identifiant de patient
si celui-ci peut avoir plusieurs hospitalisations indépendantes. **Étape** est la
colonne portant la valeur de chaque étape. **Ordonner par** est ce qui ordonne les
étapes au sein de chaque entité : une date d'entrée dans l'unité, un numéro de
séquence. Laissez ce champ vide et le plugin se fie à l'ordre des lignes du jeu de
données, un pari qu'on souhaite rarement prendre.

**Fusionner les répétitions** est actif par défaut et réduit A→A à une seule
étape, pour qu'un séjour enregistré sur trois lignes consécutives dans la même
unité ne génère pas de boucles sur lui-même. **Libellé nœud final**, si vous le
renseignez, ajoute à chaque flux un dernier nœud portant ce libellé.

## Notes sur la méthode

### Trois usages où il excelle

**Les parcours patients.** Urgences → réanimation → service → sortie, avec toutes
les déviations visibles : les retours en réanimation, les transferts directs, les
décès à chaque étape.

**Les transitions d'état.** Statut ventilatoire à J1 → J3 → J7, épuration
extrarénale débutée puis arrêtée, une classe de gravité qui évolue.

**Les entonnoirs d'inclusion.** Screenés → éligibles → consentants → analysés.
Chaque rétrécissement est tracé à l'échelle, et les pertes sont aussi visibles que
les survivants : c'est exactement ce qu'un diagramme de flux d'article doit montrer.

### Ce que le diagramme compte réellement

Les colonnes de nœuds sont **positionnelles** : la première étape de chaque flux
occupe la colonne 1, la deuxième la colonne 2, et ainsi de suite. Une étape
survenant à deux moments différents apparaît en deux nœuds, dans deux colonnes,
partageant une même couleur. Un patient faisant réanimation → service →
réanimation produit donc deux nœuds « réanimation » distincts plutôt qu'une flèche
vers l'arrière : le diagramme se lit toujours de gauche à droite, et les
réadmissions se manifestent par une étape qui réapparaît plus à droite.

La valeur d'un lien est le nombre de flux effectuant cette transition à cette
position : en forme Long, un effectif d'entités ; en forme Niveaux ou Parcours, un
effectif de lignes.

**Aligner les états terminaux** mérite d'être connu. Sans ce réglage, des parcours
de longueurs différentes placent leur étape finale dans des colonnes différentes,
si bien que « Décès » peut apparaître trois ou quatre fois dans le diagramme.
Activez-le et la dernière étape de chaque flux est fusionnée dans une unique
colonne finale, donnant un seul nœud « Décès » et un seul nœud « Sortie » — bien
plus lisible dès que le devenir est le sujet.

### Rester lisible

> [!WARNING]
> **Trop de nœuds et le diagramme ne veut plus rien dire.** Avec 30 unités, 12
> devenirs et aucun seuil, vous obtenez une pelote où aucun ruban n'est assez épais
> pour être suivi — et les parcours rares, visuellement les plus enchevêtrés, sont
> les moins informatifs. Regroupez en amont les petites catégories dans un
> « Autres » raisonnable et augmentez **Flux minimum** jusqu'à ce que l'image soit
> lisible. Un Sankey est un outil de communication : si un collègue ne peut pas
> suivre un parcours du regard, il a échoué, si complet soit-il.

**Flux minimum** masque les transitions survenant moins souvent que le seuil.
Passer de 1 à 5 ou 10 transforme généralement un diagramme illisible en diagramme
clair. Attention : cela modifie les totaux, car chaque pourcentage affiché par le
widget est rapporté à la somme des flux *affichés*. Un diagramme filtré ne rend
donc plus compte de toute la cohorte — dites-le quand vous le présentez.

L'autre règle porte sur l'interprétation. **Un Sankey montre des flux observés,
pas des causes.** Un ruban épais de la réanimation vers le service ne signifie pas
que le séjour en réanimation a causé le séjour en service, et comparer la largeur
de deux rubans revient à comparer deux groupes de patients qui n'étaient pas
comparables au départ. C'est une description de ce qui s'est passé, et une bonne ;
ce n'est pas un effet.

Utilisez **Affichage** → *Diagramme + tableau* quand les chiffres exacts comptent.
Le tableau liste De, Vers, Effectif et un pourcentage du total affiché ; il est
triable et filtrable, et cliquer un ruban du diagramme amène à sa ligne.

## Un exemple travaillé

*D'où viennent nos patients de réanimation, et où vont-ils ?*

Une ligne par passage dans une unité, avec un identifiant de venue, un nom
d'unité, une date d'entrée et un devenir consigné sur la dernière ligne de chaque
venue.

1. **Forme des données** → Long.
2. **Unique par** → l'identifiant de venue. Utiliser ici un identifiant de patient
   raboutrait deux hospitalisations distinctes en un parcours impossible.
3. **Étape** → le nom de l'unité, **Ordonner par** → la date d'entrée.
4. Laissez **Fusionner les répétitions** actif : un changement de lit au sein de la
   même unité n'est pas une étape du parcours.
5. **Aligner les états terminaux** actif, pour que « Décès », « Domicile » et
   « Transfert » apparaissent chacun une fois à droite plutôt qu'éparpillés sur
   plusieurs colonnes.
6. **Flux minimum** → commencez à 1, constatez le désordre, puis montez à environ
   1 % de votre cohorte.

Lisez-le pour les bifurcations, pas pour les totaux. Si une part visible des
sorties de réanimation y revient deux colonnes plus loin, vous tenez un signal de
réadmission qui mérite d'être quantifié correctement. Si le ruban vers « Décès »
est épais depuis une unité amont particulière, c'est une question à poser aux
données — pas une conclusion à tirer de l'image.

## Pour aller plus loin

- [Schmidt M, *The Sankey Diagram in Energy and Material Flow Management*](https://onlinelibrary.wiley.com/doi/10.1111/j.1530-9290.2008.00004.x) — l'origine de cette représentation et ce qu'elle a été conçue pour transmettre.
- [Schulz KF et al., *CONSORT 2010 Statement*](https://www.bmj.com/content/340/bmj.c332) — le diagramme de flux d'inclusion, convention que le Sankey généralise.
- [Riehmann P et al., *Interactive Sankey diagrams*](https://ieeexplore.ieee.org/document/1532152) — les limites de lisibilité de cette forme.
- [Krzywinski M & Altman N, *Visualizing samples with box plots*](https://www.nature.com/articles/nmeth.2813) — un rappel qu'une image de synthèse n'est pas les données.
