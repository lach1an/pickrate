import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadManifestFromFile, readListCache } from '../src/adapters/mcp/index.js';
import {
  legacyProtocol,
  missingCacheScope,
  missingCacheTtl,
  publicCacheScope,
  speaksCacheableLists,
} from '../src/analyser/rules/cache.js';
import { rules } from '../src/analyser/rules/index.js';
import type { Surface, SurfaceSource, ToolDef } from '../src/types.js';

/** A surface from a server that speaks the revision, unless told otherwise. */
function surfaceOf(source: Partial<SurfaceSource> = {}): Surface {
  const tool: ToolDef = {
    kind: 'tool',
    name: 'create_branch',
    description: 'Create a branch.',
    inputSchema: { type: 'object' },
    raw: {},
  };
  return {
    kind: 'mcp',
    items: [tool],
    source: {
      kind: 'http',
      adapter: 'mcp',
      target: 'https://example.test/mcp',
      protocolVersion: '2026-07-28',
      fetchedAt: '2026-07-28T00:00:00.000Z',
      ...source,
    },
  };
}

describe('reading cache metadata off a listing', () => {
  it('takes both keys when they are there', () => {
    assert.deepEqual(readListCache({ ttlMs: 300_000, cacheScope: 'private', tools: [] }), {
      ttlMs: 300_000,
      cacheScope: 'private',
    });
  });

  it('is absent when the server said nothing', () => {
    assert.equal(readListCache({ tools: [] }), undefined);
  });

  it('treats a value of the wrong type as absent', () => {
    // "declared something unusable" and "declared nothing" are the same
    // finding, and a string TTL must not reach a numeric comparison.
    assert.equal(readListCache({ ttlMs: '5 minutes', cacheScope: 42 }), undefined);
  });

  it('survives the offline fixture path', async () => {
    const surface = await loadManifestFromFile('test/fixtures/cacheable-server.json');
    assert.deepEqual(surface.source.listCache, { ttlMs: 1000, cacheScope: 'public' });
  });

  it('carries the capture\'s own protocol and credential flags', async () => {
    // Without these a capture can never exercise a protocol-gated rule, which
    // would leave the cache lints with no offline coverage at all — and there
    // is no SDK to get a live 2026-07-28 server with.
    const surface = await loadManifestFromFile('test/fixtures/cacheable-server.json');
    assert.equal(surface.source.protocolVersion, '2026-07-28');
    assert.equal(surface.source.credentialed, true);
  });

  it('leaves both absent on a capture that claims neither', async () => {
    const surface = await loadManifestFromFile('test/fixtures/git-server.json');
    assert.equal(surface.source.protocolVersion, undefined);
    assert.equal(surface.source.credentialed, undefined);
  });
});

describe('the cache lints end to end', () => {
  it('finds the metadata defects and nothing else', async () => {
    const surface = await loadManifestFromFile('test/fixtures/cacheable-server.json');
    const findings = rules.flatMap((rule) => (rule.appliesTo.includes('mcp') ? rule.run(surface) : []));

    // The tools in that fixture are clean by construction, so every finding
    // must have come from the cache keys.
    assert.deepEqual(
      findings.map((f) => f.rule).sort(),
      ['missing-cache-ttl', 'public-cache-scope'],
    );
  });

  it('adds nothing to the clean legacy capture', async () => {
    // That fixture is clean of warnings, not of findings — it carries one
    // `info`. What matters here is that none of the new rules contributed.
    const surface = await loadManifestFromFile('test/fixtures/git-server.json');
    const findings = rules.flatMap((rule) => (rule.appliesTo.includes('mcp') ? rule.run(surface) : []));

    assert.deepEqual(findings.filter((f) => f.severity !== 'info'), []);
    assert.deepEqual(
      findings.filter((f) => f.rule.includes('cache') || f.rule === 'legacy-protocol'),
      [],
    );
  });
});

describe('which servers the cache rules apply to', () => {
  it('applies to a server that speaks the revision', () => {
    assert.equal(speaksCacheableLists(surfaceOf()), true);
  });

  it('skips a legacy server', () => {
    assert.equal(speaksCacheableLists(surfaceOf({ protocolVersion: '2025-11-25' })), false);
  });

  it('prefers what server/discover advertised', () => {
    const surface = surfaceOf({ protocolVersion: '2025-11-25', discoveredVersions: ['2026-07-28', '2025-11-25'] });
    assert.equal(speaksCacheableLists(surface), true);
  });

  it('stays quiet on every legacy server rather than firing on all of them', () => {
    // The whole M5 corpus is legacy today. A lint that fires on all of it is a
    // lint everybody turns off, so absence of the keys is not a defect there.
    const legacy = surfaceOf({ protocolVersion: '2025-11-25' });
    assert.deepEqual(missingCacheTtl.run(legacy), []);
    assert.deepEqual(missingCacheScope.run(legacy), []);
    assert.deepEqual(publicCacheScope.run(legacy), []);
  });

  it('says so, rather than being silently silent', () => {
    // Skipped and clean must not look the same in a report.
    const findings = legacyProtocol.run(surfaceOf({ protocolVersion: '2025-11-25' }));
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.message, /2025-11-25/);
    assert.match(findings[0]!.message, /not checked/);
  });

  it('does not call a captured fixture legacy', async () => {
    // A capture never negotiated anything. Guessing from silence would put a
    // protocol claim in the report that nothing measured.
    const surface = await loadManifestFromFile('test/fixtures/git-server.json');
    assert.deepEqual(legacyProtocol.run(surface), []);
  });
});

describe('the TTL rule', () => {
  it('fires when nothing was declared', () => {
    const findings = missingCacheTtl.run(surfaceOf({ listCache: { cacheScope: 'private' } }));
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.message, /no `ttlMs`/);
  });

  it('fires on a TTL too short to survive a session', () => {
    const findings = missingCacheTtl.run(surfaceOf({ listCache: { ttlMs: 1000 } }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.detail?.['ttlMs'], 1000);
  });

  it('is quiet on a usable TTL', () => {
    assert.deepEqual(missingCacheTtl.run(surfaceOf({ listCache: { ttlMs: 300_000 } })), []);
  });
});

describe('the scope rules', () => {
  it('flags an undeclared scope as information, not a failure', () => {
    const findings = missingCacheScope.run(surfaceOf({ listCache: { ttlMs: 300_000 } }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, 'info');
  });

  it('treats a credentialed public catalogue as an error', () => {
    const findings = publicCacheScope.run(
      surfaceOf({ listCache: { cacheScope: 'public' }, credentialed: true }),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, 'error');
    assert.match(findings[0]!.message, /tenant/);
  });

  it('leaves an uncredentialed public catalogue alone', () => {
    // No credentials means no tenant to confuse, and `public` is then the
    // correct declaration rather than a finding.
    assert.deepEqual(publicCacheScope.run(surfaceOf({ listCache: { cacheScope: 'public' } })), []);
  });

  it('never carries the credential itself into a finding', () => {
    // Invariant 10: no report field, in any format, carries a credential.
    const findings = publicCacheScope.run(
      surfaceOf({ listCache: { cacheScope: 'public' }, credentialed: true }),
    );
    assert.equal(findings[0]!.detail?.['credentialed'], true);
    assert.equal(JSON.stringify(findings).includes('Bearer'), false);
  });

  it('is quiet on a private catalogue', () => {
    assert.deepEqual(
      publicCacheScope.run(surfaceOf({ listCache: { cacheScope: 'private' }, credentialed: true })),
      [],
    );
  });
});
