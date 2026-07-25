import type { SkillDef, SurfaceItem, SurfaceKind, ToolDef } from '../types.js';

/** How many decoys `inject-decoys` adds. Spec §6 names twenty. */
export const DECOY_COUNT = 20;

/**
 * A fixed corpus of plausible-but-irrelevant items.
 *
 * Two properties are deliberate. They are **plausible** — a real auto-generated
 * server or a real skills directory looks like this — because implausible
 * filler would be trivially ignorable and would understate the effect. And they
 * are **unrelated to anything anyone writes scenarios about here**, so a drop
 * after injecting them is context bloat rather than genuine competition for the
 * selection.
 *
 * Checked in and never generated, because a mutation session has to be
 * reproducible and there is no seed available anywhere in this project.
 */
const DECOYS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'list_invoices', description: 'List invoices for a billing account, filtered by status and date range.' },
  { name: 'create_invoice', description: 'Create a draft invoice for a customer with one or more line items.' },
  { name: 'void_invoice', description: 'Void an issued invoice so it no longer counts towards revenue.' },
  { name: 'get_customer', description: 'Fetch a customer record by id, including billing address and contact details.' },
  { name: 'update_customer', description: 'Update the mutable fields of a customer record, such as email or phone.' },
  { name: 'search_customers', description: 'Search customers by name, email domain or account tier.' },
  { name: 'list_subscriptions', description: 'List active and cancelled subscriptions for a customer.' },
  { name: 'cancel_subscription', description: 'Cancel a subscription immediately or at the end of the billing period.' },
  { name: 'record_payment', description: 'Record a payment received against an outstanding invoice.' },
  { name: 'refund_payment', description: 'Issue a full or partial refund against a settled payment.' },
  { name: 'list_tickets', description: 'List support tickets in a queue, optionally filtered by priority.' },
  { name: 'create_ticket', description: 'Open a new support ticket on behalf of a customer.' },
  { name: 'close_ticket', description: 'Close a support ticket and record a resolution reason.' },
  { name: 'assign_ticket', description: 'Assign a support ticket to an agent or to a team queue.' },
  { name: 'send_campaign', description: 'Send a marketing email campaign to a saved audience segment.' },
  { name: 'list_segments', description: 'List saved audience segments and how many contacts each matches.' },
  { name: 'export_report', description: 'Export an analytics report as CSV for a given reporting period.' },
  { name: 'schedule_meeting', description: 'Schedule a meeting on a shared calendar and invite attendees.' },
  { name: 'list_availability', description: 'List free time slots across a set of calendars for a date range.' },
  { name: 'upload_document', description: 'Upload a document to the shared document store and return its id.' },
];

/**
 * `DECOY_COUNT` items of the right kind, none of which collide with a name
 * already in the surface.
 *
 * Collisions are resolved by suffixing rather than skipping, so the count is
 * the count — a mutant that quietly injected eighteen decoys because two names
 * clashed would not be the mutant the report says it is.
 */
export function decoyItems(kind: SurfaceKind, existingNames: Iterable<string>): SurfaceItem[] {
  const taken = new Set(existingNames);
  const items: SurfaceItem[] = [];

  for (const decoy of DECOYS.slice(0, DECOY_COUNT)) {
    let name = decoy.name;
    let suffix = 2;
    while (taken.has(name)) name = `${decoy.name}_${suffix++}`;
    taken.add(name);
    items.push(kind === 'skills' ? decoySkill(name, decoy.description) : decoyTool(name, decoy.description));
  }

  return items;
}

function decoyTool(name: string, description: string): ToolDef {
  const raw = {
    name,
    description,
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Record id.' } } },
  };
  return {
    kind: 'tool',
    name,
    description,
    inputSchema: raw.inputSchema,
    raw,
  };
}

/**
 * A decoy skill.
 *
 * `body` is empty on purpose: bodies are deferred cost and never resident, so
 * giving decoys bodies would inflate `TokenReport.deferred` without changing a
 * single token the model actually sees while choosing. The point of this
 * operator is resident context, and only the routing block is that.
 *
 * `path` is synthetic and relative — it must never become an absolute path,
 * which would vary by machine and could reach a report.
 */
function decoySkill(name: string, description: string): SkillDef {
  const frontmatter = { name, description };
  return {
    kind: 'skill',
    name,
    description,
    path: `<decoy>/${name}/SKILL.md`,
    body: '',
    frontmatter,
    raw: frontmatter,
  };
}
