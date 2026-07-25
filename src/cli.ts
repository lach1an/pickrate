#!/usr/bin/env node
import { parseArgs } from 'node:util';
import pc from 'picocolors';
import { analyse } from './analyser/index.js';
import { loadManifest, type ConnectOptions } from './connector/index.js';
import { formatAnalysisJson } from './report/json.js';
import { formatAnalysis } from './report/table.js';
import type { Severity } from './types.js';

const VERSION = '0.0.0';

const USAGE = `
${pc.bold('mcpeval')} — does an agent actually use your MCP server correctly?

${pc.bold('Usage')}
  mcpeval inspect <target> [options]

${pc.bold('Targets')}
  "node ./build/index.js"        stdio server (quote the whole command)
  https://api.example.com/mcp    streamable HTTP server
  ./manifest.json                a captured tools/list response

${pc.bold('Options')}
  --json                  machine-readable output
  --fail-on <severity>    exit 1 when findings at or above this level exist
                          (error | warn | info | none, default: none)
  --disable <ids>         comma-separated rule ids to skip
  --header <k=v>          extra HTTP header (repeatable)
  --env <k=v>             extra env var for stdio servers (repeatable)
  --timeout <ms>          connection budget (default: 30000)
  -h, --help              this
  -v, --version           version

${pc.dim('inspect makes no model calls and needs no API key.')}
`;

const SEVERITY_RANK: Record<Severity, number> = { error: 3, warn: 2, info: 1 };

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      'fail-on': { type: 'string', default: 'none' },
      disable: { type: 'string' },
      header: { type: 'string', multiple: true },
      env: { type: 'string', multiple: true },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const [command, target] = positionals;

  if (values.help || command === undefined || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined && !values.help ? 2 : 0;
  }

  if (command !== 'inspect') {
    process.stderr.write(`Unknown command: ${command}\n${USAGE}\n`);
    return 2;
  }

  if (target === undefined) {
    process.stderr.write(`inspect needs a target.\n${USAGE}\n`);
    return 2;
  }

  const failOn = parseFailOn(values['fail-on']);
  const connectOptions: ConnectOptions = {
    ...(values.header ? { headers: parsePairs(values.header, '--header') } : {}),
    ...(values.env ? { env: parsePairs(values.env, '--env') } : {}),
    ...(values.timeout ? { timeoutMs: Number(values.timeout) } : {}),
  };

  const manifest = await loadManifest(target, connectOptions);
  const analysis = analyse(manifest, {
    ...(values.disable ? { disable: values.disable.split(',').map((id) => id.trim()) } : {}),
  });

  process.stdout.write(
    values.json ? `${formatAnalysisJson(analysis)}\n` : `${formatAnalysis(analysis)}\n`,
  );

  if (failOn === null) return 0;
  const breached = analysis.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]);
  return breached ? 1 : 0;
}

function parseFailOn(value: string | undefined): Severity | null {
  if (value === undefined || value === 'none') return null;
  if (value === 'error' || value === 'warn' || value === 'info') return value;
  throw new Error(`--fail-on must be one of: error, warn, info, none (got "${value}")`);
}

function parsePairs(entries: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const index = entry.indexOf('=');
    if (index <= 0) throw new Error(`${flag} expects key=value (got "${entry}")`);
    out[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return out;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${pc.red('error')} ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
