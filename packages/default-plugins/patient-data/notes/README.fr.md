Une visionneuse de documents pour les notes d'un patient : comptes rendus
d'hospitalisation, notes d'évolution, comptes rendus de radiologie — tout ce que
votre système source écrit en texte libre et que votre ETL fait aboutir dans la
table OMOP `note`.

C'est un widget par patient, pas une analyse de cohorte. Il lit la table note
mappée dans votre schéma de base pour le patient dont le dossier est ouvert, et
affiche ce qui s'y trouve. Si aucune table note n'est mappée, le widget le
signale.

![Le widget Notes cliniques : la liste des documents d'un patient à gauche, un
compte rendu d'hospitalisation ouvert à droite, avec le terme recherché surligné
dans le texte.](attachments/output.fr.png)

Ci-dessus : un document ouvert parmi 29, avec une recherche de `pneumonia` qui en
fait correspondre 18 — le compteur à côté du champ de recherche donne le nombre
de correspondances, et le terme est surligné dans le corps du texte.

## Réglages

Aucun. Le widget n'a rien à configurer ; tout ce qu'il propose se trouve dans sa
propre barre d'outils, au-dessus de la liste des documents :

- **Tri** — par date ou par nom.
- **Filtre** — sur les titres et les types de documents, pour resserrer une
  longue liste.
- **Recherche** — en texte intégral sur le corps des notes, avec les
  correspondances surlignées et un compteur indiquant combien de documents
  correspondent.
- **Ensembles de mots** — des groupes de termes nommés et colorés, que vous
  enregistrez une fois et réappliquez ensuite. Un ensemble surligne tous ses
  termes partout où ils apparaissent, et peut au besoin réduire la liste aux
  documents qui les contiennent.

Chaque document affiche son titre, sa date et son type. En OMOP, ce type provient
généralement de la valeur source de la note : ce que vous voyez est donc la
catégorie de document propre à votre système source (« Compte rendu
d'hospitalisation », « Transmission infirmière », un code local), et non un
vocabulaire standardisé. Les documents sont listés du plus récent au plus ancien.
Lorsqu'une note porte un identifiant de visite, la visionneuse l'affiche, et
sélectionner une visite dans la barre latérale restreint la liste aux documents
de cette visite.

## Les ensembles de mots sont une correspondance de mots-clés

Un ensemble de mots surligne des termes littéraux. Il n'a aucune notion de
négation, de qui est le sujet, ni d'une phrase recopiée depuis une note
antérieure — un surlignage signale donc un endroit où regarder, pas un constat.
Le compteur vous dit combien de documents contiennent un terme : c'est un
résultat de recherche, pas une prévalence.

Les ensembles sont enregistrés et réutilisables : un ensemble constitué une fois
pour un projet (« saignement », « délire », « dispositif ») reste disponible sur
tous les dossiers patients.

## Captures d'écran et exports sortent de la visionneuse

> [!WARNING]
> **Les notes sont la partie la plus identifiante d'un dossier, et ce widget les
> affiche intégralement.** Le texte libre contient couramment des noms, des
> dates, des lieux et des numéros de téléphone, même dans un extrait décrit comme
> dépersonnalisé, parce que les chaînes de dépersonnalisation fonctionnent
> beaucoup mieux sur les champs structurés que sur de la prose. Lire une note sur
> un dossier est une chose ; une capture d'écran dans une présentation, une figure
> exportée ou un tableau de bord partagé en est une autre, et fait sortir le texte
> du cadre qui régit votre entrepôt. Vérifiez ce qui est réellement à l'écran
> avant de le capturer.

## Ce que le widget lit

Uniquement la table `note` mappée. Il ne lit pas `note_nlp` : les annotations
produites par votre chaîne de traitement ne sont donc pas affichées ici. Un
document absent de la liste est absent du mapping — c'est du côté de l'ETL qu'il
faut regarder, pas de ce widget.

## Pour aller plus loin

- [Spécification OMOP CDM v5.4](https://ohdsi.github.io/CommonDataModel/cdm54.html) — ce que contient la table `note`, et en quoi le type de note et la valeur source diffèrent.
- [The Book of OHDSI, *Extract, Transform, Load*](https://ohdsi.github.io/TheBookOfOhdsi/ExtractTransformLoad.html) — là où se décident les types de documents et les liens vers les visites, c'est-à-dire ce qui détermine cette liste.
- [El Emam K & Dankar FK, *Protecting privacy using k-anonymity*](https://pmc.ncbi.nlm.nih.gov/articles/PMC2528029/) — pourquoi retirer les noms n'équivaut pas à anonymiser, démontré sur des données de santé.
- [Stubbs A, Kotfila C & Uzuner Ö, *Automated systems for the de-identification of longitudinal clinical narratives*](https://pmc.ncbi.nlm.nih.gov/articles/PMC4989908/) — la performance réelle de la dépersonnalisation automatique sur de vraies notes, et là où elle échoue.
