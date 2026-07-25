import { skillsOf } from '../../surface.js';
import type { SkillDef, Surface, ToolCall } from '../../types.js';
import type { Presentation, PresentOptions, ToolDeclaration } from '../contract.js';

/**
 * How a skill surface is put in front of the model.
 *
 * This choice decides what the numbers mean, so it is named in the report
 * rather than buried:
 *
 *  - `skill-tool` — one dispatch tool plus a listing in the system prompt.
 *    This is how an agent actually surfaces skills, and measuring the real
 *    mechanism is the point of the exercise. The default.
 *  - `pseudo-tool` — one synthetic tool per skill. Not the mechanism under
 *    test, and a *more* favourable surface than reality: every skill gets its
 *    own description slot. Its value is as a control — running a skill set
 *    both ways separates how much of the trigger rate is the dispatch
 *    mechanism from how much is the descriptions.
 *
 * Numbers from the two modes are not comparable to each other as scores. They
 * are comparable as a difference, which is the interesting part.
 */
export type SkillsMode = 'skill-tool' | 'pseudo-tool';

export const DEFAULT_SKILLS_MODE: SkillsMode = 'skill-tool';

/** The dispatch tool's name in `skill-tool` mode. */
export const SKILL_TOOL = 'Skill';

/**
 * Deliberately flat. Anything here that helps the model choose *which* skill is
 * a thumb on the scale — the descriptions under test are supposed to do that
 * work, and this text would be doing it for them.
 */
const SKILL_TOOL_DESCRIPTION =
  'Invoke a skill by name. The named skill\'s instructions are loaded into context.';

export function presentSkills(surface: Surface, options: PresentOptions = {}): Presentation {
  const mode = parseMode(options.mode);
  const skills = offerable(surface);

  if (skills.length === 0) {
    throw new Error(
      'No skill in this surface can be offered to a model — every one of them failed to parse. Run `pickrate inspect` on it.',
    );
  }

  return mode === 'pseudo-tool' ? pseudoTool(skills) : skillTool(skills);
}

/* -------------------------------------------------------------------------- */

/**
 * One dispatch tool, plus the routing listing in the system prompt.
 *
 * The listing sits inside the cached prefix, so it is assembled by iterating
 * the surface in order — the loader sorts, nothing here re-sorts, and no path,
 * timestamp or `Set` gets near it. A listing that varied between trials would
 * make every trial a cache miss, and the only visible symptom would be a bill
 * around ten times the estimate.
 */
function skillTool(skills: SkillDef[]): Presentation {
  const tool: ToolDeclaration = {
    name: SKILL_TOOL,
    description: SKILL_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', enum: skills.map((skill) => skill.name) },
      },
      required: ['skill'],
    },
  };

  const listing = skills.map((skill) => `- ${skill.name}: ${oneLine(skill.description)}`).join('\n');

  return {
    tools: [tool],
    mode: 'skill-tool',
    systemSuffix: `\n\nAvailable skills:\n${listing}`,
    project: projectDispatch,
  };
}

/**
 * The control arm: every skill becomes a tool of its own name.
 *
 * `project` is the identity here, which is the whole reason this mode is cheap
 * to support — it is the MCP shape wearing a different hat.
 */
function pseudoTool(skills: SkillDef[]): Presentation {
  for (const skill of skills) {
    // Caught here rather than as an opaque 400 partway through a paid run.
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(skill.name)) {
      throw new Error(
        `pseudo-tool mode needs skill names usable as tool names, and "${skill.name}" is not one (letters, digits, _ and -, up to 64). Use the default skill-tool mode.`,
      );
    }
  }

  return {
    mode: 'pseudo-tool',
    tools: skills.map((skill) => ({
      name: skill.name,
      ...(skill.description !== undefined ? { description: oneLine(skill.description) } : {}),
      inputSchema: { type: 'object', properties: {} },
    })),
    project: (calls) => calls,
  };
}

/**
 * `Skill(skill: "x")` → a selection of `x`.
 *
 * Total, on purpose. A dispatch call naming no skill passes through as
 * `Skill`, which scores as a wrong selection and shows up in the confusion
 * table under that name. Dropping it instead would leave an empty call list,
 * which the scorer reads as restraint — turning a malformed call into a pass.
 */
const projectDispatch = (calls: ToolCall[]): ToolCall[] =>
  calls.map((call) => {
    if (call.name !== SKILL_TOOL) return call;
    const { skill, ...rest } = call.args;
    if (typeof skill !== 'string' || skill.trim() === '') return call;
    return { name: skill, args: rest };
  });

/**
 * The skills a model could actually be offered.
 *
 * Unparseable skills are left out because a real loader rejects them too —
 * presenting one would measure a skill that does not exist in practice. They
 * are already reported by `unparseable-skill`, and they will show up as
 * orphans, which is accurate: nothing ever selects them.
 */
function offerable(surface: Surface): SkillDef[] {
  return skillsOf(surface).filter((skill) => skill.error === undefined);
}

/** Descriptions are free text and may wrap; the listing is one line per skill. */
function oneLine(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function parseMode(mode: string | undefined): SkillsMode {
  if (mode === undefined) return DEFAULT_SKILLS_MODE;
  if (mode === 'skill-tool' || mode === 'pseudo-tool') return mode;
  throw new Error(`Unknown skills presentation "${mode}". Expected skill-tool or pseudo-tool.`);
}
