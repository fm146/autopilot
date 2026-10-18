import * as vscode from 'vscode';

export interface ModelConfig {
  id:       string;
  name:     string;
  provider: 'ollama' | 'openai' | 'gemini' | 'openrouter' | 'custom';
  baseUrl:  string;
  modelId:  string;
  description?: string;
  family?:  string;    // models sharing family + provider are one row in the picker
  variant?: string;    // label of this model on the row's slider, e.g. "Super 120B"
  audio?: boolean;   // accepts voice messages natively
}

export class ModelRegistry {
  private readonly SEC = 'ragAssistant:key:';

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  getModels(): ModelConfig[] {
    return vscode.workspace.getConfiguration('ragAssistant')
      .get<ModelConfig[]>('models') ?? [];
  }

  getActiveModel(): ModelConfig | undefined {
    const id  = vscode.workspace.getConfiguration('ragAssistant')
      .get<string>('activeModelId') ?? '';
    const all = this.getModels();
    return all.find(m => m.id === id) ?? all[0];
  }

  // Model used to analyze images; the user's selected model stays in charge of the reply.
  getVisionModel(): ModelConfig | undefined {
    const id  = vscode.workspace.getConfiguration('ragAssistant')
      .get<string>('visionModelId') ?? 'ollama-cloud-gemma4';
    const all = this.getModels();
    return all.find(m => m.id === id) ?? all.find(m => m.modelId.startsWith('gemma4'));
  }

  // Model that listens to voice messages when the selected model cannot.
  getAudioModel(): ModelConfig | undefined {
    const id  = vscode.workspace.getConfiguration('ragAssistant').get<string>('audioModelId') ?? '';
    const all = this.getModels();
    return all.find(m => m.id === id) ?? all.find(m => m.audio);
  }

  async setActiveModel(id: string): Promise<void> {
    await vscode.workspace.getConfiguration('ragAssistant')
      .update('activeModelId', id, vscode.ConfigurationTarget.Global);
  }

  async addModel(model: ModelConfig, apiKey: string): Promise<void> {
    if (apiKey) {
      await this.ctx.secrets.store(this.SEC + model.id, apiKey);
    }
    const models = this.getModels();
    models.push(model);
    await vscode.workspace.getConfiguration('ragAssistant')
      .update('models', models, vscode.ConfigurationTarget.Global);
    await this.setActiveModel(model.id);
  }

  async removeModel(id: string): Promise<void> {
    const remaining = this.getModels().filter(m => m.id !== id);
    await vscode.workspace.getConfiguration('ragAssistant')
      .update('models', remaining, vscode.ConfigurationTarget.Global);
    await this.ctx.secrets.delete(this.SEC + id);
    const stillActive = this.getActiveModel();
    if (!stillActive && remaining.length > 0) {
      await this.setActiveModel(remaining[0].id);
    }
  }

  // One OpenRouter key serves every OpenRouter model, so it is stored once per provider as well.
  private sharedKey(id: string): string | undefined {
    return this.getModels().find(m => m.id === id)?.provider === 'openrouter' ? this.SEC + 'provider:openrouter' : undefined;
  }

  async getApiKey(id: string): Promise<string> {
    const own = await this.ctx.secrets.get(this.SEC + id);
    if (own) return own;
    const shared = this.sharedKey(id);
    return (shared && (await this.ctx.secrets.get(shared))) || '';
  }

  async setApiKey(id: string, apiKey: string): Promise<void> {
    const shared = this.sharedKey(id);
    if (apiKey) {
      await this.ctx.secrets.store(this.SEC + id, apiKey);
      if (shared) await this.ctx.secrets.store(shared, apiKey);
    } else {
      await this.ctx.secrets.delete(this.SEC + id);
      if (shared) await this.ctx.secrets.delete(shared);
    }
  }
}
