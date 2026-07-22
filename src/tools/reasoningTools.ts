import type { ToolDefinition } from '../types';
import { schema } from '../core/toolRegistry';
import type { ToolRegistry } from '../core/toolRegistry';
import type { SkillsRegistry } from '../core/skillsRegistry';

/**
 * Reasoning / meta tools:
 *  - think: a scratchpad for the model's reasoning. The content is shown to
 *    the user in a collapsible "thinking" section, but does NOT execute
 *    anything. Encourages explicit planning before action.
 *
 * Skills tools (require a SkillsRegistry):
 *  - list_skills: list available skills
 *  - view_skill: read a skill's full body
 *  - invoke_skill: invoke a skill (injects its body as a procedure note)
 */

export const reasoningToolDefinitions: ToolDefinition[] = [
  {
    name: 'think',
    category: 'reasoning',
    description:
      'A scratchpad for your reasoning. Use this to plan multi-step work, weigh alternatives, or reason about a problem BEFORE acting. The content is shown to the user in a collapsible "thinking" section. Does not execute anything. Use it for tasks with 3+ steps, unfamiliar codebases, or when you need to weigh trade-offs.',
    parameters: schema(
      {
        thought: {
          type: 'string',
          description: 'Your reasoning, plan, or analysis. Be specific and structured.',
        },
      },
      ['thought']
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['reasoning'],
  },
];

export function registerReasoningTools(registry: ToolRegistry): void {
  registry.register(reasoningToolDefinitions[0], async (args) => {
    const thought = String(args.thought ?? '');
    // The think tool is a no-op on the host — the thought content is surfaced
    // to the UI via the assistant's reasoning field (extracted by the parser
    // when the model uses the <|channel>thought channel). When the model
    // calls this tool explicitly, we just acknowledge it.
    return {
      ok: true,
      output: `Reasoning recorded (${thought.length} chars). Continue with your next step.`,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills tools
// ─────────────────────────────────────────────────────────────────────────────

export const skillsToolDefinitions: ToolDefinition[] = [
  {
    name: 'list_skills',
    category: 'skill',
    description:
      'List available skills (reusable multi-step procedures). Optional category filter: debug | refactor | test | explain | plan | general. Read-only.',
    parameters: schema(
      {
        category: {
          type: 'string',
          enum: ['debug', 'refactor', 'test', 'explain', 'plan', 'general'],
          description: 'Filter by category (optional)',
        },
      }
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['skill'],
  },
  {
    name: 'view_skill',
    category: 'skill',
    description:
      'Read the full body of a skill (the procedure it encapsulates). Read-only. Use this before invoking a skill to understand what it will do.',
    parameters: schema(
      {
        name: { type: 'string', description: 'Skill name' },
      },
      ['name']
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['skill'],
  },
  {
    name: 'invoke_skill',
    category: 'skill',
    description:
      'Invoke a skill by name. The skill\'s procedure body is injected into the conversation, and the agent follows it. Use this when the user\'s request matches a skill\'s trigger conditions.',
    parameters: schema(
      {
        name: { type: 'string', description: 'Skill name' },
        args: {
          type: 'object',
          description: 'Optional arguments to pass to the skill (e.g. file paths, function names)',
          additionalProperties: true,
        },
      },
      ['name']
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['skill'],
  },
];

export function registerSkillsTools(
  registry: ToolRegistry,
  skills: SkillsRegistry
): void {
  registry.register(skillsToolDefinitions[0], async (args) => {
    const cat = args.category ? String(args.category) : undefined;
    const list = skills.list(cat);
    if (list.length === 0) {
      return {
        ok: true,
        output: cat ? `No skills in category "${cat}".` : 'No skills available.',
      };
    }
    const lines = list.map(
      (s) => `- ${s.name} [${s.category}] — ${s.description}`
    );
    return {
      ok: true,
      output: `[${list.length} skill${list.length === 1 ? '' : 's'}${cat ? ` in ${cat}` : ''}]\n${lines.join('\n')}`,
    };
  });

  registry.register(skillsToolDefinitions[1], async (args) => {
    const name = String(args.name);
    const skill = skills.get(name);
    if (!skill) {
      return { ok: false, output: `Skill "${name}" not found. Use list_skills to see available skills.` };
    }
    const triggers = skill.triggers && skill.triggers.length > 0
      ? `\n\nTriggers: ${skill.triggers.join(', ')}`
      : '';
    const reqTools = skill.requiredTools && skill.requiredTools.length > 0
      ? `\nRequired tools: ${skill.requiredTools.join(', ')}`
      : '';
    return {
      ok: true,
      output: `# Skill: ${skill.name}\n\nCategory: ${skill.category}\nDescription: ${skill.description}${triggers}${reqTools}\n\n---\n\n${skill.body}`,
    };
  });

  registry.register(skillsToolDefinitions[2], async (args) => {
    const name = String(args.name);
    const skill = skills.get(name);
    if (!skill) {
      return { ok: false, output: `Skill "${name}" not found. Use list_skills to see available skills.` };
    }
    // Invoking a skill returns its body so the model can read it and follow
    // the procedure. The body is also surfaced to the UI as a "skill invoked"
    // annotation.
    const argStr = args.args ? `\n\nArguments: ${JSON.stringify(args.args)}` : '';
    return {
      ok: true,
      output: `Skill "${name}" invoked. Follow this procedure:\n\n${skill.body}${argStr}`,
      meta: { skill: name },
    };
  });
}
