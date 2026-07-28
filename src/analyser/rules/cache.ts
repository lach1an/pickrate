import type { Finding, Rule } from '../../types.js';

/**
 * Cache-stability checks.
 *
 * `2026-07-28` makes list results explicitly cacheable — `ttlMs`, `cacheScope`
 * and deterministic ordering (SEP-2549) — so what used to be an unstated
 * assumption is now a declared property, and a declared property is a
 * checkable one. Ordering is the first of these; `ttlMs` and `cacheScope` are
 * the same theme and belong in this file when they land.
 *
 * These stay pure like every other rule: the *observation* is made by the
 * adapter at load time and recorded on `SurfaceSource`, and the rule only
 * judges it.
 */

export const unstableListOrder: Rule = {
  id: 'unstable-list-order',
  description:
    'Two consecutive `tools/list` calls returned the same tools in a different order, which breaks the prompt cache behind them.',
  // A cost failure rather than a correctness one — the manifest is fine and the
  // model still selects correctly. It is a warning that happens to be expensive.
  defaultSeverity: 'warn',
  // Skills are read from a directory walk, which is ordered by construction.
  appliesTo: ['mcp'],
  run(surface) {
    // Absent means nobody checked — a file fixture, or a re-list that failed.
    // Reporting that as a pass would claim a measurement that never happened.
    if (surface.source.listOrderStable !== false) return [];

    const findings: Finding[] = [];
    findings.push({
      rule: 'unstable-list-order',
      severity: 'warn',
      message:
        `This server returned its ${surface.items.length} tools in a different order on two consecutive calls. ` +
        'The manifest sits in front of every prompt, so a changed order invalidates the cached prefix behind it — ' +
        'on every reconnect, with no error and no warning, at roughly 10× the token cost you were expecting.',
      detail: { itemCount: surface.items.length },
    });
    return findings;
  },
};
