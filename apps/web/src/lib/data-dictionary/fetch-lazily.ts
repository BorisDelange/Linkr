import type { DictionaryFetcher } from './dictionary-links'

/** `fetchDictionary`, loaded on first use: ./repo reaches into the stores, which
 *  load the import modules that call this. */
export const fetchDictionaryLazily: DictionaryFetcher = (url, branch, language) =>
  import('./repo').then((m) => m.fetchDictionary(url, branch, language))
