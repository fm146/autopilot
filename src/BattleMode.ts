// ── Battle Mode (§19) ──────────────────────────────────────────
// Two agents compete on the same task; judge model evaluates results.
// Source: third_party/jetski/cortex/battlemode.go

import * as vscode from 'vscode';
import { LLMClient, ChatMessage } from './LLMClient';
import { ModelRegistry } from './ModelRegistry';
import { TrajectoryStore } from './TrajectoryStore';

export interface BattleModeConfig {
  modelA:     string; // display name of model A
  modelB:     string; // display name of model B
  judgeModel?: string;
}

export interface BattleResult {
  task:      string;
  modelA:    string;
  modelB:    string;
  responseA: string;
  responseB: string;
  verdict:   BattleVerdict;
  timestamp: string;
}

export interface BattleVerdict {
  winner:    'A' | 'B' | 'tie';
  reasoning: string;
  scoreA:    number; // 0-10
  scoreB:    number; // 0-10
}

export class BattleMode {
  private readonly llm = new LLMClient();

  constructor(
    private readonly registry: ModelRegistry,
    private readonly traj: TrajectoryStore
  ) {}

  // Run two agents on the same task and judge the results
  async run(task: string, config: BattleModeConfig): Promise<BattleResult> {
    const models = this.registry.getModels();
    const mA = models.find(m => m.name === config.modelA || m.id === config.modelA);
    const mB = models.find(m => m.name === config.modelB || m.id === config.modelB);

    if (!mA || !mB) {
      throw new Error(
        `Battle Mode: model not found.\nAvailable: ${models.map(m => m.name).join(', ')}`
      );
    }

    void vscode.window.showInformationMessage(
      `⚔️ Battle Mode: ${mA.name} vs ${mB.name} — running in parallel...`
    );

    const systemPrompt = 'You are a helpful AI coding assistant. Complete the task as thoroughly as possible.';
    const msgs: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: task }
    ];

    const [keyA, keyB] = await Promise.all([
      this.registry.getApiKey(mA.id),
      this.registry.getApiKey(mB.id)
    ]);

    // Run both agents in parallel using callback-based streamChat
    const [responseA, responseB] = await Promise.allSettled([
      this.collectResponse(mA, keyA, msgs),
      this.collectResponse(mB, keyB, msgs)
    ]);

    const textA = responseA.status === 'fulfilled' ? responseA.value
      : `Error: ${String((responseA as PromiseRejectedResult).reason)}`;
    const textB = responseB.status === 'fulfilled' ? responseB.value
      : `Error: ${String((responseB as PromiseRejectedResult).reason)}`;

    // Judge evaluation
    const verdict = await this.judge(task, textA, textB, config, models, keyA);

    const result: BattleResult = {
      task, modelA: mA.name, modelB: mB.name,
      responseA: textA, responseB: textB, verdict,
      timestamp: new Date().toISOString()
    };

    // Record as BATTLE_MODE CortexStep
    this.traj.addStep('checkpoint', {
      battle_mode:  true,
      model_a:      mA.name,
      model_b:      mB.name,
      winner:       verdict.winner,
      score_a:      verdict.scoreA,
      score_b:      verdict.scoreB,
      task_preview: task.slice(0, 100)
    });

    return result;
  }

  private collectResponse(
    model: ReturnType<ModelRegistry['getModels']>[number],
    apiKey: string,
    msgs: ChatMessage[]
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const parts: string[] = [];
      this.llm.streamChat(model, apiKey, msgs, { maxTokens: 4096, temperature: 0.7 }, chunk => {
        if (chunk.type === 'delta' && chunk.content) parts.push(chunk.content);
        else if (chunk.type === 'done') resolve(parts.join('') || '(no response)');
        else if (chunk.type === 'error') reject(new Error(chunk.error ?? 'LLM error'));
      });
    });
  }

  private async judge(
    task: string,
    responseA: string,
    responseB: string,
    config: BattleModeConfig,
    models: ReturnType<ModelRegistry['getModels']>,
    fallbackKey: string
  ): Promise<BattleVerdict> {
    const judgeModel = config.judgeModel
      ? models.find(m => m.name === config.judgeModel || m.id === config.judgeModel)
      : models[0];

    if (!judgeModel) return this.heuristicJudge(responseA, responseB);

    const judgeKey   = await this.registry.getApiKey(judgeModel.id);
    const judgePrompt = `You are an impartial judge evaluating two AI responses to the same task.

Task: ${task.slice(0, 500)}

Response A:
${responseA.slice(0, 2000)}

Response B:
${responseB.slice(0, 2000)}

Evaluate on: correctness, completeness, code quality, clarity. Score each 0-10.
Respond ONLY in this exact JSON: {"winner":"A"|"B"|"tie","scoreA":<0-10>,"scoreB":<0-10>,"reasoning":"<brief>"}`;

    try {
      const raw = await this.collectResponse(judgeModel, judgeKey || fallbackKey, [
        { role: 'system', content: 'You are an impartial judge. Respond only with valid JSON.' },
        { role: 'user',   content: judgePrompt }
      ]);
      const jsonMatch = raw.match(/\{[^}]+\}/s);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          winner?: string; scoreA?: number; scoreB?: number; reasoning?: string;
        };
        return {
          winner:    (parsed.winner as 'A' | 'B' | 'tie') ?? 'tie',
          scoreA:    Number(parsed.scoreA ?? 5),
          scoreB:    Number(parsed.scoreB ?? 5),
          reasoning: String(parsed.reasoning ?? 'No reasoning provided')
        };
      }
    } catch { /* fall through */ }

    return this.heuristicJudge(responseA, responseB);
  }

  private heuristicJudge(a: string, b: string): BattleVerdict {
    const codeA  = (a.match(/```/g) ?? []).length / 2;
    const codeB  = (b.match(/```/g) ?? []).length / 2;
    const scoreA = Math.min(10, Math.max(0, Math.round(5 + (a.length - b.length) / 500 + codeA)));
    const scoreB = Math.min(10, Math.max(0, Math.round(5 + (b.length - a.length) / 500 + codeB)));
    const winner = scoreA > scoreB ? 'A' : scoreB > scoreA ? 'B' : 'tie';
    return { winner, scoreA, scoreB, reasoning: 'Heuristic evaluation (no judge model available)' };
  }

  static formatResult(r: BattleResult): string {
    const icon = r.verdict.winner === 'A' ? `🏆 **${r.modelA} wins**`
      : r.verdict.winner === 'B' ? `🏆 **${r.modelB} wins**`
      : '🤝 **Tie**';
    return [
      `⚔️ **Battle Mode Results**\n`,
      `**Task:** ${r.task.slice(0, 100)}`,
      `**${r.modelA}** (A) vs **${r.modelB}** (B)\n`,
      `**Verdict:** ${icon}`,
      `**Score:** A=${r.verdict.scoreA}/10 · B=${r.verdict.scoreB}/10`,
      `**Reasoning:** ${r.verdict.reasoning}\n`,
      `---\n### Response A — ${r.modelA}`,
      r.responseA.slice(0, 1500),
      `\n---\n### Response B — ${r.modelB}`,
      r.responseB.slice(0, 1500),
    ].join('\n');
  }
}
