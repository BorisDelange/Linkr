# Régression

La régression mesure l'association entre une variable à expliquer et plusieurs
variables **simultanément**, chacune étant lue les autres étant maintenues
constantes.

C'est précisément ce qu'un tableau de comparaisons variable par variable ne sait
pas faire. En réanimation, les patients décédés sont plus âgés *et* plus graves
*et* plus souvent ventilés : chacune de ces colonnes ressortira « significative »
prise isolément. La régression permet de demander laquelle reste associée au
décès une fois les deux autres prises en compte.

## Ce qu'il faut

Deux réglages de la section **Données** sont obligatoires.

- **Variable dépendante (Y)** — ce que le modèle explique. Une colonne, une ligne
  par patient ou par séjour.
- **Prédicteurs (X)** — les variables ajustées les unes sur les autres. Les
  colonnes numériques entrent telles quelles ; une colonne textuelle donne une
  ligne par modalité.

Les lignes comportant une valeur manquante sur la variable dépendante ou sur
*n'importe quel* prédicteur sont entièrement écartées, et le widget indique
combien. C'est une analyse en cas complets : ajouter un prédicteur rempli à 70 %
fait perdre 30 % des patients, avec tout ce qui les distinguait.

L'**ordre des prédicteurs** ne change que la lecture du tableau. Laissez l'ordre
du jeu de données en exploration ; passez à *Personnalisé (glisser pour
réordonner)* pour une figure, où l'exposition d'intérêt doit figurer en tête et
les variables d'ajustement en dessous.

## Linéaire ou logistique

Le réglage **Type de régression** découle de la nature de la variable
dépendante, pas d'une préférence.

| Variable dépendante | Type | Ce que le modèle rapporte |
| --- | --- | --- |
| Durée de séjour, IGS II, une lactatémie | Linéaire | Un coefficient : variation de Y par unité de X |
| Décédé / survivant, réadmis oui-non | Logistique | Un rapport de cotes (odds ratio) |

L'*auto-détection* lit la colonne : exactement deux valeurs distinctes donnent
une régression logistique, tout le reste une régression linéaire. Une colonne
non numérique est toujours traitée comme binaire — et si elle comporte en réalité
plus de deux modalités, le widget le signale au lieu de deviner.

Forcer **Linéaire** sur une variable 0/1 revient à ajuster un modèle linéaire de
probabilité, qui prédira sans état d'âme un risque de 1,3. Forcer **Logistique**
sur une variable continue échoue franchement.

## Lire un coefficient

**Linéaire.** Un coefficient de 0,42 pour le SOFA signifie : un point de SOFA
supplémentaire s'accompagne de 0,42 jour de séjour en plus, à âge égal et à
statut ventilatoire égal. Les unités sont celles de vos colonnes — passez l'âge
en décennies si l'effet par année est trop petit pour être lisible.

**Logistique.** Un rapport de cotes de 1,15 pour l'âge signifie que la *cote* de
l'événement est multipliée par 1,15 par année supplémentaire. OR = 1 signifie
absence d'association ; en dessous de 1, l'effet est protecteur.

Un rapport de cotes n'est **pas** un risque relatif. Quand l'événement est rare
(quelques pour cent), les deux sont assez proches pour qu'on les confonde sans
grand dommage. Quand il est fréquent — et une mortalité de réanimation à 25 % est
fréquente —, l'OR s'éloigne systématiquement de 1 plus que le risque relatif. Un
OR de 2,0 sur un risque de base de 25 % correspond à un passage à environ 40 %,
pas à 50 %. Dites « cotes », écrivez « rapport de cotes », et évitez la phrase
« deux fois plus de risque de décéder ».

### L'intervalle, pas la p-value

Chaque ligne porte un intervalle de confiance au niveau fixé par **Niveau de
confiance (%)** (95 % par défaut, ce qui fixe aussi le seuil de significativité α
utilisé pour le surlignage).

Lisez-le en premier. Il indique quelles tailles d'effet sont compatibles avec vos
données, ce que la p-value ne dit pas.

