# Indicateur clé

Un chiffre, en grand, avec une icône, un sous-titre et un mini-graphique
optionnel. Taux de mortalité, durée moyenne de séjour, nombre de séjours,
proportion de patients ventilés — les chiffres par lesquels s'ouvre un tableau
de bord et qui seront cités en réunion une heure plus tard.

Le plugin est simple. Faire en sorte que le chiffre *veuille dire* quelque chose
ne l'est pas, et c'est l'objet de cette page. Un indicateur clé est la forme la
plus comprimée qu'un résultat puisse prendre : il jette la distribution, le
dénominateur, la période et l'incertitude, et laisse un chiffre unique qui se
lit comme un fait. Tout ce que fait une analyse rigoureuse — dire ce qui a été
compté, sur qui, et quand — doit être remis à la main, dans le titre et le
sous-titre, parce que le chiffre lui-même ne peut pas le porter.

Bien employé, c'est le moyen le plus rapide de donner à un service ses propres
chiffres. Mal employé, c'est le moyen le plus rapide d'en publier un faux.

## Ce qu'il vous faut

Un jeu de données tabulaire et une **Colonne**. Le choix de la colonne fixe des
valeurs par défaut sensées : une colonne numérique démarre sur *Moyenne*, une
colonne catégorielle sur *Proportion (%)*.

- **Statistique** est la statistique affichée : *Moyenne*, *Médiane*, *Min*,
  *Max*, *Somme*, *Effectif*, *Écart-type*, *Q1*, *Q3*, *IQR*, *Proportion (%)*,
  ou *Aucune* pour afficher la valeur de la colonne sans agrégation. Seules les
  options cohérentes avec le type de la colonne sont proposées.
- **Valeur cible** désigne la valeur à compter, pour *Effectif* et *Proportion
  (%)*. Laissée vide, *Effectif* compte toutes les lignes non vides et
  *Proportion* détecte automatiquement la valeur la plus fréquente — commode
  pendant l'exploration, et à fixer explicitement avant que quelqu'un d'autre ne
  lise le widget.
- **Exclure NA / vide** ignore les valeurs nulles, vides ou NA avant le calcul.
  Activé par défaut : une moyenne sur des lignes qui n'existent pas n'est pas
  une moyenne. Le désactiver fait compter les lignes manquantes comme des
  observations, ce qui n'est presque jamais souhaitable et l'est parfois
  exactement (mesurer la complétude).
- **Unité**, **Décimales** et **Titre** relèvent de la présentation. **Stats
  sous-titre** ajoute du contexte sous le chiffre — *n* par défaut, plus au
  choix moyenne, médiane, écart-type, min, max, Q1, Q3, IQR.

La section **Mini-graphique** ajoute un histogramme, une boîte à moustaches, des
barres ou un camembert à côté ou sous la valeur, et la section **Style** gère
l'icône, les couleurs, la taille et le centrage.

## « Unique par » est ce qui décide du sens

**Unique par** regroupe les lignes selon une colonne et réduit chaque groupe à
une valeur avant le calcul de la statistique. **Fonction par entité** dit
comment : *Première valeur*, *Dernière valeur*, *Moyenne*, *Médiane*, *Min*,
*Max*, *Somme*.

Ce n'est pas un détail technique : c'est le réglage qui détermine de quoi votre
chiffre est le chiffre. Prenons un jeu de données avec une ligne par journée de
réanimation et une colonne `deces` répétée sur chaque ligne d'un séjour :

| Configuration | Ce qu'est le chiffre | Valeur typique |
| --- | --- | --- |
| Sans **Unique par** | proportion de *journées* de réanimation appartenant à un séjour terminé par un décès | surestimée : les séjours longs pèsent par leurs nombreuses lignes |
| **Unique par** = id de séjour, **Fonction par entité** = *Première valeur* | proportion de *séjours* se terminant par un décès | le taux de mortalité au sens usuel |
| **Unique par** = id de patient, *Max* | proportion de *patients* décédés à un moment quelconque | N plus faible, dénominateur encore différent |

