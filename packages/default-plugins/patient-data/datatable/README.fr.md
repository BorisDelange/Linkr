## Introduction

Montre les mesures d'un patient comme le tableau de suivi d'un dossier patient :
les concepts choisis en lignes, le temps en colonnes, et dans chaque cellule ce
que la période contient — la fréquence cardiaque moyenne de chaque tranche de six
heures, le dernier lactate de chaque jour — avec, à côté, le nombre d'événements
que ce chiffre résume.

C'est un widget par patient. Il lit les tables d'événements de l'entrepôt pour le
patient dont le dossier est ouvert, en cherchant l'identifiant de concept standard
comme l'identifiant source, et ne cherche dans chaque table que les concepts que
le comptage de la base y a trouvés. Quand un séjour est choisi dans la barre
latérale, seuls les événements de ce séjour comptent.

## Paramètres

**Concepts** : les lignes, dans l'ordre où ils ont été choisis.

**Colonnes** : en combien de périodes de même durée la fenêtre visible est
découpée. Zoomer garde ce nombre et change leur durée.

**Agrégat** : ce qu'une cellule montre des valeurs de sa période — la moyenne, la
médiane, le minimum, le maximum ou la somme des valeurs numériques, le nombre
d'événements, ou la valeur du premier ou du dernier événement de la période, texte
compris pour une observation catégorielle.

**Afficher les effectifs** : écrit après chaque valeur le nombre d'événements
qu'elle résume. Une moyenne d'une mesure et une moyenne de trois cents ne pèsent
pas pareil.

**Synchroniser la plage temporelle** : partage la fenêtre avec les autres widgets
synchronisés du tableau de bord — timelines comme vues d'ensemble —, de sorte que
le tableau suit un zoom fait sur une courbe, et inversement.

## Utilisation

Les flèches décalent la fenêtre d'une colonne ; les loupes la divisent ou la
doublent autour de son milieu ; le bouton cadre revient au dossier entier du
patient pour ces concepts. Au survol d'une cellule : le concept, l'agrégat, le
nombre d'événements et la période couverte.

Les agrégats sont calculés par la base : une colonne sur une année de
monitorage coûte une ligne, jamais les événements de l'année, et le tableau reste
léger sur les dossiers les plus volumineux.
