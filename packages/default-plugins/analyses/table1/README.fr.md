# Tableau descriptif

Le tableau des caractéristiques de la population — celui qui ouvre tout article
clinique, avant la moindre analyse. Une ligne par variable, une colonne par
groupe, chaque groupe portant son propre effectif dans son en-tête.

Ce n'est pas une formalité préliminaire. C'est ce qui permet au lecteur de
décider si vos résultats s'appliquent à ses patients, et si les groupes que vous
comparez étaient comparables au départ. Un lecteur qui ne voit pas votre
population ne peut pas utiliser votre conclusion.

## Ce qu'il vous faut

Une ligne par sujet. Pas une ligne par mesure, ni une ligne par séjour si
l'unité d'analyse est le patient — le tableau décrit les lignes qu'on lui donne,
donc un patient avec douze séjours compterait douze fois.

- **Variables** — les lignes du tableau. Les identifiants et les horodatages
  bruts sont décochés par défaut : une colonne d'identifiants a une moyenne
  dénuée de sens et une modalité par patient.
- **Grouper par** *(facultatif)* — une colonne par modalité de cette variable.
  Elle n'est jamais décrite comme une ligne d'elle-même.

## Comment chaque variable est mise en forme

La présentation reprend celle des revues :

| Type de variable | Rendu |
| --- | --- |
| Qualitative | une ligne d'en-tête nommant la variable, puis **une ligne indentée par modalité**, chacune avec `n (%)` |
| Quantitative | une seule ligne avec le résumé choisi — `médiane [IQR]` par défaut |

Les modalités sont classées par fréquence globale, la plus fréquente en tête.
**Modalités au maximum** limite le nombre affiché ; les autres sont regroupées
dans une ligne « Autres » plutôt que supprimées, pour que les effectifs
continuent de se sommer. Laissez 0 pour toutes les afficher.

## Médiane [IQR] ou moyenne ± ET

Le **Résumé numérique** est le réglage qui décide si votre tableau dit la vérité
sur une variable.

La moyenne et l'écart-type ne décrivent bien une distribution que si elle est à
peu près symétrique. Sur une distribution asymétrique, ils ne décrivent rien qui
existe : pour la durée de séjour en réanimation, la moyenne se situe au-dessus
de la plupart des patients, tirée vers le haut par quelques séjours très longs,
et « 8,4 ± 11,2 jours » impliquerait des durées négatives à deux écarts-types.
La médiane et l'écart interquartile n'ont pas ce défaut : la médiane est le
patient du milieu, l'IQR l'intervalle où se situe la moitié centrale des
patients, et ni l'une ni l'autre ne bouge parce qu'un patient est resté un an.

En données hospitalières, présumez l'asymétrie tant que vous n'avez pas vérifié :

| Souvent asymétriques — médiane [IQR] | Souvent symétriques — moyenne ± ET convient |
| --- | --- |
| Durée de séjour, de ventilation, d'amines | Âge, taille, poids |
| Lactate, CRP, ferritine, bilirubine, D-dimères | Hémoglobine, natrémie, pression artérielle |
| Délai avant traitement, coûts, numérations | Scores de gravité, sur de grands effectifs |

C'est pourquoi Médiane [IQR] est le réglage par défaut. **Min / Max** et
**Étendue** répondent au cas plus étroit où l'on documente l'amplitude d'une
variable — un contrôle de plausibilité, une fenêtre d'éligibilité — pas la
description d'un patient typique.

Quel que soit votre choix, précisez-le dans la légende du tableau. `12 [7–19]`
et `12 ± 19` se ressemblent et ne veulent absolument pas dire la même chose.

## Les données manquantes

Les pourcentages sont calculés sur les sujets **renseignés**, et non sur
l'effectif total du groupe, et la **Ligne manquants** rapporte le reste sur une
ligne à part.

C'est délibéré, et c'est l'option honnête. L'alternative — des pourcentages sur
l'effectif total — ferait afficher, pour une variable manquante à 30 %, des
modalités dont la somme fait 70 %, ce qui se lit comme une erreur de calcul.
Masquer purement et simplement le nombre de manquants est pire encore : des
pourcentages calculés sur des dénominateurs différents, présentés dans la même
colonne comme s'ils étaient comparables, est l'une des façons discrètes dont un
tableau descriptif induit en erreur.

Ne désactivez la ligne des manquants que si vous avez déjà indiqué la complétude
ailleurs. Une variable manquante chez un tiers de la cohorte est un résultat sur
votre recueil de données, et le lecteur est en droit de le voir.

Un comportement lié : si la variable de regroupement est elle-même manquante
pour certaines lignes, celles-ci forment leur propre groupe au lieu d'être
écartées — les écarter modifierait silencieusement le dénominateur de toutes les
autres colonnes.

## La lecture, et la question des p-values

