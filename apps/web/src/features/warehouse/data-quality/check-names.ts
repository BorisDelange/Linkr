import i18n from '@/lib/i18n'
import { bilingual, type Translate } from '@/lib/dq-templates'

/** The app's own wording in English and French, to name the checks it writes. */
export const checkNames = (): Translate =>
  bilingual({ en: i18n.getFixedT('en'), fr: i18n.getFixedT('fr') })
