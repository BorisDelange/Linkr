/**
 * Print the vocabulary fill script the Vocabulary tab generates today, for a
 * vocabulary database holding the tables named on the command line — the demo
 * pipeline is run with it instead of the copy its repository holds, which an
 * older builder wrote.
 *
 *   npx tsx --tsconfig apps/web/tsconfig.app.json tests/etl-demo/fill-vocabulary-script.ts concept concept_ancestor …
 */
import { buildFillVocabularyScript } from '@/features/warehouse/etl/build-vocabulary-script'

process.stdout.write(buildFillVocabularyScript(undefined, process.argv.slice(2)))
