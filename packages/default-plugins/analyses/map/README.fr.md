# Carte

Affiche vos lignes sous forme de points sur une carte interactive, à partir d'une
colonne de latitude et d'une colonne de longitude. Utilisez-la pour voir d'où
viennent les patients, comment des cas se répartissent sur un territoire, ou
quelle distance les gens parcourent pour atteindre votre service.

La géographie est l'une des rares variables qu'un tableau restitue vraiment mal.
Une carte rend évidents les bassins de recrutement, les zones non couvertes et les
effets de distance, ce qu'une liste de codes postaux ne fera jamais.

![Carte de recrutement d'une réanimation : un cercle par commune bretonne,
dimensionné par le nombre de séjours, sur un fond OpenStreetMap.](attachments/output.fr.png)

Ci-dessus : 28 communes, dimensionnées par le nombre de séjours envoyés. La
forme attendue est une décroissance avec la distance autour de la ville du
centre — et l'intérêt de la carte est ce qui rompt ce motif, une commune
éloignée qui adresse bien plus que sa distance ne le laisserait attendre.

## Ce qu'il vous faut

Deux colonnes numériques : **Latitude** et **Longitude**, en degrés décimaux
(48,1173 ; −1,6778), ni en degrés-minutes-secondes, ni sous forme d'adresse
textuelle. Les lignes dont les coordonnées sont illisibles ou hors bornes sont
écartées silencieusement : si moins de points s'affichent que prévu, vérifiez
d'abord vos colonnes de coordonnées — l'inversion latitude/longitude est l'erreur
classique, et elle envoie généralement toute votre cohorte en mer au large de
l'Afrique de l'Ouest.

Une étape de géocodage en amont est normalement nécessaire pour transformer des
adresses ou des codes postaux en coordonnées. Faites-la une fois, dans un
pipeline, et stockez le résultat.

Trois colonnes facultatives changent ce que disent les points :

- **Couleur par** — une colonne catégorielle. Chaque valeur distincte reçoit sa
  couleur et une entrée de légende. Limitez-vous à quelques catégories.
- **Taille par** — une colonne numérique qui module le rayon de chaque point,
  transformant la carte en carte à bulles. C'est ainsi qu'on représente un
  *effectif* par lieu.
- **Étiquette** et **Champs du popup au survol** — le texte affiché à côté d'un
  point et dans son infobulle.

La carte se cadre automatiquement sur vos données au chargement : inutile de
définir un centre ou un niveau de zoom.

## Ne cartographiez jamais les patients à leur domicile

> [!WARNING]
> **Un point au domicile de quelqu'un est une donnée identifiante.** Une carte
> publiée à la résolution de la rue peut être retournée en adresses individuelles
> avec une grande précision — c'est une attaque démontrée, pas une hypothèse
> théorique, et flouter ou réduire l'image n'y change rien. Agrégez avant de
> cartographier : comptez les patients par commune, code postal ou territoire de
> santé, et tracez un point par *zone*, dimensionné par son effectif. Les
> coordonnées individuelles ont leur place dans un jeu de données de travail sous
> contrôle d'accès, jamais dans un tableau de bord qui finira en capture d'écran
> dans un diaporama.

L'agrégation est aussi ce qui rend la carte lisible : cette contrainte ne vous
coûte donc presque rien. Les petites zones comptant très peu de patients méritent
malgré tout réflexion, même agrégées : un cas unique dans un village de 200
habitants n'est guère plus anonyme qu'un point sur une maison. Supprimer ou
fusionner les cellules sous un seuil de petits effectifs est une pratique
courante, et vos règles de protection des données l'exigent probablement.

## Les effectifs bruts reproduisent la carte de la population

Voici le piège qui guette la plupart des cartes sanitaires. Tracez des effectifs
bruts de cas par commune et vous trouverez les plus gros cercles sur les plus
grandes villes. Ce n'est pas un résultat : **il y habite plus de monde, donc il y
a plus de tout.** Vous avez dessiné une carte de la population avec des étapes
supplémentaires.

