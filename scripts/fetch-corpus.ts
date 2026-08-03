#!/usr/bin/env node
/**
 * Assemble the live measurement corpus from a real, public skills library.
 *
 * **Not a test.** It clones over the network, so it never runs in `npm test`.
 * Run it by hand before a live `run` or `mutate`:
 *
 *     npx tsx scripts/fetch-corpus.ts
 *
 * Why it exists: the first live mutation session scored 0% against
 * `test/fixtures/git-server.json`, and the reason was the surface, not the
 * harness. Three tools whose names restate their own descriptions leave nothing
 * for a description mutation to damage — `create_branch` answers "make a ref"
 * from the name alone, so blanking its description changed no score. A
 * mutation score is only a measurement if the descriptions were load-bearing
 * to begin with.
 *
 * `google/skills` is load-bearing by construction. The names are product
 * brands rather than job descriptions — nothing about `spanner` says "global
 * transactional consistency" — and the descriptions carry explicit negative
 * routing ("Do NOT use for general PostgreSQL instances (e.g. Cloud SQL)",
 * "use the datalineage-bigquery-asset-impact-analysis skill instead"). That
 * negative routing is exactly what `blank-description` and `swap-descriptions`
 * destroy, which makes a survivor mean something.
 *
 * It is fetched rather than vendored: nothing third-party enters the repo, so
 * there is no licence question, and `corpus/` is gitignored. What *is* checked
 * in is this file — the SHA and the allowlist below are the reproducibility
 * guarantee, and both are reviewable as a diff.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/google/skills.git';

/** Pinned: a corpus that drifts makes every number recorded against it unattributable. */
const COMMIT = '8229c1e1ab1b8bd9bd4334e6953ae6bb81bbf2db';

/**
 * The selection, as `<category>/<skill>` paths in the upstream tree.
 *
 * Flat and curated for two reasons. `loadSkills` walks one level only, and
 * upstream nests a level deeper than that. And ~15 items is where competition
 * for a selection is real without a mutation session costing more than the
 * finding is worth.
 *
 * Chosen as four overlapping clusters, because a near-miss is the only kind of
 * scenario a mutation can move:
 *
 *   - relational/NoSQL provisioning — alloydb, cloud-sql, spanner, bigtable
 *   - the BigQuery family — basics vs AI/ML vs the Python dataframe API
 *   - lineage — summary vs blast-radius impact analysis, which cite each other
 *   - querying and observability — LQL vs SQL, metric discovery vs charting
 *
 * `gcloud` is in deliberately as the greedy generalist: it claims "any gcloud
 * CLI commands or GCP resources", so it competes with every provisioning
 * scenario here. Real surfaces have one of these and it is where over-eager
 * selection actually comes from.
 */
const SKILLS = [
  'cloud/alloydb-basics',
  'cloud/bigquery-ai-ml',
  'cloud/bigquery-basics',
  'cloud/bigquery-bigframes',
  'cloud/bigtable-basics',
  'cloud/cloud-logging-query-generation',
  'cloud/cloud-monitoring-chart-generation',
  'cloud/cloud-monitoring-metric-selection',
  'cloud/cloud-sql-basics',
  'cloud/datalineage-bigquery-asset-impact-analysis',
  'cloud/datalineage-summary',
  'cloud/gcloud',
  'cloud/google-cloud-storage-basics',
  'cloud/google-cloud-waf-cost-optimization',
  'cloud/spanner-basics',
];

const root = fileURLToPath(new URL('..', import.meta.url));
const checkout = join(root, 'corpus', '.checkout');
const dest = join(root, 'corpus', 'gcp-data');

rmSync(checkout, { recursive: true, force: true });
rmSync(dest, { recursive: true, force: true });
mkdirSync(checkout, { recursive: true });

// Blobless and sparse: the interesting part is ~15 files out of a repo of ~100
// skills with their reference material.
const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { stdio: 'inherit' });

git('init', '--quiet');
git('remote', 'add', 'origin', REPO);
git('fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', COMMIT);
git('sparse-checkout', 'set', '--no-cone', ...SKILLS.map((skill) => `skills/${skill}/SKILL.md`));
git('checkout', '--quiet', COMMIT);

for (const skill of SKILLS) {
  const name = skill.slice(skill.lastIndexOf('/') + 1);
  mkdirSync(join(dest, name), { recursive: true });
  // Only `SKILL.md`. pickrate reads the frontmatter and the body and nothing
  // else — `references/` and `scripts/` are neither resident nor deferred cost —
  // so copying them would grow the corpus without changing a measured token.
  copyFileSync(join(checkout, 'skills', skill, 'SKILL.md'), join(dest, name, 'SKILL.md'));
}

rmSync(checkout, { recursive: true, force: true });
process.stdout.write(`${SKILLS.length} skills -> corpus/gcp-data (google/skills @ ${COMMIT.slice(0, 12)})\n`);
