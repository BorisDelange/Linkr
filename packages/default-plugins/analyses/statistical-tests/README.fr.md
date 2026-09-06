# Tests statistiques

Comparer des groupes sur plusieurs variables à la fois, avec le test adapté
choisi variable par variable — et avec les chiffres qui disent si la différence
compte, pas seulement si elle est « significative ».

Le test n'est presque jamais la partie difficile ; le choisir, si. Un test t sur
une durée de séjour asymétrique, un chi² sur un tableau 2×2 où une case contient
quatre patients, une p-value lue comme la probabilité que les groupes soient
identiques : chacune de ces erreurs produit un nombre d'allure irréprochable et
pourtant faux.

![Tableau de tests statistiques automatiques comparant survivants et décédés
sur cinq variables, chaque ligne nommant le test
utilisé.](attachments/output.fr.png)

Ci-dessus : cinq variables confrontées à la mortalité en réanimation, chacune
avec le test retenu par le plugin et sa justification. Lisez les tailles
d'effet, pas les étoiles : l'IGS II diffère d'environ 17 points et l'âge de
neuf ans, mais les deux ressortent « significatifs » sur 1005 séjours — et rien
de tout cela n'est causal.

## Ce qu'il faut

Deux réglages font l'essentiel du travail :

- **Colonne de groupe** — la variable dont les groupes sont comparés. Elle doit
  être qualitative : survivant / décédé, service A / service B / service C. Deux
  groupes donnent un test t ou un Mann-Whitney ; trois ou plus, une ANOVA ou un
  Kruskal-Wallis.
- **Variables testées** — une ligne du tableau par variable. Variables
  quantitatives et qualitatives se mélangent sans problème : chacune est traitée
  selon son type. Les colonnes de dates sont ignorées.

Une ligne par patient (ou par séjour — mais restez cohérent). Les lignes dont la
valeur de groupe est manquante sont écartées ; les valeurs manquantes d'une
variable testée ne le sont que pour cette variable, ce qui explique que le `n`
affiché par groupe puisse varier d'une ligne à l'autre.

## Quel test, et pourquoi

Le test est choisi variable par variable, d'après son type et le nombre de
groupes :

| Variable | Groupes | Paramétrique | Sur les rangs / exact |
| --- | --- | --- | --- |
| Quantitative (âge, IGS II, lactate) | 2 | Test t de Welch | Mann-Whitney U |
| Quantitative | 3 ou plus | ANOVA à un facteur | Kruskal-Wallis |
| Qualitative (sexe, comorbidité) | tous | Chi-deux | Test exact de Fisher |

Pour une variable qualitative, le choix ne vous appartient pas : sur un tableau
2×2, dès qu'un effectif **attendu** descend sous 5, l'approximation du chi²
cesse d'être fiable et le plugin bascule sur le **test exact de Fisher**. Notez
bien *attendu*, et non observé — une case contenant 7 patients peut très bien
avoir un effectif attendu de 2.

Pour une variable quantitative, c'est le **Choix du test** qui tranche :

- **Auto (guidé par les données)** — la normalité de chaque groupe est vérifiée
  (Shapiro-Wilk). Si un seul groupe s'en écarte, toute la comparaison passe au
  test sur les rangs. Pencher du côté non paramétrique est délibéré : cela coûte
  un peu de puissance quand les données étaient bel et bien normales, là où un
  test t sur une variable asymétrique peut annoncer une différence qui n'existe
  pas.
- **Forcer paramétrique** / **Forcer non-paramétrique** — appliqué à toutes les
  variables, sans vérification. À utiliser quand un protocole ou un plan
  d'analyse statistique a fixé la méthode à l'avance : un outil n'a pas à
  contredire cela en silence.

Un test paramétrique suppose des données à peu près normales dans chaque groupe
et, pour l'ANOVA, des variances comparables. Le test t de Welch, lui, ne suppose
pas l'égalité des variances : c'est pour cela qu'il sert de défaut plutôt que le
test t de Student. Sur de petits effectifs (disons moins de 20 par groupe), la
normalité n'est de toute façon pas vérifiable, et le test sur les rangs est
l'option prudente. Le tableau indique quel test a été retenu et pourquoi :
survolez son nom, ou cliquez dessus pour en fixer un autre sur cette seule
variable.

## Lire les résultats

Chaque ligne porte, selon les **Colonnes du tableau** :

- **Stats par groupe** — `n` et moyenne ± écart-type par groupe pour les
  variables quantitatives, effectifs et pourcentages par catégorie pour les
  qualitatives. À lire en premier : c'est le résultat proprement dit, la
  p-value ne fait que le nuancer.
- **Statistique** et **degrés de liberté** — `t`, `U`, `χ²`, `F`, `H`.
  Nécessaires pour rapporter le test, rarement pour l'interpréter.
- **p-value**, accompagnée de `*` (< 0,05), `**` (< 0,01), `***` (< 0,001), et
  d'un triangle orange quand le résultat est fragile (effectif attendu trop
  faible, groupe trop peu fourni). L'avertissement s'affiche plutôt que le
  résultat ne soit masqué : un chiffre douteux mais visible vaut mieux qu'un
  chiffre escamoté.
- **IC 95 %** — l'intervalle de confiance sur la différence des moyennes, pour
  le test t de Welch. C'est le chiffre à citer.