> [!WARNING]
> **N'ajoutez pas de p-values au tableau de caractéristiques initiales d'un
> essai randomisé.** CONSORT est explicite : dans un essai randomisé, tout
> déséquilibre initial est par construction dû au hasard, donc tester « était-ce
> le hasard ? » répond à une question que personne ne pose. Une p-value
> significative y signale un défaut de randomisation, pas une différence à
> rapporter ; une p-value non significative n'établit pas la comparabilité.
> Donnez les chiffres et laissez le lecteur juger si un déséquilibre compte
> cliniquement. Dans une étude observationnelle, comparer les groupes est
> légitime — mais cela reste un test par ligne, donc un tableau de trente
> variables produit des différences significatives par le seul hasard, et ce qui
> compte reste les déséquilibres cliniquement pertinents, significatifs ou non.

Lisez le tableau de haut en bas sur l'ampleur des différences, pas sur des
marqueurs. Un écart de cinq ans entre survivants et décédés compte dans une
cohorte de réanimation, qu'il franchisse ou non un seuil ; une différence de
0,2 kg ne compte pas, aussi petite que soit sa p-value sur un grand effectif.

## Présentation

La **Colonne Total** ajoute une colonne cumulant tous les groupes. Elle ne somme
que des effectifs : une médiane ne se cumule pas à partir des médianes de
groupe, donc les lignes quantitatives y affichent un tiret plutôt qu'un nombre
faux.

Le **Retour à la ligne** est désactivé par défaut, et il vaut mieux le laisser
ainsi. Des hauteurs de lignes irrégulières cassent la lecture verticale d'une
colonne de chiffres, qui est tout l'intérêt de cette mise en forme ; les
libellés longs sont tronqués, avec la valeur complète au survol.

Côté décimales, le plugin arrondit à une décimale et supprime un `,0` final, ce
qui est la bonne résolution pour presque tout ce qui est clinique. N'essayez pas
de regagner de la précision : un âge de `64,3` ans est déjà plus fin que la
question ne le mérite, `64,317` est du bruit, et une colonne de nombres longs est
nettement plus difficile à comparer de haut en bas. Une précision supérieure à
l'exactitude de la mesure elle-même suggère une certitude que vous n'avez pas.

## Un exemple

*Qu'est-ce qui distinguait les patients décédés des survivants ?*

Une ligne par séjour de réanimation, avec la démographie, un score de gravité,
la biologie d'admission, la durée de séjour et le statut vital.

1. **Variables** → âge, sexe, comorbidités, score de gravité, lactate, durée de
   séjour. Décochez l'identifiant de séjour et l'horodatage d'admission.
2. **Grouper par** → le statut vital. Les colonnes deviennent
   `Survivants (n=812)` et `Décédés (n=193)`, chaque pourcentage en dessous
   portant sur ce groupe.
3. **Résumé numérique** → Médiane [IQR]. La durée de séjour et le lactate sont
   tous deux asymétriques à droite ; une moyenne ne décrirait ni l'un ni l'autre
   groupe.
4. **Ordre des variables** → Personnalisé, glissé dans l'ordre de lecture :
   démographie, puis comorbidités, puis gravité, puis critères de jugement.
5. **Ligne manquants** → activée. Si le lactate manque chez 22 % des survivants
   et 6 % des décédés, c'est un résultat en soi — il a été dosé chez les plus
   graves.

Deux points de vigilance à la lecture. D'abord, ce défaut de recueil
différentiel fait que les deux médianes de lactate décrivent deux
sous-populations sélectionnées différemment, et non deux groupes comparables.
Ensuite, les patients décédés ont des séjours plus courts aussi souvent que plus
longs, puisque le décès met fin au séjour — dans une comparaison de mortalité,
la durée de séjour est davantage un artefact de survie qu'un critère de
jugement.

## Pour aller plus loin

- [CONSORT 2010 Statement](https://www.consort-statement.org/) — l'item 15 et son commentaire sur les données initiales, dont la raison pour laquelle les tests de significativité n'y ont pas leur place.
- [Moher D et al., *CONSORT 2010 explanation and elaboration*](https://www.bmj.com/content/340/bmj.c869) — le raisonnement complet sur le tableau de caractéristiques initiales.
- [Altman DG & Bland JM, *Detecting skewness from summary information*](https://www.bmj.com/content/313/7066/1200) — un contrôle en deux minutes pour vérifier qu'une moyenne ± ET ne décrit pas une variable asymétrique.
- [Bland JM & Altman DG, *Statistics Notes: Quartiles, quantiles and quintiles*](https://www.bmj.com/content/309/6960/996) — ce qu'est, et n'est pas, un écart interquartile.
- [Vandenbroucke JP et al., *STROBE explanation and elaboration*](https://pmc.ncbi.nlm.nih.gov/articles/PMC2020496/) — l'équivalent pour les études observationnelles : quelles données descriptives rapporter, et comment rendre compte des manquants.
