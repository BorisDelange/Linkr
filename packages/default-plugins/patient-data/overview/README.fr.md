## Introduction

Tous les événements d'un patient, disposés sur un seul axe temporel et regroupés
par table source d'origine et par concept enregistré. Chaque ligne est un concept
— un analyte de laboratoire, un médicament, un signal de monitorage — et son
ombrage indique à quelle densité ce concept a été enregistré à cet instant.
Zoomez suffisamment et les bandes cessent d'être une densité pour devenir les
événements eux-mêmes.

Il montre **ce que contient réellement le dossier d'un patient, et sur quelle
période** : une requête de cohorte vous dit qu'un patient a un lactate, pas que
ce lactate existe au jour 1 et au jour 9 et nulle part entre les deux, ni que
toute la table des médicaments commence trois jours après l'admission parce que
c'est à ce moment-là que l'unité est passée au logiciel de prescription.

![Le widget Vue d'ensemble des données : les tables sources à gauche avec leur
nombre de concepts, les bandes de densité sur toute la largeur, et les transferts
d'unité du patient en haut.](attachments/output.fr.png)

Ci-dessus : un séjour, lu comme un dossier et non comme un patient. Les
événements de surveillance portent 223 concepts et 3578 lignes ; laboratoires,
entrées, prescriptions et procédures ont chacun leur bande. La bande des
transferts en haut indique dans quelle unité se trouvait le patient à chaque
instant — et les interruptions visibles dans les bandes sont ce dont il faut se
méfier : elles disent que les données s'arrêtent là, pas qu'il ne s'est rien
passé.

## Réglages

Rien de plus qu'un patient et un schéma mappé. Le widget lit les tables OMOP
exposées par la base active de votre projet — mesures, observations, expositions
médicamenteuses, procédures, conditions, visites — et construit ses lignes à
partir de ce qu'il y trouve. Il n'y a pas de colonnes à choisir : c'est une vue
sur le dossier, pas un graphique sur un jeu de données.

Six paramètres modifient ce qu'il affiche :

- **Grouper par classe de concept** ajoute un niveau entre une table source et
  ses concepts, d'après la classe propre au vocabulaire (`concept_class_id` OMOP,
  `category` MIMIC). Sur une table de mesures comptant des centaines d'analytes,
  cela transforme une liste illisible en une poignée de familles repliables. Le
  paramètre est ignoré lorsque le schéma actif n'a pas de colonne de classe.
- **Afficher les séjours par unité** trace une ligne indiquant l'unité où se
  trouvait le patient au cours du temps. Il faut une table de détail de visite
  dans le mapping du schéma ; sans elle, la ligne n'apparaît tout simplement pas.
- **Marquer le décès** place un repère vertical au décès enregistré dans le
  dossier, s'il y en a un — le repère le plus utile pour lire tout ce qui se
  trouve à sa gauche.
- **Hauteur de ligne** échange du détail contre de la couverture. *Compact* fait
  tenir davantage de concepts individuellement avant que la figure ne doive les
  regrouper ; *Grand* en montre moins, mais lisiblement.
- **Synchroniser la plage temporelle** partage la fenêtre visible avec les autres
  widgets synchronisés du tableau, de sorte qu'une chronologie de constantes
  vitales et cette vue d'ensemble défilent ensemble.
- **Sélecteur de plage** conserve sous le graphique une bande montrant tout le
  dossier, avec la fenêtre visible sous forme de cadre déplaçable — à laisser
  activé, car c'est la seule chose qui vous dit quelle part du séjour vous *ne*
  regardez *pas*.

## Notes sur le widget

### Un espace vide, ce sont des données manquantes, pas un patient tranquille

> [!WARNING]
> **Un trou dans une bande signifie qu'aucune donnée n'a été écrite, pas qu'il ne
> s'est rien passé.** Une période sans créatinine peut vouloir dire que personne
> n'en a demandé, que le patient avait quitté l'unité, que l'analyte provenait
> d'un appareil qui n'a jamais alimenté l'entrepôt, ou que l'ETL l'a perdu. Le
> widget ne peut pas faire la différence. Activez **Afficher les séjours par
> unité** avant de lire le moindre trou : cela vous dit au moins si le patient
> était présent.

### Lire les bandes

L'intensité de la couleur le long d'une ligne est un nombre d'événements par
pixel de temps : la même ligne paraît donc continue pendant une période surveillée
et clairsemée pendant une période plus calme, sans le moindre changement de
pratique. Zoomez — par glissement sur le graphique — et les bandes se résolvent en
événements individuels avec leurs horodatages.

Une ligne dense qui s'arrête net alors que ses voisines continuent mérite un coup
d'œil : chez un patient donné, c'est un événement clinique, mais répétée sur
plusieurs patients, elle pointe généralement la fenêtre d'extraction de la table
source plutôt que les soins.

Les concepts sont classés par nombre d'événements, et ceux qui ne tiennent pas
sont regroupés dans une ligne **Autres** qui indique combien sont masqués
au-dessus et en dessous. **Hauteur de ligne** échange du détail contre de la
couverture : *Compact* fait tenir davantage de concepts individuellement avant
regroupement, *Grand* en montre moins mais plus lisiblement.

### Vérifier un séjour après une exécution de pipeline

Le widget est le moyen le plus rapide de voir ce que contient réellement le
dossier d'un patient après une modification de l'ETL. Ouvrez un séjour long et
complexe avec **Grouper par classe de concept** et **Sélecteur de plage** activés,
et parcourez les tables sources : une table entièrement absente, une famille de
concepts qui n'apparaît qu'après une certaine date, ou une ligne qui s'arrête en
milieu de séjour se voient en quelques secondes et sont difficiles à repérer dans
des contrôles agrégés.

Avec **Synchroniser la plage temporelle** activé, ce widget partage sa fenêtre
avec les chronologies du même tableau, ce qui permet d'aligner la couverture du
dossier sur les mesures que vous tracez.
