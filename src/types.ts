/**
 * Internal domain model.
 *
 * Nothing outside `src/connector/` may import from `@modelcontextprotocol/sdk`.
 * The SDK is expected to churn hard through the `2026-07-28` transition; these
 * types are the seam that keeps that churn out of the analyser, runner, scorer
 * and reporter.
 */

/** A JSON Schema 2020-12 document, kept deliberately loose. */
export type JsonSchema = Record<string, unknown>;

/** One tool as advertised by `tools/list`, normalised. */
export interface ToolDef {
  name: string;
  /** Human-facing title, if the server supplies one. */
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  /** Anything the server sent that we do not model explicitly. */
  raw: Record<string, unknown>;
}

/** The full tool surface of a server, plus how we obtained it. */
export interface Manifest {
  tools: ToolDef[];
  source: ManifestSource;
}

export interface ManifestSource {
  /** How the manifest was obtained. */
  kind: 'stdio' | 'http' | 'file';
  /** Command line, URL, or file path — for display in reports. */
  target: string;
  /** Server-reported name/version, when the transport exposes it. */
  serverInfo?: { name: string; version: string };
  /** Protocol version negotiated, when known. */
  protocolVersion?: string;
  fetchedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Analyser                                                                    */
/* -------------------------------------------------------------------------- */

export type Severity = 'error' | 'warn' | 'info';

/** A single lint finding against the manifest. */
export interface Finding {
  /** Stable rule id, e.g. `missing-tool-description`. */
  rule: string;
  severity: Severity;
  /** Tool this finding is anchored to, if any. */
  tool?: string;
  /** Dot-path into the tool's input schema, if any. e.g. `properties.name`. */
  path?: string;
  message: string;
  /** Extra rule-specific detail, surfaced in `--json` only. */
  detail?: Record<string, unknown>;
}

/** Token cost of the manifest, which is what M1 exists to make visible. */
export interface TokenReport {
  /** Tokens for the whole serialised tool array. */
  total: number;
  /** Per-tool cost, descending. */
  perTool: Array<{ name: string; tokens: number; share: number }>;
  /** Which tokeniser produced these numbers — always state it in the report. */
  encoding: string;
  approximate: true;
}

export interface Analysis {
  source: ManifestSource;
  toolCount: number;
  tokens: TokenReport;
  findings: Finding[];
}

/** A static check over the manifest. Rules never make network or model calls. */
export interface Rule {
  id: string;
  /** One line, shown in `mcpeval inspect --explain`. */
  description: string;
  defaultSeverity: Severity;
  run(manifest: Manifest): Finding[];
}
