// Linkr's reference article, in the formats the Cite dialog offers.
// Metadata checked against Crossref (DOI content negotiation).

export const LINKR_DOI = '10.1016/j.ijmedinf.2025.105876'
const DOI_URL = `https://doi.org/${LINKR_DOI}`

const TITLE = 'LinkR: An open source, low-code and collaborative data science platform for healthcare data analysis and visualization'
const TITLE_CASED = 'LinkR: An Open Source, Low-Code and Collaborative Data Science Platform for Healthcare Data Analysis and Visualization'
const JOURNAL = 'International Journal of Medical Informatics'
const AUTHORS = [
  { given: 'Boris', family: 'Delange' },
  { given: 'Benjamin', family: 'Popoff' },
  { given: 'Thibault', family: 'Séité' },
  { given: 'Antoine', family: 'Lamer' },
  { given: 'Adrien', family: 'Parrot' },
]

export interface CitationFormat {
  id: string
  label: string
  /** File formats are meant for reference managers: shown monospace, downloadable. */
  file?: { extension: string; mime: string }
  text: string
}

export const CITATION_FORMATS: CitationFormat[] = [
  {
    id: 'apa',
    label: 'APA (7th ed.)',
    text: `Delange, B., Popoff, B., Séité, T., Lamer, A., & Parrot, A. (2025). ${TITLE}. ${JOURNAL}, 199, 105876. ${DOI_URL}`,
  },
  {
    id: 'vancouver',
    label: 'Vancouver',
    text: `Delange B, Popoff B, Séité T, Lamer A, Parrot A. ${TITLE}. Int J Med Inform. 2025 Jul;199:105876. doi: ${LINKR_DOI}`,
  },
  {
    id: 'ama',
    label: 'AMA (11th ed.)',
    text: `Delange B, Popoff B, Séité T, Lamer A, Parrot A. LinkR: an open source, low-code and collaborative data science platform for healthcare data analysis and visualization. Int J Med Inform. 2025;199:105876. doi:${LINKR_DOI}`,
  },
  {
    id: 'harvard',
    label: 'Harvard',
    text: `Delange, B., Popoff, B., Séité, T., Lamer, A. and Parrot, A. (2025) '${TITLE}', ${JOURNAL}, 199, p. 105876. doi:${LINKR_DOI}`,
  },
  {
    id: 'mla',
    label: 'MLA (9th ed.)',
    text: `Delange, Boris, et al. "${TITLE_CASED}." ${JOURNAL}, vol. 199, July 2025, p. 105876, ${DOI_URL}.`,
  },
  {
    id: 'chicago',
    label: 'Chicago (author-date)',
    text: `Delange, Boris, Benjamin Popoff, Thibault Séité, Antoine Lamer, and Adrien Parrot. 2025. "${TITLE_CASED}." ${JOURNAL} 199: 105876. ${DOI_URL}.`,
  },
  {
    id: 'ieee',
    label: 'IEEE',
    text: `B. Delange, B. Popoff, T. Séité, A. Lamer, and A. Parrot, "${TITLE}," Int. J. Med. Inform., vol. 199, Art. no. 105876, Jul. 2025, doi: ${LINKR_DOI}.`,
  },
  {
    id: 'bibtex',
    label: 'BibTeX',
    file: { extension: 'bib', mime: 'application/x-bibtex' },
    text: `@article{Delange2025LinkR,
  title   = {{LinkR}: An open source, low-code and collaborative data science platform for healthcare data analysis and visualization},
  author  = {Delange, Boris and Popoff, Benjamin and S{\\'e}it{\\'e}, Thibault and Lamer, Antoine and Parrot, Adrien},
  journal = {${JOURNAL}},
  volume  = {199},
  pages   = {105876},
  year    = {2025},
  month   = jul,
  issn    = {1386-5056},
  doi     = {${LINKR_DOI}},
  url     = {${DOI_URL}}
}`,
  },
  {
    id: 'biblatex',
    label: 'BibLaTeX',
    file: { extension: 'bib', mime: 'application/x-bibtex' },
    text: `@article{Delange2025LinkR,
  title        = {{LinkR}: An open source, low-code and collaborative data science platform for healthcare data analysis and visualization},
  author       = {Delange, Boris and Popoff, Benjamin and Séité, Thibault and Lamer, Antoine and Parrot, Adrien},
  journaltitle = {${JOURNAL}},
  shortjournal = {Int J Med Inform},
  volume       = {199},
  eid          = {105876},
  date         = {2025-07},
  issn         = {1386-5056},
  doi          = {${LINKR_DOI}}
}`,
  },
  {
    id: 'ris',
    label: 'RIS (Zotero, Mendeley)',
    file: { extension: 'ris', mime: 'application/x-research-info-systems' },
    text: [
      'TY  - JOUR',
      `TI  - ${TITLE}`,
      ...AUTHORS.map((a) => `AU  - ${a.family}, ${a.given}`),
      `T2  - ${JOURNAL}`,
      'J2  - Int J Med Inform',
      'PY  - 2025',
      'DA  - 2025/07',
      'VL  - 199',
      'SP  - 105876',
      'SN  - 1386-5056',
      `DO  - ${LINKR_DOI}`,
      `UR  - ${DOI_URL}`,
      'ER  - ',
    ].join('\n'),
  },
  {
    id: 'endnote',
    label: 'EndNote',
    file: { extension: 'enw', mime: 'application/x-endnote-refer' },
    text: [
      '%0 Journal Article',
      `%T ${TITLE}`,
      ...AUTHORS.map((a) => `%A ${a.family}, ${a.given}`),
      `%J ${JOURNAL}`,
      '%V 199',
      '%P 105876',
      '%D 2025',
      '%8 July',
      '%@ 1386-5056',
      `%R ${LINKR_DOI}`,
      `%U ${DOI_URL}`,
    ].join('\n'),
  },
  {
    id: 'csl-json',
    label: 'CSL-JSON',
    file: { extension: 'json', mime: 'application/vnd.citationstyles.csl+json' },
    text: JSON.stringify([{
      id: 'Delange2025LinkR',
      type: 'article-journal',
      title: TITLE,
      author: AUTHORS,
      'container-title': JOURNAL,
      'container-title-short': 'Int J Med Inform',
      volume: '199',
      number: '105876',
      issued: { 'date-parts': [[2025, 7]] },
      ISSN: '1386-5056',
      DOI: LINKR_DOI,
      URL: DOI_URL,
    }], null, 2),
  },
]
