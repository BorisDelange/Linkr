L'en-tête d'un dossier patient : identifiant, sexe, âge, statut vital, nombre
d'hospitalisations et de séjours par unité que contient le dossier, et une barre
par séjour indiquant où le patient se trouvait et quand.

C'est un widget par patient, pas une analyse de cohorte. Il lit les tables
person, visit, visit detail et death mappées dans votre schéma de base, pour le
patient dont le dossier est ouvert, et affiche ce qu'il y trouve.

![Le widget Résumé patient : identifiant, sexe, âges, statut de décès, nombre
d'hospitalisations et de séjours par unité, au-dessus d'une barre par séjour en
unité.](attachments/output.fr.png)

Ci-dessus : une seule hospitalisation mais sept séjours par unité — urgences,
médecine/chirurgie, SSPI, puis soins intensifs cardiologiques. Les deux âges
affichent `—` parce que cet extrait ne porte aucune année de naissance ; le
widget laisse la tuile vide plutôt que de calculer quelque chose.

## Réglages

Aucun. Les champs que votre schéma ne mappe pas n'apparaissent tout simplement
pas — sans table de détail de visite, pas de tuile de séjours par unité ni de
barres de séjour.

Un seul choix d'affichage se trouve dans le widget lui-même : le panneau des
séjours bascule entre une **chronologie Gantt** (l'option par défaut, avec zoom,
zoom par glissement et double-clic pour réinitialiser) et une vue **texte**
listant chaque visite avec ses dates, sa durée de séjour et ses lignes d'unité,
et indiquant l'intervalle entre deux visites consécutives. Un clic droit sur une
barre du Gantt permet de naviguer vers cette visite.

Le sexe est la valeur codée de votre schéma traduite en masculin ou féminin, avec
la valeur brute affichée lorsqu'elle ne correspond à aucun des deux. La race et
l'origine ethnique ne sont pas affichées.

## Comment les deux âges sont calculés

> [!WARNING]
> **L'âge est une soustraction d'années, et ce n'est pas l'âge actuel du
> patient.** Deux âges sont affichés — à la *première* visite du dossier et à la
> *dernière* — chacun dérivé de l'année de naissance et de l'année de cette
> visite. Le mois et le jour sont écartés même lorsqu'une date de naissance
> complète est disponible : un âge affiché peut donc être décalé d'un an dans un
> sens ou dans l'autre. Les extraits dépersonnalisés réduisent généralement la
> date de naissance à une année, décalent les dates d'un écart propre à chaque
> patient, ou les deux. Servez-vous de cette tuile pour vous repérer, jamais
> comme variable d'analyse : calculez l'âge dans une chaîne de traitement, à
> partir des dates, avec la règle d'arrondi que votre étude définit.

« Âge à la première visite » est l'âge à la visite la plus ancienne *présente
dans cette base*, ce qui n'est pas l'âge au premier contact avec votre hôpital :
un extrait couvrant 2015–2024 présente un patient suivi depuis 2003 comme vu pour
la première fois en 2015. Si le schéma ne mappe aucune table de visites, un seul
âge, calculé par rapport à la date du jour, est affiché à la place.

## Ce que comptent les compteurs

**Hospitalisations** compte les visites distinctes ; **Séjours par unité** compte
les lignes de la table de détail de visite. Les deux découlent directement de la
façon dont votre ETL définit une visite — en particulier, selon qu'un transfert
entre services clôt une visite et en ouvre une autre, ou poursuit une même
hospitalisation avec deux séjours par unité. Le même patient et les mêmes soins
donnent deux tuiles différentes selon la convention retenue : lisez donc ces
nombres relativement aux autres patients chargés par la même chaîne de
traitement.

La vue Gantt montre la convention directement : des barres qui se rejoignent
exactement à l'heure d'un transfert révèlent un ETL qui découpe au transfert.

## Ce que signifie la tuile de décès

Elle affiche une date lorsqu'il en existe une, et « non » sinon. Ce « non »
signifie *aucun décès enregistré dans cette base* — en général, seuls les décès
survenus à l'hôpital sont connus, à moins que le site ne soit relié à un registre
de décès.

## Pour aller plus loin

- [Spécification OMOP CDM v5.4](https://ohdsi.github.io/CommonDataModel/cdm54.html) — ce que contiennent réellement person, visit, visit detail et death, et pourquoi l'année de naissance est la seule partie de date garantie.
- [The Book of OHDSI, *Extract, Transform, Load*](https://ohdsi.github.io/TheBookOfOhdsi/ExtractTransformLoad.html) — là où se décide la convention de visite qui sous-tend ces compteurs.
- [El Emam K & Dankar FK, *Protecting privacy using k-anonymity*](https://pmc.ncbi.nlm.nih.gov/articles/PMC2528029/) — pourquoi les âges et les dates sont généralisés en premier lieu, et ce que cela coûte à l'analyste.