Les trois sont calculables, les trois s'afficheront sans broncher, et ils
peuvent différer d'un facteur deux. Le premier n'est pas du tout un taux de
mortalité, mais rien sur le widget ne le signale.

Le même raisonnement vaut pour toute mesure répétée. Une moyenne de lactate sur
40 000 lignes est une moyenne par *mesure*, qui pondère quarante fois les
patients les plus graves — ceux qui sont le plus prélevés. Réglez **Unique par**
sur l'identifiant de séjour et **Fonction par entité** sur *Max* et vous obtenez
le pire lactate par séjour ; réglez-la sur *Moyenne* et vous obtenez une
exposition moyenne. Ce sont deux variables cliniques différentes, de
distributions différentes, et choisir entre elles est une décision clinique qui
a sa place dans vos méthodes.

*Première valeur* et *Dernière valeur* conservent une ligne d'origine entière,
dans l'ordre d'arrivée des lignes dans le jeu de données — le plugin ne trie
pas. Si vous voulez dire « la dernière valeur mesurée », triez votre jeu de
données par date en amont.

## Un chiffre sans dénominateur

> [!WARNING]
> **Un pourcentage nu est la façon la plus simple de tromper avec des données
> réelles.** « Mortalité 33 % » est compatible avec 1 décès sur 3 et avec 3300
> sur 10 000, et un seul de ces cas justifie qu'on agisse. Un indicateur sur un
> tableau de bord se lit d'un coup d'œil, se capture en image et se cite dans
> une réunion où personne ne peut cliquer dessus : si le dénominateur n'est pas
> sur la tuile, il n'existe pas. Gardez **Stats sous-titre** affichant *n*, et
> mettez la population et la période dans le **Titre** : « Mortalité
> hospitalière, séjours de réanimation 2024 (n = 812) » survit à la citation ;
> « 33 % » non. Méfiez-vous en particulier de la tuile qui reste sur un tableau
> de bord pendant que ses filtres changent sous elle : un pourcentage portant ce
> matin sur 800 séjours peut porter cet après-midi sur 11 et avoir exactement la
> même allure.

Les petits dénominateurs n'élargissent pas seulement l'incertitude : ils
changent ce que signifie une variation. Sur 20 séjours, un décès de plus déplace
le taux de cinq points, et une tuile qui « s'améliore » de 20 % à 15 % peut ne
représenter qu'un patient. Si un indicateur est surveillé dans le temps pour
détecter un changement, un chiffre unique est le mauvais outil — c'est le rôle
d'une carte de contrôle, qui existe dans Linkr sous forme de plugin dédié
précisément parce que distinguer le signal du bruit demande la série, pas la
dernière valeur.

## Le sous-titre et le mini-graphique sont là où loge l'honnêteté

**Stats sous-titre** existe pour empêcher un chiffre unique de rester seul. Deux
combinaisons méritent leur place sur presque toutes les tuiles :

- **n** partout, toujours. C'est le réglage par défaut, et le désactiver devrait
  être un acte délibéré.
- **Médiane** et **IQR** (ou **Q1** et **Q3**) à côté d'une moyenne, dès que la
  variable est asymétrique. Une durée moyenne de séjour de 8,4 jours avec une
  médiane de 5 jours en dessous indique immédiatement au lecteur que quelques
  séjours très longs tirent le chiffre affiché — et sur des données
  hospitalières, présumez l'asymétrie tant que vous n'avez pas vérifié. Durée de
  séjour, durée de ventilation, lactate, CRP, délai de traitement et coûts sont
  tous asymétriques à droite, presque par construction.

Le mini-graphique fait le même travail, graphiquement. **Type de graphique** →
*Histogramme* sous une moyenne montre d'un coup d'œil si cette moyenne décrit
quelque chose de réel ; une forme bimodale signifie qu'elle ne décrit personne.
La *Boîte à moustaches* est la version compacte du même contrôle. Pour une
colonne catégorielle, les *Barres* montrent quelles étaient les autres
catégories, ce qu'une proportion isolée masque entièrement.

