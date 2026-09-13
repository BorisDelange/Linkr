## Introduction

Trace les mesures d'un patient en fonction du temps : la fréquence cardiaque au
long d'un séjour, trois lactates consécutifs, un réglage de ventilateur maintenu
deux jours. Vous choisissez les concepts, le widget retrouve chaque valeur
enregistrée pour ce patient et les trace sur un axe temporel commun que vous
pouvez zoomer et déplacer.

C'est un widget par patient, pas une analyse de cohorte. Il lit les tables
d'événements OMOP de l'entrepôt (measurement, observation, expositions
médicamenteuses et aux dispositifs, procédures, prélèvements) pour le seul
patient dont le dossier est ouvert, en croisant à la fois le concept standard et
le concept source, de sorte qu'une valeur codée localement apparaisse quand même.
Lorsqu'une visite est sélectionnée dans la barre latérale, seuls les événements
de cette visite sont tracés.

![Deux widgets Chronologie sur un dossier patient : les courbes de pression
artérielle en haut, et une perfusion de noradrénaline dessinée en barres en bas,
avec une infobulle donnant la dose et la
durée.](attachments/output.fr.png)

Ci-dessus : deux widgets sur le même tableau. Celui du haut est en mode
*Courbes*, celui du bas en *Formes mixtes* — la perfusion a un début et une fin,
elle est donc dessinée sous forme de barre avec la dose et la durée dans son
infobulle. Les deux affichent les mêmes heures parce que **Synchroniser la plage
temporelle** est activé.

## Réglages

**Concepts** et **Jeu de données** sont les deux sources, et l'une suffit.
Choisissez les concepts dans le sélecteur ; chacun devient une série.

**Jeu de données** trace un jeu de données sur le *même* axe, et c'est tout
l'intérêt : une variable recueillie à la main — les dates de début et de fin de
ventilation que vous avez notées vous-même — lue en regard de ce que le
respirateur a réellement écrit dans l'entrepôt, plutôt que dans deux fenêtres
côte à côte. Un jeu de données n'a pas de mapping de schéma : vous indiquez donc
quelles colonnes identifient le patient et portent les dates.

- **Colonne patient** et **Colonne date** sont obligatoires — une ligne qui ne
  nomme aucun patient, ou qu'on ne peut pas situer dans le temps, n'a rien à
  tracer.
- **Colonne hospitalisation** est facultative. Laissez-la vide pour un recueil
  fait par patient plutôt que par séjour : il s'affiche alors sur tous les
  séjours du patient.
- **Colonne date de fin** transforme chaque ligne en un bloc entre les deux dates
  au lieu d'un point — c'est ainsi qu'on trace une période de ventilation.
- **Colonne valeur** porte le nombre à tracer. Une valeur non numérique marque
  quand même l'événement dans le temps.
- **Colonne nom de série** découpe le jeu de données en une série par valeur
  distincte — utile quand une même table contient plusieurs variables (une
  colonne `paramètre`, par exemple).

Les lignes sont rapprochées du patient dont le dossier est ouvert : le widget
vous suit donc d'un patient à l'autre.

**Moteur de rendu** décide de la forme du graphique :

- *Courbes* trace un graphique linéaire classique, pour les mesures numériques
  continues.
- *Formes mixtes* donne à chaque concept sa propre ligne horizontale et dessine
  chaque événement sous la forme qui lui convient : une barre pour tout ce qui a
  un début et une fin (une perfusion, un séjour dans un lit), une ligne avec des
  points pour une valeur numérique répétée, un point unique pour un événement
  catégoriel ou ponctuel.
- *Automatique*, l'option par défaut, utilise des courbes tant que chaque concept
  sélectionné est une mesure numérique continue, et bascule vers les formes
  mixtes dès que l'un est catégoriel ou possède une durée.

**Afficher les points** (activé par défaut) dessine un marqueur à chaque valeur
enregistrée. Désactivez-le pour les séries de monitorage denses, où des milliers
de marqueurs se fondent en une tache.

**Courbe en escalier** maintient chaque valeur constante jusqu'à la suivante au
lieu d'interpoler entre elles — le rendu qui convient à tout ce qui est réglé
plutôt que mesuré : un mode ventilatoire, une PEP, un débit de pompe, une dose
prescrite.

**Axe Y commence à zéro** force l'axe à inclure zéro. Désactivé par défaut, pour
que l'axe s'adapte aux données.

**Épaisseur du trait** accepte 0,5 à 3 px. Un trait fin évite que des séries
denses se confondent ; un trait épais se lit mieux sur un vidéoprojecteur.

