import { ModelRegistry }      from './ModelRegistry';
import { LLMClient, ChatMessage } from './LLMClient';
import { AGENT_PROMPTS, AgentRole } from './PromptAssembler';

export interface SubagentTask {
  id:       string;
  role:     AgentRole;
  prompt:   string;
  status:   'pending' | 'running' | 'done' | 'error';
  result?:  string;
  error?:   string;
}

export interface SubagentResult {
  id:     string;
  role:   AgentRole;
  result: string;
  ok:     boolean;
}

export class SubagentOrchestrator {
  private llm = new LLMClient();

  constructor(
    private registry: ModelRegistry,
    private onProgress?: (msg: string) => void
  ) {}

  // Run multiple subtasks with different agent roles, sequentially
  // Returns aggregated results
  async runTeam(
    tasks: Array<{ role: AgentRole; prompt: string }>,
    baseContext?: string
  ): Promise<SubagentResult[]> {
    const results: SubagentResult[] = [];

    for (const task of tasks) {
      const id = `${task.role}-${Date.now()}`;
      this.onProgress?.(`[Subagent] Starting ${task.role} agent...`);

      try {
        const result = await this.runOne(task.role, task.prompt, baseContext);
        results.push({ id, role: task.role, result, ok: true });
        this.onProgress?.(`[Subagent] ${task.role} done (${result.length} chars)`);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        results.push({ id, role: task.role, result: '', ok: false });
        this.onProgress?.(`[Subagent] ${task.role} error: ${err}`);
      }
    }

    return results;
  }

  // Run a single subtask with a specific agent role
  async runOne(
    role: AgentRole,
    userPrompt: string,
    context?: string
  ): Promise<string> {
    const model = this.registry.getActiveModel();
    if (!model) throw new Error('No model configured');

    const apiKey = await this.registry.getApiKey(model.id);

    const roleDesc = role !== 'default' ? AGENT_PROMPTS[role] : 'You are a helpful AI assistant.';
    const sysParts = [roleDesc];
    if (context) sysParts.push(`Context:\n${context}`);
    sysParts.push('Be concise and focused. Provide only the requested output.');

    const messages: ChatMessage[] = [
      { role: 'system',    content: sysParts.join('\n\n') },
      { role: 'user',      content: userPrompt }
    ];

    let accumulated = '';
    await this.llm.streamChat(
      model, apiKey, messages,
      { maxTokens: 4096, temperature: 0.5 },
      chunk => {
        if (chunk.type === 'delta' && chunk.content) accumulated += chunk.content;
      }
    );
    return accumulated;
  }

  // Orchestrate with the full Teamwork pipeline (§17):
  // orchestrator_pure → armed_worker(s) → armed_critic → victory_auditor
  async orchestrate(task: string, context?: string): Promise<string> {
    // Phase 1: orchestrator_pure decomposes the task
    this.onProgress?.('[Teamwork] orchestrator_pure: decomposing task...');
    const decomp = await this.runOne('orchestrator_pure',
      `Decompose this task into 2-4 concrete sub-tasks. Assign each to one of: armed_worker, explorer, spec_miner, test_writer.\n\nTask: ${task}\n\nOutput ONLY valid JSON array:\n[{"role":"armed_worker","task":"..."}, ...]`,
      context
    );

    let subtasks: Array<{ role: AgentRole; task: string }> = [];
    try {
      const match = decomp.match(/\[[\s\S]*?\]/);
      if (match) subtasks = JSON.parse(match[0]) as Array<{ role: AgentRole; task: string }>;
    } catch { /* fallback */ }

    if (!subtasks.length) {
      // Fallback: single armed_worker
      subtasks = [{ role: 'armed_worker', task }];
    }

    // Phase 2: Run each sub-task
    const results = await this.runTeam(
      subtasks.map(s => ({ role: s.role, prompt: s.task })),
      context
    );

    // Phase 3: armed_critic reviews the combined work
    this.onProgress?.('[Teamwork] armed_critic: reviewing...');
    const workSummary = results
      .filter(r => r.ok)
      .map(r => `### ${r.role}\n${r.result}`)
      .join('\n\n');

    const critique = await this.runOne('armed_critic',
      `Review the following work done for: "${task}"\n\n${workSummary}\n\nIdentify any gaps, errors, or missing steps.`,
      context
    );

    // Phase 4: victory_auditor validates
    this.onProgress?.('[Teamwork] victory_auditor: validating...');
    const verdict = await this.runOne('victory_auditor',
      `Original task: "${task}"\n\nWork done:\n${workSummary}\n\nCritique:\n${critique}\n\nOutput PASS or FAIL with itemized evidence, then provide the final complete answer.`,
      context
    );

    return verdict;
  }

  // Quick 3-role pipeline: explorer → armed_worker → reviewer_critic
  async quickPipeline(task: string, context?: string): Promise<string> {
    this.onProgress?.('[Pipeline] explorer: researching...');
    const research = await this.runOne('explorer', `Research what exists for: ${task}`, context);

    this.onProgress?.('[Pipeline] armed_worker: implementing...');
    const impl = await this.runOne('armed_worker', `${task}\n\nContext from research:\n${research}`, context);

    this.onProgress?.('[Pipeline] reviewer_critic: reviewing...');
    const review = await this.runOne('reviewer_critic', `Review this implementation:\n${impl}`, context);

    return `## Implementation\n${impl}\n\n## Review\n${review}`;
  }
}