Réglez **Position** sur *À côté* quand la tuile est large et sur *En dessous*
quand elle est haute, et utilisez **Barres** sur un histogramme comme partout
ailleurs : essayez deux ou trois valeurs, et méfiez-vous d'une structure qui
n'apparaît qu'avec l'une d'elles.

## Un exemple complet

*Quelle a été notre mortalité en réanimation l'an dernier ?*

Une ligne par journée de réanimation, avec un identifiant de séjour, un
identifiant de patient, un statut vital répété sur chaque ligne du séjour, et
une date.

1. **En amont**, filtrez le jeu de données sur la période — 2024 — pour que la
   tuile ne dérive pas à mesure que les données s'accumulent.
2. **Colonne** → la colonne de statut vital. **Statistique** → *Proportion (%)*,
   **Valeur cible** → la valeur signifiant le décès, fixée explicitement plutôt
   que détectée automatiquement.
3. **Unique par** → l'identifiant de séjour, **Fonction par entité** →
   *Première valeur*. Sans cela, vous calculez la proportion de *journées* de
   réanimation imputables à des séjours terminés par un décès, un chiffre plus
   élevé et dépourvu de sens.
4. **Exclure NA / vide** → activé, pour que les séjours au devenir inconnu ne
   comptent pas silencieusement comme des survivants. Notez combien sont exclus :
   s'il y en a plus qu'une poignée, cette absence est en soi un résultat.
5. **Stats sous-titre** → *n*. **Titre** → « Mortalité hospitalière, séjours de
   réanimation 2024 ». **Unité** → `%`, **Décimales** → 1.
6. **Type de graphique** → *Barres*, pour montrer survivants et décès plutôt
   qu'un pourcentage flottant seul.

Lisez la tuile ainsi : « sur les 812 séjours terminés en 2024 dont le devenir
est connu, 21,4 % se sont soldés par un décès ». Cette phrase est défendable.

Ce qui la rendrait trompeuse : la comparer au chiffre d'un autre service, ou à
celui de l'an dernier. Un taux de mortalité brut est dominé par le recrutement —
un service accueillant des patients plus graves affiche un taux plus élevé et
soigne peut-être mieux — donc une comparaison exige un ajustement sur le risque,
pas une deuxième tuile. Et si un filtre du tableau de bord permet à un lecteur
de se restreindre à une catégorie d'admission, la même tuile peut se retrouver
sur 14 séjours, où un patient de plus la déplace de sept points. Soit vous fixez
la population dans le jeu de données, soit vous rendez le *n* assez visible pour
que personne ne lise le pourcentage sans lui.

## Pour aller plus loin

- [Donabedian A, *Evaluating the quality of medical care*](https://pmc.ncbi.nlm.nih.gov/articles/PMC2690293/) — le cadre structure / processus / résultat, et pourquoi les indicateurs de résultat sont les plus difficiles à interpréter isolément.
- [L'article classique de Donabedian, cinquante ans après](https://pmc.ncbi.nlm.nih.gov/articles/PMC4911723/) — ce qu'un demi-siècle de mesure de la qualité a confirmé, et ce qu'il n'a pas confirmé.
- [Agniel D, Kohane IS & Weber GM, *Biases in electronic health record data due to processes within the healthcare system*](https://pmc.ncbi.nlm.nih.gov/articles/PMC5925441/) — pourquoi un indicateur calculé sur des données de routine mesure en partie le processus de recueil.
- [OMS, *Indicator metadata registry*](https://www.who.int/data/gho/indicator-metadata-registry) — comment se spécifie un indicateur de santé : numérateur, dénominateur, période, exclusions. Le modèle de ce que devrait porter un titre d'indicateur.
- [*The Book of OHDSI*, caractérisation](https://ohdsi.github.io/TheBookOfOhdsi/Characterization.html) — définir une cohorte et son dénominateur de façon reproductible, l'étape qui précède tout indicateur.
