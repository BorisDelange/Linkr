/**
 * Which statistical tests can legitimately run on a given variable.
 *
 * Used twice, and it matters that both use the same answer: it fills the
 * per-variable test picker in the results table, and it validates an override
 * already stored in the config. A pinned Welch t-test becomes inapplicable the
 * moment the group column changes to three levels, and running it anyway would
 * produce a number the data cannot support.
 */

/** Every test the Statistical tests plugin can run. */
export type TestName =
  | 'welch-t'
  | 'mann-whitney'
  | 'chi-square'
  | 'fisher'
  | 'anova'
  | 'kruskal-wallis'

/**
 * The tests available for a variable, given its type and the number of groups
 * being compared. The parametric option comes first in each pair, which is the
 * order the picker shows.
 */
export function applicableTests(
  variableType: 'numeric' | 'categorical',
  groupCount: number,
): TestName[] {
  if (variableType === 'categorical') return ['chi-square', 'fisher']
  return groupCount === 2 ? ['welch-t', 'mann-whitney'] : ['anova', 'kruskal-wallis']
}

/**
 * Is this override still usable for the variable it was pinned on?
 *
 * False means IGNORE it, not erase it: the group column may change back, and
 * silently dropping a deliberate choice would lose work the user did.
 */
export function overrideApplies(
  override: TestName | undefined,
  variableType: 'numeric' | 'categorical',
  groupCount: number,
): boolean {
  return !!override && applicableTests(variableType, groupCount).includes(override)
}
