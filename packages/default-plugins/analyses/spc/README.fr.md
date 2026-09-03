# Carte de contrôle (SPC)

Une carte de contrôle sépare le bruit qu'un processus comporte toujours d'un
signal indiquant qu'il s'est réellement passé quelque chose — pour qu'une équipe
agisse sur les signaux et laisse le bruit tranquille.

Cela compte plus qu'il n'y paraît. Réagir à la variation ordinaire (« ce mois-ci
c'est +3 %, que s'est-il passé ? ») augmente la variation au lieu de la réduire.
Les comparaisons d'un mois sur l'autre dans un rapport de gestion ne sont pas une
version dégradée d'une carte de contrôle : elles sont pires que ne rien faire.

## Ce que montre la carte

Votre indicateur est tracé dans le temps, avec :

- une **ligne centrale** — la moyenne du processus sur la période de référence,
- des **limites de contrôle** de part et d'autre, à ±3 écarts-types par défaut,
- des **points signalés**, dessinés au-dessus, là où les données signalent un
  changement réel.

Les limites ne sont pas « le plus haut et le plus bas qu'on ait vus ». Elles sont
calculées à partir d'un modèle statistique de votre indicateur — d'où la première
question posée par le plugin : de quelle nature est ce nombre.

### Pourquoi les limites montent et descendent

Un mois à 40 admissions est plus bruité qu'un mois à 400 : ses limites sont donc
plus larges. Les limites suivent le dénominateur de chaque période et sont
tracées **en escalier**, pas en deux droites horizontales.

Des limites plates sur un dénominateur variable, c'est l'erreur la plus fréquente
des cartes faites à la main à l'hôpital : les mois creux paraissent hors
contrôle, les mois chargés masquent les vrais signaux.

## Choisir la carte

**La nature de l'indicateur** est le premier réglage, parce qu'il détermine le
modèle de variance — et donc les limites elles-mêmes. Laissé sur *Auto*, le
plugin l'infère de vos données et vous dit ce qu'il a inféré.

| Votre indicateur | Réglage | Carte |
| --- | --- | --- |
| Décès / admissions, % de conformité | Proportion | `p` (ou `P′` sur grands dénominateurs) |
| PAVM pour 1000 jours de ventilation | Taux | `u` (ou `U′`), `c` si le dénominateur est constant |
| Durée de séjour, IGS II, un délai | Mesure | `I-MR`, ou `EWMA` pour les dérives lentes |
| Quelques événements par an | Événement rare | `g` (cas entre) ou `t` (temps entre) |

Laisser **Type de carte** sur *Auto* laisse le plugin choisir au sein de cette
famille.

### Trois choix qui tranchent des cas réels

> [!WARNING]
> **Les événements rares sont le piège.** Un « taux de PAVM pour 1000 jours »
> calculé sur 2 événements par mois, c'est du bruit tracé avec autorité.
> En dessous d'environ 5 événements par période, utilisez une **carte g** : elle
> suit l'*intervalle entre* les événements, et une ligne qui **monte** signifie
> que les choses s'améliorent. C'est pour cela que les bactériémies sur cathéter
> et les extubations non programmées se tracent ainsi.

**Les grands dénominateurs surdispersent.** Au-delà d'environ 300 à 500 cas par
période, les limites d'une carte p deviennent si serrées que presque tous les
points sont signalés. C'est la carte qui échoue, pas le processus. Passez en
**P′ / U′** (Laney), qui corrige ce phénomène — le plugin vous prévient quand il
le détecte.

**Les petites dérives demandent EWMA.** Une carte de Shewhart (`p`, `u`, `c`,
`I-MR`) détecte au mieux les décrochages brusques et se lit le plus facilement.
**EWMA** détecte bien plus tôt les dérives faibles mais persistantes (0,5 à 1 σ),
au prix d'une courbe qui ne montre plus les données brutes. λ = 0,2 est la
convention ; plus petit signifie plus de mémoire et une réaction plus lente à un
vrai saut.

## La période de référence

Les limites sont estimées sur une **période de référence**, puis **figées** et
utilisées pour juger tout ce qui suit. Un repère en pointillés marque la fin de
cette période.

C'est tout l'intérêt de la carte. Si les limites étaient recalculées à chaque
nouvelle donnée, une dégradation lente les entraînerait avec elle — et la carte
absorberait silencieusement le problème même qu'elle est censée détecter.

Par défaut, toute la série sert de référence. Renseignez **Référence jusqu'au**
dès que vous disposez d'une période que vous jugez stable.

## Lire un signal

Un point hors des limites est un signal. Les *motifs* non aléatoires à
l'intérieur des limites en sont un autre : une longue série du même côté de la
ligne centrale, ou trop peu de franchissements de celle-ci.

Les **règles d'Anhøj** utilisées par défaut adaptent leurs seuils à la longueur
de la série. C'est délibéré : chaque règle ajoutée augmente la sensibilité et
diminue la spécificité, et une carte cumulant les huit règles Western Electric
alarme en permanence sur un processus parfaitement stable.

Un signal veut dire *regardez*, pas *agissez*. Il indique que la variation a peu
de chances d'être due au hasard — en trouver la cause reste votre travail.

## Avertissements possibles

Ils sont affichés plutôt que masqués, car chacun signifie que les nombres à
l'écran peuvent ne pas vouloir dire ce qu'ils semblent dire :

- **Trop peu de périodes** — des limites estimées sur une série courte sont
  elles-mêmes peu fiables. Visez 20 périodes ou plus pour leur faire confiance ;
  12 est un strict minimum.
- **Événements trop rares pour un taux** — passez à une carte g/t, voir plus haut.
- **Surdispersion** — vos dénominateurs sont grands ; utilisez `P′`/`U′`.
- **Dénominateur inapplicable** — le dénominateur choisi n'a pas de sens pour cet
  indicateur (par exemple une colonne d'exposition sur une carte de mesure).

## Un exemple complet

*Avons-nous plus d'infections sur cathéter central que d'habitude ?*

Vous avez une ligne par épisode infectieux, avec une date, et par ailleurs un
décompte mensuel de jours-cathéter.

1. **Nature de l'indicateur** → Taux. Des infections pour 1000 jours-cathéter est
   un taux rapporté à un temps d'exposition, pas une proportion de cas.
2. **Colonne de date** → la date de l'épisode. **Période** → Mois.
3. **Dénominateur** → Colonne d'exposition → votre colonne de jours-cathéter.
   **Base du taux** → 1000, pour que l'axe y se lise « pour 1000 jours-cathéter ».
4. **Référence jusqu'au** → la fin de l'année dernière, si elle était stable.

Le plugin trace une carte u dont les limites s'élargissent les mois de faible
activité. S'il avertit que les événements sont trop rares, basculez **Nature de
l'indicateur** sur *Événement rare* : avec quelques infections par an,
l'intervalle qui les sépare est la mesure honnête, et une ligne qui monte est une
bonne nouvelle.

## Pour aller plus loin

- Mohammed MA et al., *Plotting basic control charts* — le tutoriel de référence.
- Anhøj J, *Diagnostic value of run chart analysis* — les règles utilisées ici.
- Laney DB, *Improved control charts for attributes* — la correction P′/U′.
- Provost & Murray, *The Health Care Data Guide* — le manuel de référence.
