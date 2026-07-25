/**
 * The exit-code contract. One enum, used everywhere.
 *
 * The 1/2 split is the whole point: **a bad answer and no answer are different
 * facts**. A dead server, a broken config or a run where every trial errored
 * must never read as a failed eval — and a failed eval must never read as
 * green. CI reads the code and nothing else, so a harness that collapses the
 * two turns an outage into a passing build (or a regression into an infra
 * ticket), and nobody reads the log of a green build to find out which.
 */
export const Exit = {
  /** Measured, and every gate passed. */
  Ok: 0,
  /** Measured, and the answer is bad: threshold breach, failOn, regression. */
  Failed: 1,
  /** Could not measure: usage error, unreachable target, too many errored trials. */
  Unmeasured: 2,
  /** Cancelled — the cost confirmation was declined. */
  Cancelled: 130,
} as const;

export type ExitCode = (typeof Exit)[keyof typeof Exit];