**Synchroniser la plage temporelle** lie la fenêtre visible de ce graphique à
celle des autres widgets synchronisés du tableau.

## Notes sur le widget

### Un seul axe des ordonnées en mode Courbes

En mode *Courbes*, tous les concepts sélectionnés sont tracés sur un **unique**
axe de valeurs. Il n'y a pas de second axe ni de normalisation : l'axe s'étend
donc de la plus petite valeur de toutes vos séries à la plus grande.

Des concepts d'échelles différentes sont par conséquent illisibles ensemble : une
fréquence cardiaque (60–130) tracée avec une numération plaquettaire
(50 000–300 000) s'écrase en une ligne plate au bas du graphique. Il n'existe
aucun paramètre pour cela — utilisez un second widget, répartissez sur chacun les
séries partageant un même ordre de grandeur, et activez **Synchroniser la plage
temporelle** sur les deux pour qu'ils se lisent comme un seul graphique empilé.

Les unités apparaissent dans l'infobulle, jamais sur l'axe, et seulement lorsque
le concept possède exactement une unité dans le dossier de ce patient. Un concept
enregistré dans deux unités n'affiche aucune unité, plutôt que d'étiqueter le
tout avec la première.

### Synchroniser la plage temporelle, et jusqu'où elle porte

Avec **Synchroniser la plage temporelle** activé, ce widget partage sa fenêtre
visible avec les autres widgets synchronisés du tableau — chronologies comme
widgets Vue d'ensemble des données. Zoomez sur un épisode de six heures dans l'un
et tous les graphiques synchronisés suivent.

Les paramètres du tableau décident de la portée : par défaut, le partage s'arrête
à l'onglet où se trouvent les widgets, et une option au niveau du tableau
l'étend à tous les onglets. Le partage reste toujours limité au tableau : deux
tableaux ouverts sur deux patients ne se renvoient jamais leurs fenêtres.
Changer de patient libère la fenêtre partagée au lieu de la reporter.

### Ce que le graphique dessine et que le dossier ne contient pas

> [!WARNING]
> **Entre deux points, la ligne est tracée par le graphique, pas mesurée sur le
> patient.** Avec **Courbe en escalier** désactivé, les valeurs consécutives sont
> reliées par un segment droit ; avec l'option activée, par un escalier. Ce sont
> deux rendus, pas des données. Sur les séries clairsemées — un lactate deux fois
> par jour, une valeur qui n'existe que quand quelqu'un a fait un gaz du sang —
> gardez **Afficher les points** activé pour que les marqueurs disent où se
> trouve réellement la preuve, et ne lisez pas une valeur sur la ligne à un
> instant où aucun point ne figure.

La même prudence s'applique à l'axe. Avec **Axe Y commence à zéro** désactivé,
l'axe s'ajuste aux données, si bien qu'une variable ayant bougé de trois unités
remplit le graphique ; activé, une variation réelle peut être aplatie en une
simple bosse, et pour les variables dont l'intervalle est loin de zéro toute la
série se retrouve tassée en haut du graphique. Lisez les étiquettes de l'axe
avant de lire la forme.

## Un exemple travaillé

*Tracer l'hémodynamique et les médicaments qui la soutiennent.*

Le dossier d'un patient, séjour de réanimation sélectionné dans la barre
latérale.

1. **Concepts** → pression artérielle moyenne, fréquence cardiaque. Même ordre de
   grandeur, donc un axe unique reste lisible.
2. **Moteur de rendu** → *Automatique* ; les deux sont des valeurs numériques
   continues, il trace donc des courbes.
3. **Afficher les points** → activé, **Courbe en escalier** → désactivée. Ce sont
   des valeurs mesurées, pas des réglages maintenus.
4. **Axe Y commence à zéro** → désactivé, pour que l'intervalle sur lequel porte
   la question ne soit pas comprimé.
5. **Synchroniser la plage temporelle** → activé.

Ajoutez ensuite un second widget Chronologie sur le même tableau, avec le
vasopresseur et l'antibiotique comme **Concepts** et **Moteur de rendu** sur
*Formes mixtes* — la perfusion est une durée et obtient une barre,
l'administration de l'antibiotique un point — et **Synchroniser la plage
temporelle** activé. Zoomez sur l'un des deux graphiques et les deux suivent.

S'il manque une série que vous attendiez, commencez par vérifier le sélecteur de
concepts : le widget croise les concepts standards *et* sources, mais un concept
jamais mappé dans cet entrepôt n'a rien à tracer.
