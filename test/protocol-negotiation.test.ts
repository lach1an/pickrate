import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { loadManifest } from '../src/adapters/mcp/index.js';
import { rules } from '../src/analyser/rules/index.js';
import type { Surface } from '../src/types.js';

/**
 * The protocol seam, against a real subprocess.
 *
 * Everything else about MCP loading is tested from file fixtures, which is what
 * keeps the suite offline and fast. These cases cannot be: what is under test is
 * the negotiation itself — which revision the connection lands on, and whether a
 * second `tools/list` reaches the wire at all. A fixture has no connection to
 * negotiate and no round trip to skip, so it can only agree with itself.
 *
 * There is still no network and no model spend here: the "server" is a local
 * script on a pipe.
 */

const SERVER = fileURLToPath(new URL('./helpers/fake-mcp-server.mjs', import.meta.url));
const target = `node ${SERVER}`;

// Generous, because `mode: 'auto'` spawns twice on stdio (a sibling for the
// probe, then the session child) and CI machines are slow at spawning.
const load = (env: Record<string, string>) => loadManifest(target, { env, timeoutMs: 20_000 });

/** The same narrowing `inspect` does — a rule that cannot speak to MCP is skipped, not run empty. */
const ruleIds = (surface: Surface) =>
  rules.flatMap((rule) => (rule.appliesTo.includes('mcp') ? rule.run(surface) : [])).map((f) => f.rule);

describe('protocol negotiation', () => {
  it('reads the discovered revisions off `supportedVersions`', async () => {
    const surface = await load({ FAKE_MCP_VERSIONS: '2026-07-28 2025-11-25' });

    // The field name is the whole point. The hand-rolled probe this replaced
    // read `protocolVersions`, which no server has ever sent, so it reported
    // nothing for its entire life and did so silently — every failure path was
    // a deliberate `undefined`. Nothing downstream could tell that apart from a
    // legacy server, which is exactly why it needs a test that would notice.
    assert.deepEqual(surface.source.discoveredVersions, ['2026-07-28', '2025-11-25']);
    assert.equal(surface.source.protocolVersion, '2026-07-28');
    assert.deepEqual(surface.items.map((item) => item.name), ['alpha', 'beta']);
  });

  it('falls back to the 2025 handshake when the probe finds nothing', async () => {
    const surface = await load({});

    // A legacy server answers `server/discover` with METHOD_NOT_FOUND. Absent
    // is not `false` here: we learned nothing, rather than learning the server
    // supports no versions.
    assert.equal(surface.source.discoveredVersions, undefined);
    assert.equal(surface.source.protocolVersion, '2025-11-25');
    assert.deepEqual(surface.items.map((item) => item.name), ['alpha', 'beta']);
  });

  it('lets the cache rules run against a server that actually speaks the revision', async () => {
    const surface = await load({
      FAKE_MCP_VERSIONS: '2026-07-28',
      FAKE_MCP_TTL_MS: '1000',
      FAKE_MCP_SCOPE: 'public',
    });

    assert.deepEqual(surface.source.listCache, { ttlMs: 1000, cacheScope: 'public' });

    // `ResultSchema` is a loose object in the v2 SDK exactly as it was in v1,
    // so the SEP-2549 keys still survive parsing and reach the rules.
    const ids = ruleIds(surface);
    assert.ok(ids.includes('missing-cache-ttl'), `expected a ttl finding, got ${ids.join(', ')}`);
    assert.ok(!ids.includes('legacy-protocol'), 'a 2026-07-28 server is not legacy');
  });

  it('says the cache checks were skipped on a legacy server rather than passed', async () => {
    const ids = ruleIds(await load({}));

    assert.ok(ids.includes('legacy-protocol'), `expected legacy-protocol, got ${ids.join(', ')}`);
    assert.ok(!ids.some((id) => id.includes('cache-ttl') || id.includes('cache-scope')));
  });
});

describe('the ordering probe', () => {
  it('reaches the wire twice even when the server sends a cache hint', async () => {
    // The regression this exists for: the v2 client caches the list verbs and
    // serves a fresh entry *without a round trip* by default, so the second
    // listing would be answered from memory, compare equal to the first, and
    // report an order nobody measured. It only misfires when the server sends
    // `ttlMs` — which is to say on 2026-07-28 servers, the only ones SEP-2549's
    // ordering guarantee binds and precisely the ones this is meant to police.
    // Drop `cacheMode: 'bypass'` from the adapter and this assertion flips.
    // The fake's default hint is an hour, so the cached entry is unambiguously
    // still fresh when the second listing goes out. If that call were served
    // from the cache it could not see the reordering, and would report `true`.
    const surface = await load({ FAKE_MCP_VERSIONS: '2026-07-28', FAKE_MCP_REORDER: '1' });

    assert.equal(surface.source.listOrderStable, false);

    const ids = ruleIds(surface);
    assert.ok(ids.includes('unstable-list-order'), `expected the ordering finding, got ${ids.join(', ')}`);
  });

  it('reports a stable order as stable', async () => {
    const surface = await load({ FAKE_MCP_VERSIONS: '2026-07-28' });

    assert.equal(surface.source.listOrderStable, true);
  });
});
