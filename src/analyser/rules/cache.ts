import type { Finding, Rule, Surface } from '../../types.js';

/**
 * Cache-stability checks.
 *
 * `2026-07-28` makes list results explicitly cacheable — `ttlMs`, `cacheScope`
 * and deterministic ordering (SEP-2549) — so what used to be an unstated
 * assumption is now a declared property, and a declared property is a
 * checkable one.
 *
 * These stay pure like every other rule: the *observation* is made by the
 * adapter at load time and recorded on `SurfaceSource`, and the rule only
 * judges it.
 */

/** The revision that introduced cacheable list results. */
export const CACHEABLE_LISTS_FROM = '2026-07-28';

/**
 * A TTL below this is not worth having: the catalogue is re-fetched on
 * essentially every session anyway, and the prompt cache behind it churns with
 * it. Chosen as "shorter than a working session", not measured.
 */
export const MIN_USEFUL_TTL_MS = 60_000;

/**
 * Does this server speak a revision where the cache keys exist?
 *
 * Dates sort lexically in ISO form, which is the whole reason the protocol
 * numbers its revisions this way. `server/discover` is authoritative when the
 * server answered it; the negotiated version is the fallback.
 *
 * Servers predating the revision are **skipped, not passed**. Every server in
 * the M5 corpus is one of those today, and a lint that fires on all of them is
 * a lint everybody turns off.
 */
export function speaksCacheableLists(surface: Surface): boolean {
  const { discoveredVersions, protocolVersion } = surface.source;
  if (discoveredVersions) return discoveredVersions.some((v) => v >= CACHEABLE_LISTS_FROM);
  return protocolVersion !== undefined && protocolVersion >= CACHEABLE_LISTS_FROM;
}

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
    //
    // Deliberately *not* gated on the protocol revision, unlike the rules
    // below: ordering is measured directly rather than read off a declaration,
    // and a legacy server that reorders costs exactly as much as a new one.
    if (surface.source.listOrderStable !== false) return [];

    return [
      {
        rule: 'unstable-list-order',
        severity: 'warn',
        message:
          `This server returned its ${surface.items.length} tools in a different order on two consecutive calls. ` +
          'The manifest sits in front of every prompt, so a changed order invalidates the cached prefix behind it — ' +
          'on every reconnect, with no error and no warning, at roughly 10× the token cost you were expecting.',
        detail: { itemCount: surface.items.length },
      },
    ];
  },
};

export const missingCacheTtl: Rule = {
  id: 'missing-cache-ttl',
  description: `\`tools/list\` declares no usable \`ttlMs\`, so clients re-fetch the catalogue instead of caching it.`,
  defaultSeverity: 'warn',
  appliesTo: ['mcp'],
  run(surface) {
    if (!speaksCacheableLists(surface)) return [];

    const ttlMs = surface.source.listCache?.ttlMs;
    if (ttlMs === undefined) {
      return [
        {
          rule: 'missing-cache-ttl',
          severity: 'warn',
          message:
            'This server declares no `ttlMs` on `tools/list`, so a conservative client re-fetches the whole ' +
            'catalogue on every reconnect — paying for it in tokens and invalidating the prompt cache behind it.',
        },
      ];
    }

    if (ttlMs < MIN_USEFUL_TTL_MS) {
      return [
        {
          rule: 'missing-cache-ttl',
          severity: 'warn',
          message:
            `This server's \`ttlMs\` is ${ttlMs}ms, which expires inside a single session. ` +
            'A TTL that short buys none of the caching it declares.',
          detail: { ttlMs, minimum: MIN_USEFUL_TTL_MS },
        },
      ];
    }

    return [];
  },
};

export const missingCacheScope: Rule = {
  id: 'missing-cache-scope',
  description: '`tools/list` declares no `cacheScope`, which conservative clients read as "do not cache".',
  // Lower than the TTL rule: an undeclared scope costs caching, while a wrong
  // one (below) leaks. Same field, two very different failures.
  defaultSeverity: 'info',
  appliesTo: ['mcp'],
  run(surface) {
    if (!speaksCacheableLists(surface)) return [];
    if (surface.source.listCache?.cacheScope !== undefined) return [];

    return [
      {
        rule: 'missing-cache-scope',
        severity: 'info',
        message:
          'This server declares no `cacheScope` on `tools/list`. A client that cannot tell whether a catalogue ' +
          'is shared or per-caller has to assume the worst and skip the cache.',
      },
    ];
  },
};

export const publicCacheScope: Rule = {
  id: 'public-cache-scope',
  description: 'A credentialed catalogue declared `cacheScope: public` may be served to another tenant.',
  defaultSeverity: 'error',
  appliesTo: ['mcp'],
  run(surface) {
    if (!speaksCacheableLists(surface)) return [];
    if (surface.source.listCache?.cacheScope !== 'public') return [];

    // The catalogue was fetched with credentials, so it may well differ per
    // caller — and `public` invites a shared intermediary to hand one caller's
    // tools to the next. Without credentials there is no tenant to confuse,
    // and `public` is the correct declaration rather than a finding.
    if (surface.source.credentialed !== true) return [];

    const findings: Finding[] = [
      {
        rule: 'public-cache-scope',
        severity: 'error',
        message:
          'This catalogue was fetched with credentials and declares `cacheScope: public`. If it varies by ' +
          'caller, a shared cache may serve one tenant’s tools to another. Declare `private` unless every ' +
          'caller genuinely sees this same list.',
        detail: { cacheScope: 'public', credentialed: true },
      },
    ];
    return findings;
  },
};

export const legacyProtocol: Rule = {
  id: 'legacy-protocol',
  description: `This server predates ${CACHEABLE_LISTS_FROM}, so the cache-metadata checks were skipped rather than passed.`,
  defaultSeverity: 'info',
  appliesTo: ['mcp'],
  run(surface) {
    if (speaksCacheableLists(surface)) return [];

    // Only when we know. A capture that records no revision never negotiated
    // one, and calling it legacy would put a claim in the report that nothing
    // measured — the same absent-is-not-false discipline as `listOrderStable`.
    const version = surface.source.protocolVersion;
    if (version === undefined) return [];

    return [
      {
        rule: 'legacy-protocol',
        severity: 'info',
        message:
          `This server speaks ${version}, which predates ${CACHEABLE_LISTS_FROM}. ` +
          'Its cache declarations were not checked — they do not exist in that revision, so their absence is not a defect.',
        detail: { protocolVersion: version },
      },
    ];
  },
};
