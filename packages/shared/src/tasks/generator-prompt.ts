/**
 * Generator prompt for Generate mode (#2 / architecture §3a).
 *
 * The task's persistent orchestrator session is asked to AUTHOR a `task.yaml`
 * from a natural-language goal. The result is a human-editable artifact, so the
 * prompt is legibility-first (#7): bias toward the simplest graph that achieves
 * the goal, with clear titles and explicit dependencies — not the cleverest one.
 */
export function buildGeneratorPrompt(goal: string, title?: string): string {
  return [
    'You are authoring a `task.yaml` that decomposes a goal into a small DAG of subtasks.',
    'Each node becomes a child AI session; a `depends_on` edge passes the upstream node\'s output to the dependent.',
    '',
    'Rules:',
    '- Output ONLY the YAML — no prose, no code fences, no explanation.',
    '- Prefer the SIMPLEST graph that achieves the goal: few nodes, clear titles, explicit dependencies. A human will read and edit this.',
    '- Make nodes parallel (no `depends_on` between them) ONLY when the steps are genuinely independent.',
    '- Reference an upstream result inside a prompt with ${nodes.<id>.output}.',
    '- Every ${nodes.<id>.output} reference MUST point to an `id` that you actually declare under `nodes`. Never reference a node you did not create. Verify each reference resolves before emitting the YAML.',
    '- Add `acceptance_criteria`: a short, checkable rubric for the FINISHED task (what "done and correct" means). It is what you will grade the result against when the run finishes — make it concrete and testable, not a restatement of the goal.',
    '- Optional `skills` arrays may appear at the task level or on individual nodes. Use only safe slugs: lowercase letters, digits, and hyphens; no spaces, brackets, prose, or trailing hyphen.',
    '- Model selection is optional and must be dynamic. Use reliable available model and connection metadata from the Craft tool surface when provided; if unavailable or uncertain, omit `model` and `llmConnection` fields and use runtime defaults instead of guessing.',
    '- If current web benchmark context is available and relevant, optional public sources such as the Artificial Analysis Coding Agent Index (https://artificialanalysis.ai/agents/coding-agents) may help compare configured models for coding/agentic tasks. Treat them as optional references, not hard dependencies; if unavailable or unmapped to configured Craft models/connections, fall back to Craft metadata or omit model fields.',
    '- Use `defaults.model` + `defaults.llmConnection` for a common child-session default, and `node.model` + `node.llmConnection` only for meaningful deviations. When specifying a non-default model, include its matching connection; otherwise omit/default both.',
    '- Choose the fastest/cheapest sufficiently capable option for simple/mechanical nodes, a balanced capable option for moderate implementation, and the strongest/specialized available option for complex architecture/security/concurrency/audit/high-risk nodes. Do not use premium/slow options for simple nodes without reason.',
    '- If multiple strong options are available, choose by domain fit, context window, coding/review strength, latency/cost, and project/provider suitability. Never hardcode concrete model/provider recommendations.',
    '- Do not tell child workers to set their own session to closed statuses like `done` or `cancelled`; they should report completion/blockers and manage labels if needed. The Conductor owns terminal status updates for its child/task tiles.',
    '',
    'Schema:',
    '  id: kebab-case-slug',
    '  title: short human title',
    '  goal: one-line restatement of the goal',
    '  acceptance_criteria: a concrete, checkable definition of done for the whole task',
    '  skills: [optional-task-skill]       # optional; safe slugs only',
    '  defaults:                          # optional common child-session defaults',
    '    model: optional-model-id          # only from reliable available metadata',
    '    llmConnection: matching-connection-slug',
    '  nodes:',
    '    - id: kebab-id',
    '      title: short title (becomes the subtask/session name)',
    '      skills: [optional-node-skill]   # optional; appended after task-level skills',
    '      model: optional-model-id        # optional node override; pair with llmConnection',
    '      llmConnection: matching-connection-slug',
    '      prompt: the full instruction for this subtask (may include ${nodes.<id>.output})',
    '      depends_on: [other-node-id]   # omit when the node has no dependencies',
    '',
    'Example:',
    '  id: migrate-auth',
    '  title: Migrate auth',
    '  goal: Migrate the auth layer to the new session model.',
    '  acceptance_criteria: All auth call sites use the new session API and the existing auth tests pass.',
    '  nodes:',
    '    - id: audit',
    '      title: Audit call sites',
    '      prompt: List every auth call site and how it is used.',
    '    - id: design',
    '      title: Design new auth',
    '      prompt: "Design the new session-based auth using the audit: ${nodes.audit.output}"',
    '      depends_on: [audit]',
    '',
    title ? `Working title: ${title}` : '',
    `Goal: ${goal}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Repair prompt for the auto-repair turn (Generate mode robustness).
 *
 * The orchestrator just authored a `task.yaml` that failed validation (commonly a
 * `${nodes.X.output}` reference to a node id it never declared). It still holds the
 * conversation, so we hand the concrete validation errors back and ask for a corrected
 * spec — same output contract as the original generation (YAML only).
 */
export function buildRepairPrompt(errors: { path: string; message: string }[]): string {
  return [
    'The task.yaml you produced failed validation with these errors:',
    ...errors.map((e) => `- ${e.path}: ${e.message}`),
    '',
    'Fix every error and output the COMPLETE corrected task.yaml.',
    'Most common cause: a ${nodes.<id>.output} reference whose <id> is not declared under `nodes`. Either add the missing node or change the reference to an id you actually declare.',
    'Output ONLY the YAML — no prose, no code fences, no explanation.',
  ].join('\n')
}
