import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';
import { ChatMessage } from './LLMClient';

export type StepType =
  | 'user_message' | 'assistant_message'
  | 'tool_call' | 'tool_result'
  | 'file_change' | 'checkpoint' | 'auto_checkpoint' | 'fork_point' | 'planning_start' | 'planning_done'
  | 'succession_handoff';

export interface CortexStep {
  id:        string;
  type:      StepType;
  timestamp: string;
  data:      Record<string, unknown>;
}

export interface Checkpoint {
  id:       string;
  name:     string;
  created:  string;
  messages: ChatMessage[];
  steps:    CortexStep[];
}

export interface Trajectory {
  id:          string;
  workspaceId: string;
  created:     string;
  updated:     string;
  messages:    ChatMessage[];
  steps:       CortexStep[];
  checkpoints: Checkpoint[];
}

export class TrajectoryStore {
  private storePath: string;
  private trajectory: Trajectory;

  constructor(ctx: vscode.ExtensionContext) {
    const wsId    = sanitize(vscode.workspace.workspaceFolders?.[0]?.name ?? 'default');
    this.storePath = path.join(ctx.globalStorageUri.fsPath, `traj_${wsId}.json`);
    this.trajectory = this.load(wsId);
  }

  private load(wsId: string): Trajectory {
    try {
      if (fs.existsSync(this.storePath)) {
        const t = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as Trajectory;
        // Images are never replayed from history (non-vision models reject them with HTTP 400) and bloat the file.
        t.messages = t.messages.map(textOnly);
        t.checkpoints = (t.checkpoints ?? []).map(c => ({ ...c, messages: c.messages.map(textOnly) }));
        return t;
      }
    } catch { /* corrupted */ }
    return {
      id:          Date.now().toString(36),
      workspaceId: wsId,
      created:     iso(),
      updated:     iso(),
      messages:    [],
      steps:       [],
      checkpoints: []
    };
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      this.trajectory.updated = iso();
      fs.writeFileSync(this.storePath, JSON.stringify(this.trajectory, null, 2), 'utf8');
    } catch (e) { console.error('TrajectoryStore persist error:', e); }
  }

  getMessages(): ChatMessage[] { return [...this.trajectory.messages]; }
  getSteps():    CortexStep[]  { return [...this.trajectory.steps]; }

  // Succession Protocol (§13): replace trajectory steps with a pruned set
  reset(keepSteps?: CortexStep[]): void {
    this.trajectory.steps    = keepSteps ? [...keepSteps] : [];
    this.trajectory.messages = [];
    void this.persist();
  }

  // Record file content before an edit (for revert)
  recordFileChange(filePath: string, before: string): void {
    this.addStep('file_change', { path: filePath, before: before.slice(0, 50000) });
  }

  // Get all file_change steps (for revert)
  getFileChanges(): Array<{ stepId: string; path: string; before: string }> {
    return this.trajectory.steps
      .filter(s => s.type === 'file_change')
      .map(s => ({ stepId: s.id, path: String(s.data.path ?? ''), before: String(s.data.before ?? '') }));
  }

  addMessage(msg: ChatMessage, stepType: StepType = 'user_message'): void {
    this.trajectory.messages.push(textOnly(msg));
    this.addStep(stepType, { role: msg.role, content: msg.content.slice(0, 200) });
  }

  addStep(type: StepType, data: Record<string, unknown> = {}): void {
    this.trajectory.steps.push({
      id:        Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      type, data, timestamp: iso()
    });
    // auto-persist every 5 steps
    if (this.trajectory.steps.length % 5 === 0) this.persist();
  }

  setMessages(messages: ChatMessage[]): void {
    this.trajectory.messages = [...messages];
    this.persist();
  }

  clearMessages(): void {
    this.trajectory.messages = [];
    this.persist();
  }

  // ── Checkpoints ──────────────────────────────────────────────
  saveCheckpoint(name: string): Checkpoint {
    const cp: Checkpoint = {
      id:       Date.now().toString(36),
      name,
      created:  iso(),
      messages: JSON.parse(JSON.stringify(this.trajectory.messages)) as ChatMessage[],
      steps:    [...this.trajectory.steps]
    };
    this.trajectory.checkpoints.push(cp);
    this.addStep('checkpoint', { name, id: cp.id });
    this.persist();
    return cp;
  }

  listCheckpoints(): Checkpoint[] { return [...this.trajectory.checkpoints]; }

  restoreCheckpoint(id: string): boolean {
    const cp = this.trajectory.checkpoints.find(c => c.id === id);
    if (!cp) return false;
    this.trajectory.messages = JSON.parse(JSON.stringify(cp.messages)) as ChatMessage[];
    this.trajectory.steps    = [...cp.steps];
    this.addStep('fork_point', { from_checkpoint: id, name: cp.name });
    this.persist();
    return true;
  }

  deleteCheckpoint(id: string): boolean {
    const before = this.trajectory.checkpoints.length;
    this.trajectory.checkpoints = this.trajectory.checkpoints.filter(c => c.id !== id);
    if (this.trajectory.checkpoints.length < before) { this.persist(); return true; }
    return false;
  }

  // ── Fork ─────────────────────────────────────────────────────
  forkFromCheckpoint(id: string): ChatMessage[] | undefined {
    const cp = this.trajectory.checkpoints.find(c => c.id === id);
    if (!cp) return undefined;
    return JSON.parse(JSON.stringify(cp.messages)) as ChatMessage[];
  }

  // Called on VS Code shutdown for final persist
  flush(): void { this.persist(); }
}

function textOnly(m: ChatMessage): ChatMessage {
  return m.id ? { role: m.role, content: m.content, id: m.id } : { role: m.role, content: m.content };
}
function iso(): string { return new Date().toISOString(); }
function sanitize(s: string): string { return s.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40); }