- Un intervalle contenant **1** (rapport de cotes) ou **0** (coefficient
  linéaire) ne constitue pas une preuve d'effet. Ce n'est *pas* pour autant une
  preuve d'absence d'effet : OR 1,8 [0,7 – 4,5] est une étude sous-dimensionnée,
  pas une étude négative.
- Un intervalle étroit autour de 1 — OR 1,02 [0,98 – 1,06] — argumente
  réellement contre un effet cliniquement utile. C'est un résultat différent, et
  seul l'intervalle permet de distinguer les deux situations.
- Un OR « significatif » de 1,04 sur une cohorte de 3 000 patients peut être
  réel et sans portée. La significativité dépend autant de l'effectif que de
  l'effet.

**Surligner les significatifs** marque les lignes dont p est inférieur à α.
C'est un repère de lecture, pas un verdict.

## Prédicteurs qualitatifs

Une colonne textuelle est décomposée en une ligne par modalité, moins une : la
première modalité par ordre alphabétique est omise et sert de **référence**.
Toutes les autres se lisent par rapport à elle — « Provenance : Urgences, OR
1,6 » signifie 1,6 fois la cote par rapport à la modalité omise, et non par
rapport à l'ensemble des autres patients.

Deux conséquences à anticiper :

- La référence est choisie par ordre alphabétique : renommez vos valeurs si vous
  voulez une base de comparaison précise (`0_medical`, `1_chirurgical`, ou une
  lettre en préfixe).
- Une colonne à modalité unique est écartée ; une colonne comptant plus de 20
  modalités l'est également. Les deux cas font l'objet d'un avertissement. Un
  champ diagnostic en texte libre doit être regroupé en quelques catégories avant
  de pouvoir entrer dans un modèle.

## L'ajustement, et ce qui le fait dérailler

« Ajusté sur l'âge » signifie que les coefficients décrivent des patients
comparés *au même âge*. C'est toute la force de la méthode, et c'est aussi là
qu'elle se retourne contre vous.

> [!WARNING]
> **N'ajustez jamais sur une variable située sur le chemin causal.** Si le sepsis
> augmente la mortalité *parce qu'il* provoque un choc, ajouter le recours aux
> amines comme prédicteur retire exactement l'effet que vous cherchiez à mesurer :
> le coefficient du sepsis s'effondre vers 1 et vous concluez à tort qu'il n'a pas
> d'importance. Le même dégât vient de l'ajustement sur une variable influencée à
> la fois par l'exposition et par l'événement (un collider), qui peut fabriquer
> une association là où il n'y en a aucune. Choisissez vos prédicteurs à partir
> de ce que vous pensez causer quoi, avant de lancer le modèle — jamais en
> versant toutes les colonnes disponibles pour conserver ce qui ressort
> significatif.

La **colinéarité** est l'autre écueil. Deux prédicteurs porteurs de la même
information — SOFA et IGS II, poids et IMC — ne peuvent pas être démêlés par le
modèle. Les coefficients deviennent instables : grands, à intervalles très
larges, parfois de signe inversé, alors que le modèle global s'ajuste
correctement. Si le retrait d'un prédicteur déplace fortement l'estimation d'un
autre, c'est de cela qu'il s'agit. Conservez-en un seul.

## Combien de patients

Pour la régression logistique, la règle de travail est de **10 événements par
prédicteur** — des événements, pas des lignes. Une cohorte de 500 séjours
comptant 60 décès supporte environ 6 paramètres, et chaque modalité d'une
variable qualitative compte pour un. En deçà, les coefficients sont biaisés et
les intervalles ne sont plus fiables.

Le widget s'arrête et avertit quand il y a moins de lignes complètes que de
paramètres, mais rien ne vous alerte à 3 événements par variable : c'est à vous
d'en juger. L'autre symptôme est un coefficient à l'estimation aberrante et à
l'intervalle couvrant plusieurs ordres de grandeur — le plus souvent une
modalité ne comptant aucun événement (séparation). Regroupez les modalités, ou
retirez la variable.

