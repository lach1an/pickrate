import pc from 'picocolors';
import type { GateResult } from '../types.js';

/**
 * The gate block, printed below the report it judges.
 *
 * Below, not above: the diagnostics are what you act on, and a build that went
 * red tells you nothing a confusion pair does not tell you better. Passing
 * gates are printed too — a gate you cannot see passing is one you cannot tell
 * from a gate that was never configured.
 */
export function formatGates(results: GateResult[]): string | undefined {
  if (results.length === 0) return undefined;

  const width = Math.max(...results.map((result) => result.id.length));
  const lines = [pc.dim('  gates')];

  for (const result of results) {
    const mark = result.passed
      ? pc.green('✓')
      : result.unmeasured === true
        ? pc.yellow('?')
        : pc.red('✗');
    const paint = result.passed ? pc.dim : result.unmeasured === true ? pc.yellow : pc.red;
    lines.push(`    ${mark} ${result.id.padEnd(width)}  ${paint(result.message)}`);
  }

  // "Could not measure" and "measured, and it is bad" exit differently — say which.
  if (results.some((result) => !result.passed && result.unmeasured === true)) {
    lines.push(
      pc.dim('    Unmeasured: too little of this run completed for the numbers above to mean'),
      pc.dim('    anything. This is not a failing eval — check the target before the surface.'),
    );
  }

  return lines.join('\n');
}
