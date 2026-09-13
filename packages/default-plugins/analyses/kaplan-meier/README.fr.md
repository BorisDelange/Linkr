## Introduction

L'analyse de survie répond à « combien de temps avant que cela n'arrive ? » tout
en traitant correctement les patients chez qui cela n'est **pas encore** arrivé.

Ce dernier point est l'essentiel. Si vous calculiez simplement un « % de décès »,
il faudrait écarter tous ceux encore vivants à la fin du suivi — ou les compter
comme survivants, quelle que soit la durée de leur suivi. Les deux réponses sont
fausses. L'analyse de survie les conserve : ils apportent de l'information aussi
longtemps qu'ils ont été observés.

![Courbes de Kaplan-Meier pour deux protocoles sur 90 jours, avec bandes de
confiance, marques de censure et table des effectifs à risque sous
l'axe.](attachments/output.fr.png)

Ci-dessus : deux protocoles, 210 séjours chacun. Les courbes se séparent à
partir du 30ᵉ jour environ et ne se rejoignent plus. Lisez la ligne des
effectifs à risque avant de croire la queue de courbe : au 80ᵉ jour il ne reste
que 76 et 55 patients, donc l'extrémité droite repose sur bien moins de monde
que la gauche.

## Réglages

Trois colonnes, dont deux obligatoires :

- **Variable de temps** — la durée de suivi par patient, dans l'unité de votre
  choix (jours, mois). Pas une date : une durée, à partir de la même origine
  pour tout le monde.
- **Variable d'événement** — `1` si l'événement est survenu, `0` si censuré. Ce
  codage est déterminant : une colonne inversée trace silencieusement l'image
  miroir de la réalité.
- **Variable de groupe** *(facultative)* — une courbe par modalité, plus un test
  du log-rank qui les compare.

L'origine doit être le même moment clinique pour tous : admission, diagnostic,
randomisation. Mélanger les origines est la façon la plus courante de rendre une
courbe de survie ininterprétable.

## Notes sur la méthode

### La censure, en un paragraphe

Un patient est **censuré** quand son suivi s'arrête sans que l'événement soit
survenu : il était vivant à sa dernière consultation, il a déménagé, l'étude
s'est terminée. Il compte comme « pas d'événement *jusqu'ici* », puis cesse de
contribuer.

> [!WARNING]
> La censure doit être indépendante du devenir. Si des patients sortent d'étude
> *parce que* leur état se dégrade, la courbe est optimiste et aucun réglage n'y
> changera rien. C'est une hypothèse sur vos données, que le plugin ne peut pas
> vérifier.

### Lire la courbe

La ligne descend à chaque survenue de l'événement, et reste plate entre deux.
De petits traits marquent les patients censurés. La courbe n'est pas l'estimation
d'un pourcentage : c'est la probabilité d'être **encore** indemne d'événement à
chaque instant.

La **médiane de survie** est le point où la courbe croise 50 %. Si elle ne la
croise jamais, il n'y a pas de médiane — c'est un résultat légitime, pas un
échec, et il indique que plus de la moitié des patients étaient encore indemnes
à la fin du suivi.

Les **bandes de confiance** s'élargissent vers la droite, car il reste de moins
en moins de patients. La queue d'une courbe de Kaplan-Meier en est toujours la
partie la moins fiable, et c'est le **tableau des sujets à risque** qui permet au
lecteur de s'en rendre compte : activez-le dès que le graphique part dans un
article ou une présentation. Passer de 3 patients à 2 ressemble à une chute de
33 % et ne signifie presque rien.

### Le test du log-rank

Avec une variable de groupe, le plugin affiche une p-valeur de log-rank : la
probabilité d'observer une différence aussi grande entre les courbes si les
groupes avaient réellement la même survie.

Il compare les courbes **dans leur ensemble**, pas à un instant choisi — d'où
l'erreur de le lire comme « la différence à 1 an ». Il suppose aussi que les
courbes ne se croisent pas : quand elles se croisent, le test perd de sa
puissance et peut rendre une p-valeur non significative pour deux profils de
survie visiblement différents.

### Le modèle de Cox

Ajoutez des **prédicteurs Cox** pour ajuster un modèle à risques proportionnels —
la façon de vérifier si une différence persiste après ajustement sur d'autres
variables (âge, gravité, comorbidités).

Il rapporte un **rapport de risques instantanés** (HR) par prédicteur. HR = 1,5
signifie un taux d'événement supérieur de 50 % par unité de cette variable, à
tout instant. Un HR inférieur à 1 est protecteur. L'intervalle de confiance
compte davantage que l'estimation ponctuelle : un HR de 2,0 avec un IC de 0,8 à
5,1 ne prouve rien.

#### L'hypothèse des risques proportionnels

Cox suppose que le rapport de risques est **constant dans le temps**. Un
traitement efficace au début puis sans effet viole cette hypothèse, et son HR
moyen unique ne décrit alors aucune période en particulier.

Le plugin effectue le test de l'hypothèse et vous alerte quand elle est mise en
défaut. Prenez cet avertissement au sérieux : un modèle dont l'hypothèse est
violée n'est pas un modèle un peu moins bon, c'est un modèle dont le chiffre
principal n'a pas de sens clair. Présenter les seules courbes de Kaplan-Meier
est alors une réponse tout à fait défendable.

## Un exemple travaillé

*Le nouveau protocole réduit-il la mortalité à 90 jours ?*

Une ligne par séjour, avec une durée de suivi, un indicateur de décès et le
protocole utilisé.

1. **Variable de temps** → jours entre l'admission et le décès ou le dernier
   contact.
2. **Variable d'événement** → l'indicateur de décès, `1` pour décédé.
3. **Variable de groupe** → le protocole.
4. Activez le **tableau des sujets à risque** — les relecteurs le demandent, et
   il montre à quel point la queue de courbe est fragile.
5. Ajoutez l'âge et un score de gravité comme **prédicteurs Cox** : si les
   groupes n'ont pas été randomisés, les courbes brutes comparent des
   populations, pas des protocoles.

Si le test de l'hypothèse proteste, regardez les courbes : des lignes qui se
croisent signifient que l'effet du protocole change avec le temps — ce qui est
en soi un résultat.

## Pour aller plus loin

- [Clark TG et al., *Survival analysis part I: basic concepts*](https://www.nature.com/articles/6601118) — l'introduction de référence.
- [Bland JM & Altman DG, *The logrank test*](https://www.bmj.com/content/328/7447/1073) — une page, sans algèbre.
- [Ranganathan P & Pramesh CS, *Censoring in survival analysis: potential for bias*](https://pmc.ncbi.nlm.nih.gov/articles/PMC3275994/) — ce qui déraille en pratique.