## Lire le forest plot

Le réglage **Affichage** permet de choisir *Tableau + graphique (empilés)*,
*Tableau + graphique (onglets)*, ou l'un des deux seul ; **Colonnes du tableau**
décide de ce qu'affiche le tableau (estimation, erreur standard, intervalle,
statistique, p-value).

Le graphique trace une ligne par coefficient — l'ordonnée à l'origine en est
exclue, n'ayant pas d'interprétation en termes d'effet. Le losange est
l'estimation ponctuelle, la barre horizontale son intervalle de confiance, et la
ligne verticale en pointillés la valeur nulle (1 pour les rapports de cotes, 0
pour les coefficients linéaires). Les lignes dont l'intervalle croise cette
verticale sont tracées en gris atténué.

Regardez d'abord les *largeurs* : une barre longue signale une variable sur
laquelle vos données ont peu à dire, quelle que soit sa p-value.

![Régression logistique du décès hospitalier sur l'âge, le score de Glasgow
minimal et le lactate maximal : le tableau des coefficients en haut, le forest
plot des rapports de cotes en bas.](attachments/output.fr.png)

Ci-dessus : le décès hospitalier expliqué par l'âge, le GCS le plus bas et le
lactate le plus haut, sur 111 séjours de réanimation. Tous les intervalles
croisent 1, et le bandeau dit pourquoi la réponse est si incertaine — 38 des
111 lignes ont été écartées pour une valeur manquante quelque part.

## Un exemple concret

*Quels facteurs sont associés au décès hospitalier ?*

Une ligne par séjour de réanimation, avec un indicateur de décès, l'âge, l'IGS II
et le recours à la ventilation mécanique.

1. **Variable dépendante (Y)** → l'indicateur de décès. Deux valeurs : sur
   *Auto-détection*, le **type de régression** est logistique et le modèle
   rapporte des rapports de cotes.
2. **Prédicteurs (X)** → âge, IGS II, ventilation. Pas la durée de séjour :
   mourir tôt la raccourcit, la flèche causale va dans le mauvais sens.
3. **Niveau de confiance (%)** → 95.
4. **Ordre des prédicteurs** → *Personnalisé*, avec la ventilation en tête si
   c'est l'exposition sur laquelle porte la question.
5. **Affichage** → *Tableau + graphique (empilés)*.

Vérifiez le nombre d'événements avant toute lecture : 3 paramètres demandent une
trentaine de décès. Lisez ensuite l'intervalle de la ventilation — s'il contient
1, votre cohorte ne peut pas répondre à cette taille, quoi qu'ait suggéré la
comparaison brute.

Si l'âge et l'IGS II ressortent tous deux avec des intervalles larges et que l'un
d'eux a un signe inattendu, suspectez une colinéarité : l'IGS II contient déjà
l'âge. Gardez le score, retirez la colonne d'âge, et regardez si les estimations
se stabilisent.

## Pour aller plus loin

- [Bland JM & Altman DG, *The odds ratio*](https://www.bmj.com/content/320/7247/1468) — une page, et la source de la plupart des confusions que cette note cherche à éviter.
- [Bland JM & Altman DG, *Regression towards the mean*](https://www.bmj.com/content/308/6942/1499) — le piège des comparaisons avant/après.
- [Peduzzi P et al., *A simulation study of the number of events per variable in logistic regression*](https://pubmed.ncbi.nlm.nih.gov/8970487/) — l'origine de la règle des 10 événements par variable.
- [Schisterman EF et al., *Overadjustment bias and unnecessary adjustment*](https://pmc.ncbi.nlm.nih.gov/articles/PMC2744485/) — médiateurs, colliders, et ce que l'ajustement sur eux détruit.
- [Sedgwick P, *Understanding confidence intervals*](https://www.bmj.com/content/349/bmj.g6051) — pourquoi l'intervalle en dit plus que la p-value.
