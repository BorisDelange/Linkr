/**
 * The vocabulary of a control chart, shared by the aggregation, the limit
 * formulas and the runs rules.
 *
 * One distinction drives everything here and is worth stating once: the sigma of
 * a control chart comes from a DISTRIBUTIONAL MODEL of what is being counted,
 * not from the scatter of the plotted points. A proportion is binomial, a rate
 * per exposure-time is Poisson, a measurement is Gaussian, an interval between
 * rare events is geometric. Pick the wrong model and the limits are wrong in a
 * way no amount of plotting fixes — so `StatisticType` is the first thing the
 * user chooses, and every formula downstream reads it rather than guessing.
 */

/** What kind of number is being charted — this selects the variance model. */
export type StatisticType =
  /** Events over cases: binomial, variance p(1-p)/n. */
  | 'proportion'
  /** Events over exposure time: Poisson, variance λ/n. */
  | 'rate'
  /** A measured quantity aggregated per period: Gaussian, variance σ²/n. */
  | 'measurement'
  /** Time (or cases) between rare events: geometric/exponential. */
  | 'rare-event'

export type ChartType =
  | 'p'
  | 'p-prime'
  | 'np'
  | 'u'
  | 'u-prime'
  | 'c'
  | 'i-mr'
  | 'ewma'
  | 'g'
  | 't'

/** Calendar bucket the rows are aggregated into. */
export type Period = 'day' | 'week' | 'month' | 'quarter' | 'year'

/**
 * How the denominator of a rate is built. The four modes are not
 * interchangeable, and the last two are the ones people get wrong:
 *
 * - `cases` — one unit per row (after de-duplication). The binomial denominator.
 * - `exposure-column` — sum of a per-stay duration already present as a column.
 * - `patient-days` — patient-days by CLIPPING each stay to the period window, so
 *   a 90-day stay contributes to three consecutive months. This is the NHSN
 *   definition; summing a per-stay length into the admission month instead is a
 *   different and wrong number for long stays.
 * - `device-days` — the same overlap computation on device insertion/removal
 *   rather than admission/discharge. The correct denominator for CLABSI and VAP,
 *   where the population at risk is "patients with a line in place".
 */
export type DenominatorMode = 'cases' | 'exposure-column' | 'patient-days' | 'device-days'

/** Which runs rules flag non-random patterns that stay inside the limits. */
export type RunsRuleSet =
  /** Thresholds that scale with series length (Anhøj 2015). The default. */
  | 'anhoj'
  /** A fixed run length, as the hand-written scripts used. */
  | 'fixed'
  | 'none'

/** One aggregated period: the numerator, its denominator, and the bucket start. */
export interface PeriodPoint {
  /** Start of the calendar bucket, as an ISO date (YYYY-MM-DD). */
  date: string
  /** Numerator: event count, or the aggregated measurement. */
  y: number
  /**
   * Denominator: cases, exposure-days, or the observation count behind an
   * aggregated measurement. Never 0 — periods with an empty denominator are
   * dropped during aggregation, since their statistic is undefined rather than
   * zero.
   */
  n: number
  /** Within-period variance of a measurement, when one can be computed. */
  variance?: number
  /** Sum of expected values, for risk-adjusted charts. */
  expected?: number
}

/** Why a point is flagged. A point can carry several reasons at once. */
export type SignalKind =
  /** Outside a control limit. */
  | 'beyond-limits'
  /** In a run of consecutive points on one side of the centre line. */
  | 'shift'
  /** In a monotone run. */
  | 'trend'
  /** The series crosses the centre line fewer times than chance would predict. */
  | 'few-crossings'

/** One plotted point, with its own limits — they vary with the denominator. */
export interface ChartPoint {
  date: string
  /** The statistic actually plotted (a proportion, a rate, a mean, an interval). */
  value: number
  /** The numerator and denominator behind `value`, for the tooltip. */
  numerator: number
  denominator: number
  centre: number
  /** Upper limit. `null` when the chart defines none (a g-chart's is rarely useful). */
  ucl: number | null
  /** Lower limit, already clamped to the statistic's floor where one exists. */
  lcl: number | null
  /** Empty when the point is in control. */
  signals: SignalKind[]
  /** True while the point belongs to the baseline the limits were fitted on. */
  baseline: boolean
}

export interface SpcResult {
  chartType: ChartType
  points: ChartPoint[]
  /** The fitted centre line. Constant across points even when the limits vary. */
  centre: number
  /**
   * Laney's dispersion factor, when a prime chart was computed. 1 means the data
   * are exactly as dispersed as the binomial/Poisson model predicts; above 1
   * means overdispersion, and the limits were widened by this factor.
   */
  sigmaZ?: number
  /** Number of periods the limits were fitted on (Phase I). */
  baselineCount: number
  /**
   * Warnings that do not prevent a chart but change how it should be read —
   * too few points, a rate charted on very few events, an option with no effect.
   * Localised by the caller from `SpcWarning.code`.
   */
  warnings: SpcWarning[]
  /** The unit of the y axis, when the chart implies one (e.g. per 1000 days). */
  yUnit?: string
}

export interface SpcWarning {
  code:
    /** Fewer periods than the chart needs to be meaningful. */
    | 'too-few-periods'
    /** A rate/proportion chart on so few events that a g-chart would be better. */
    | 'rare-events-prefer-g'
    /** Overdispersion detected: a prime chart would fit better than p/u. */
    | 'overdispersion-prefer-prime'
    /** The baseline holds too few periods to fit limits on. */
    | 'baseline-too-short'
    /** A configured option has no effect for the chosen statistic type. */
    | 'option-ignored'
  /** Free-form detail (a column name, a count) for the message. */
  detail?: string
}
