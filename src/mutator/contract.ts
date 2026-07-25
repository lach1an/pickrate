import type { Surface, SurfaceKind } from '../types.js';

/**
 * What a mutation operator is, with no operator imported.
 *
 * Kept apart from `operators/index.ts` for the same reason
 * `src/adapters/contract.ts` is kept apart from its registry: the registry
 * imports every operator and every operator needs these declarations, so one
 * module is a cycle that type-checks and then throws at runtime.
 */

/**
 * One specific, known defect, ready to be applied to a surface.
 *
 * The point of the whole milestone is that the ground truth is *constructed*
 * rather than judged: we know exactly what was broken, so "the score did not
 * move" is a statement about the harness rather than about the server.
 */
export interface Mutant {
  /** Stable and deterministic, e.g. `blank-description:create_branch`. */
  id: string;
  /** The operator that produced this. */
  operator: string;
  /** Names of the items this damages. Reported, so a survivor is diagnosable. */
  targets: string[];
  /** One line for the report: what was broken, in English. */
  describe: string;
  /**
   * Damage the surface.
   *
   * Pure: returns a new surface and never touches the one it was given. The
   * baseline is re-used across every mutant in a session, so an operator that
   * mutated in place would poison every measurement after it — and the symptom
   * would be a mutation score, which is exactly the number nobody can sanity
   * check by eye.
   */
  apply(surface: Surface): Surface;
}

/**
 * A family of defects that can be injected into a surface.
 *
 * `enumerate` is total and deterministic: it returns *every* mutant this
 * operator could produce, in surface order. Choosing how many to actually run
 * is the planner's job, which is what makes a mutation session reproducible
 * without a seed — and no seed is available anywhere in this project.
 */
export interface Operator {
  id: string;
  /** One line, shown in the report and in `mutate --help`. */
  description: string;
  /**
   * Surfaces this operator can say anything about.
   *
   * Mirrors `Rule.appliesTo`, and for the same reason: an operator that cannot
   * damage a surface is *skipped*, not run to produce zero mutants. "Nothing
   * to inject here" and "injected nothing" are different statements, and only
   * one of them should count against a mutation score.
   */
  appliesTo: SurfaceKind[];
  enumerate(surface: Surface): Mutant[];
}