- **Taille d'effet** — *d* de Cohen, *r* rang-bisérial, *V* de Cramér, η². Elle
  dit l'ampleur de la différence, sur une échelle qui ne gonfle pas avec
  l'effectif.

### Ce qu'une p-value ne dit pas

Elle donne la probabilité d'observer une différence au moins aussi grande **si
les groupes ne différaient pas réellement**. Elle ne donne ni la probabilité que
les groupes soient identiques, ni l'ampleur de la différence.

La conséquence est très concrète : sur 5000 patients, un p à 0,002 peut
correspondre à une demi-journée de durée de séjour dont personne ne changerait
sa pratique. Sur 40 patients, un p à 0,09 peut masquer une différence qui compte
beaucoup. C'est pourquoi la **Taille d'effet** et l'**IC 95 %** sont affichés par
défaut : un intervalle allant de −0,3 à +4,1 jours signifie « on ne sait pas »,
quel que soit le côté du seuil où la p-value est tombée.

Le **Seuil de significativité (α)** fixe la valeur à laquelle la p-value est
comparée. Il ne change que ce qui est étoilé, jamais les p-values elles-mêmes.
L'abaisser à 0,01 rend les faux positifs plus rares et les faux négatifs plus
fréquents : aucun réglage ne permet d'éviter les deux.

## Les pièges

> [!WARNING]
> **Tester 20 variables à α = 0,05, c'est s'offrir environ un faux positif par
> pur hasard.** Ce plugin teste toutes les variables cochées en un clic : le
> risque est donc immédiat, pas théorique. Décidez *avant de regarder* quelle
> comparaison répond à votre question ; tout le reste est exploratoire et doit
> être présenté comme tel. Si plusieurs comparaisons portent réellement la
> conclusion, corrigez la multiplicité (Bonferroni, Benjamini-Hochberg) en
> dehors du tableau — les p-values affichées ici ne sont pas corrigées.

**Un « tableau 1 avec p-values » comparant les bras d'un essai randomisé
n'apprend rien.** La randomisation garantit que toute différence initiale est
due au hasard : la p-value teste donc une hypothèse dont on sait déjà qu'elle
est vraie. Ce qui compte est de savoir si un déséquilibre est *assez marqué pour
confondre* — un jugement clinique porté sur la taille d'effet, pas un test.
Entre groupes non randomisés — survivants et décédés, deux services — la
comparaison pose une vraie question et ces p-values ont un sens.

**Trois groupes ne disent pas quelle paire diffère.** Une ANOVA ou un
Kruskal-Wallis significatif dit seulement « les groupes ne se ressemblent pas
tous ». Identifier la paire demande une comparaison post-hoc, qui est elle-même
un problème de comparaisons multiples.

**Un résultat non significatif n'est pas la preuve d'une absence de
différence.** Il signifie que les données sont compatibles avec l'absence de
différence — et, sur un petit échantillon, compatibles aussi avec une différence
importante. C'est l'intervalle de confiance qui départage les deux situations.

## Un exemple travaillé

*En quoi les patients de réanimation décédés diffèrent-ils des survivants à
l'admission ?*

Une ligne par séjour, une colonne `deces_rea` à deux modalités, plus l'âge,
l'IGS II, le lactate d'admission, le sexe et un indicateur de maladie chronique.

1. **Colonne de groupe** → `deces_rea`. Deux modalités, donc des tests deux à
   deux partout.
2. **Variables testées** → âge, IGS II, lactate, sexe, maladie chronique.
3. **Choix du test** → *Auto*. L'âge restera probablement sur le test t de
   Welch ; le lactate, asymétrique à droite, basculera sur Mann-Whitney. Le
   tableau indique lequel a été retenu, et pourquoi.
4. **Seuil de significativité (α)** → 0,05, à lire comme un repère et non comme
   un verdict.
5. **Ordre des variables** → *Personnalisé*, en faisant glisser les données
   démographiques au-dessus des scores de gravité, comme se présente
   habituellement un tableau 1.

Regardez ensuite les tailles d'effet. Un écart de 18 points d'IGS II avec un *d*
de Cohen proche de 1,0 est le résultat ; deux ans d'écart d'âge avec *d* = 0,12
est significatif sur 2000 séjours et cliniquement sans portée. Cinq variables
testées, cela veut dire que l'étoile la plus faible mérite la moindre confiance
— et rien de tout cela n'est causal : les patients décédés sont plus graves pour
des raisons que ce tableau ne sait pas démêler.

## Pour aller plus loin

- [Wasserstein RL & Lazar NA, *The ASA statement on p-values*](https://www.tandfonline.com/doi/full/10.1080/00031305.2016.1154108) — six principes, et ce qu'une p-value ne peut pas faire.
- [Amrhein V, Greenland S & McShane B, *Scientists rise up against statistical significance*](https://www.nature.com/articles/d41586-019-00857-9) — pourquoi la coupure à 0,05 induit en erreur.
- [Bland JM & Altman DG, *Multiple significance tests: the Bonferroni method*](https://www.bmj.com/content/310/6973/170) — une page sur les comparaisons multiples.
- [Altman DG & Bland JM, *Absence of evidence is not evidence of absence*](https://www.bmj.com/content/311/7003/485) — comment lire un résultat non significatif.
- [Assmann SF et al., *Subgroup analysis and other (mis)uses of baseline data*](https://pubmed.ncbi.nlm.nih.gov/10744093/) — pourquoi les p-values du tableau 1 d'un essai sont inutiles.