Pour dire quelque chose du risque, cartographiez un **taux** — cas pour 1000
habitants, pour 100 000, ou un ratio standardisé — calculé dans votre pipeline
puis injecté dans **Taille par** ou **Couleur par**. C'est une autre carte, et
elle désigne souvent un endroit tout à fait différent des effectifs bruts.

Deux précautions une fois passé aux taux. Les petits dénominateurs produisent des
taux extravagants : une commune de 300 habitants avec 2 cas dépasse toutes les
autres, sur du bruit seul. Et la couleur d'une zone décrit la zone, pas les
personnes qui l'habitent — passer de « ce territoire a un taux élevé » à « cette
personne est à risque élevé » est le sophisme écologique, une erreur qu'il vaut la
peine de nommer à voix haute quand une carte est présentée à des cliniciens.

## Rendre lisible une carte chargée

Les points situés au même endroit se superposent et se masquent : une carte dense
sous-représente donc systématiquement ses zones les plus denses — exactement
l'inverse de ce qu'on veut. Deux réglages aident : baissez l'**Opacité (%)** pour
que les superpositions foncent visiblement au lieu qu'un point cache les autres,
et réduisez la **Taille des points** quand ils sont nombreux.

Au-delà de quelques milliers de marqueurs, la solution honnête est l'agrégation,
pas le style. Une bulle par commune, dimensionnée par l'effectif, dit sur la
densité une vérité que mille points superposés ne peuvent pas dire.

**Fond de carte** choisit les tuiles. *Clair (Carto)* garde un arrière-plan
discret pour que vos données portent la couleur, ce qui est généralement
souhaitable ; *OpenStreetMap* apporte plus de contexte (noms de rues, repères) au
prix d'un bruit visuel. Toutes les tuiles en ligne nécessitent un accès réseau :
choisissez *Aucun (hors-ligne)* sur un réseau hospitalier isolé, et les points
seront tracés sur un fond neutre.

## Un exemple complet

*D'où notre réanimation recrute-t-elle ?*

Partez d'une ligne par séjour, avec le code postal du patient.

1. **En amont**, dans un jeu de données ou un pipeline : joignez le code postal à
   une table de référence des centroïdes de communes, puis regroupez par commune
   pour obtenir une ligne par commune avec un effectif de patients, sa latitude et
   sa longitude. Écartez ou fusionnez les communes sous votre seuil de petits
   effectifs. C'est cette étape qui rend la carte à la fois licite et lisible.
2. **Latitude** / **Longitude** → les colonnes de centroïdes.
3. **Taille par** → l'effectif de patients.
4. **Champs du popup au survol** → le nom de la commune et l'effectif, pour qu'un
   lecteur obtienne le chiffre exact sans le deviner d'après le cercle.
5. **Fond de carte** → *Clair (Carto)*.

Vous obtenez une carte de recrutement. Attendez-vous à une grosse bulle sur votre
propre ville et à un halo décroissant autour — la décroissance avec la distance,
qui est la forme attendue.

L'intéressant est ce qui rompt ce motif : une commune éloignée comptant bien plus
de patients que sa distance ne le laisse prévoir (un établissement adresseur, un
partenariat), ou un creux tout proche où un centre concurrent capte le flux. Pour
transformer cela en un énoncé sur l'*accès* plutôt que sur le volume, ajoutez en
amont la population de chaque commune et dimensionnez par patients pour 1000
habitants — la carte changera d'allure, et c'est précisément l'intérêt.

## Pour aller plus loin

- [Brownstein JS, Cassa CA & Mandl KD, *No place to hide — reverse identification of patients from published maps*](https://www.nejm.org/doi/full/10.1056/NEJMc061891) — pourquoi les points individuels ne peuvent pas être publiés.
- [Zandbergen PA, *Ensuring confidentiality of geocoded health data*](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4590956/) — revue des stratégies de masquage géographique des données individuelles.
- [Cassa CA et al., *A context-sensitive approach to anonymizing spatial surveillance data*](https://pubmed.ncbi.nlm.nih.gov/16357353/) — l'effet du masquage sur la confidentialité comme sur la détection d'épidémies.
- [Krzywinski M & Altman N, *Visualizing samples with box plots*](https://www.nature.com/articles/nmeth.2813) — le principe général : une représentation ne doit pas masquer la densité qu'elle prétend montrer.
