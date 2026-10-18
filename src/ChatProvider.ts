import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as nodePath from 'path';
import { execFile } from 'child_process';
import { AsyncLocalStorage } from 'async_hooks';
import { ModelRegistry, ModelConfig }     from './ModelRegistry';
import { LLMClient, ChatMessage, estimateTokens, truncateHistory, extractLeakedToolCalls } from './LLMClient';
import { ToolRunner, TOOL_DEFS, SHELL_LABEL } from './ToolRunner';
import { TrajectoryStore }                from './TrajectoryStore';
import { SessionStore }                   from './SessionStore';
import { Analytics }                      from './Analytics';
import { EditReview }                     from './EditReview';
import { ShadowGit }                      from './ShadowGit';
import { RESEARCH_TOOL_DEFS, RESEARCH_TOOL_NAMES } from './ResearchTools';
import { KnowledgeBase }                  from './KnowledgeBase';
import { DiagnosticsCollector }           from './DiagnosticsCollector';
import { PromptAssembler, AgentRole, AGENT_PROMPTS } from './PromptAssembler';
import { MCPClient }                      from './MCPClient';
import { getRAGEngine }                   from './RAGEngine';
import { SubagentOrchestrator }           from './SubagentOrchestrator';
import { SidecarManager }                 from './SidecarManager';
import { getPolicyGuardian }              from './PolicyGuardian';
import { SlashCommandRegistry, registerBuiltinOWLCommands } from './SlashCommandRegistry';
import { BattleMode }                from './BattleMode';
import { getSDKExecutor }            from './SDKExecutor';

interface PendingFile { filePath: string; content: string; }

/** One agent run. Runs on different models go in parallel, so everything that used to be "the" run state lives here. */
interface RunCtx {
  id: string;
  real: boolean;                       // false = the idle context used outside any run
  kind: 'chat' | 'exclusive';          // exclusive = plan / research / battle / sub-agents: one at a time
  modelId: string;
  model?: ModelConfig;
  llm: LLMClient;                      // own client, so Stop aborts only this run's requests
  stop: boolean;
  outcome: 'done' | 'error';
  tools: number;
  streaming: boolean;
  userPosted: boolean;                 // the user's card for this run is already in the chat
  msgId?: string;
  images?: string[];                   // attachments captured when the message was sent
  audio?: Array<{ data: string; format: string }>;
}
/** A message waiting for its turn (same model as a running task, or behind an exclusive task). */
interface QueuedRun {
  id: string;
  kind: 'chat' | 'exclusive';
  modelId: string;
  model?: ModelConfig;
  text: string;
  shown?: string;
  msgId?: string;
  images?: string[];
  audio?: Array<{ data: string; format: string }>;
  fn: () => Promise<void>;
  resolve: () => void;
  preposted: boolean;
}

const MAX_TOOL_ITERATIONS = 25;

export class ChatProvider implements vscode.WebviewViewProvider {
  private view?:         vscode.WebviewView;
  private history:       ChatMessage[] = [];
  private baseLlm =      new LLMClient();
  private tools =        new ToolRunner();
  private als =          new AsyncLocalStorage<RunCtx>();
  private idle:          RunCtx = { id: '', real: false, kind: 'exclusive', modelId: '', llm: this.baseLlm, stop: false, outcome: 'done', tools: 0, streaming: false, userPosted: false };
  private activeRuns =   new Map<string, RunCtx>();
  private queue:         QueuedRun[] = [];
  // The run the current code belongs to (async-local), or the idle context. Everything below reads/writes through it.
  private get run(): RunCtx { return this.als.getStore() ?? this.idle; }
  private get llm(): LLMClient { return this.run.llm; }
  private get streaming(): boolean { return this.run.streaming; }
  private set streaming(v: boolean) { this.run.streaming = v; }
  private get stopRequested(): boolean { return this.run.stop; }
  private set stopRequested(v: boolean) { this.run.stop = v; }
  private get runOutcome(): 'done' | 'error' { return this.run.outcome; }
  private set runOutcome(v: 'done' | 'error') { this.run.outcome = v; }
  private get runTools(): number { return this.run.tools; }
  private set runTools(v: number) { this.run.tools = v; }
  private get running(): boolean { return this.activeRuns.size > 0 || this.queue.length > 0; }
  private analytics:     Analytics;
  private review:        EditReview;
  private lastCtx =       { tokens: 0, max: 0 };
  private mode:          'manual' | 'edit' | 'plan' | 'research' | 'auto' = 'auto';
  private sessions:      SessionStore;
  private pendingFiles:  PendingFile[] = [];
  private activeRole:    AgentRole = 'default';
  private ragEnabled =   true;
  private planningMode = false;
  private pendingImages: string[] = [];
  private pendingAudio:  Array<{ data: string; format: string }> = [];
  private sidecar:       SidecarManager;
  private orchestrator:  SubagentOrchestrator;
  private terminalBuf =  '';
  private pinnedContext: Map<string, string> = new Map(); // label → content

  constructor(
    private readonly ctx:      vscode.ExtensionContext,
    private readonly registry: ModelRegistry,
    private readonly traj:     TrajectoryStore,
    private readonly kb:       KnowledgeBase,
    private readonly diag:     DiagnosticsCollector,
    private readonly assembler: PromptAssembler,
    private readonly mcp:      MCPClient
  ) {
    this.history      = this.traj.getMessages();
    this.sessions     = new SessionStore(ctx, this.history);
    this.analytics    = new Analytics(ctx);
    this.review       = new EditReview();
    ctx.subscriptions.push(this.review);
    // A file the agent changed shows up in the chat with its +/- counts and Accept / Revert; later decisions update the same card
    ctx.subscriptions.push(this.review.onDidUpdate(u => this.post({
      type: 'fileChanged', path: u.fsPath, rel: vscode.workspace.asRelativePath(u.fsPath), state: u.state,
      added: u.added, removed: u.removed, created: u.created, create: this.run.real && u.state === 'pending'
    })));
    this.configureLlm(this.baseLlm);
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('ragAssistant.openRouterAppUrl') || e.affectsConfiguration('ragAssistant.openRouterCategories')) {
        for (const c of [this.baseLlm, ...[...this.activeRuns.values()].map(r => r.llm)]) this.configureLlm(c);
      }
    }));
    ctx.subscriptions.push({ dispose: () => this.analytics.dispose() });
    this.shadow       = new ShadowGit(ctx);
    const savedMode   = ctx.globalState.get<string>('ragAssistant.mode');
    if (savedMode === 'manual' || savedMode === 'edit' || savedMode === 'plan' || savedMode === 'research' || savedMode === 'auto') this.mode = savedMode;
    // credentials for the research tools: secret storage first, environment variables as a fallback
    this.tools.researchOpts = async () => ({
      githubToken: (await ctx.secrets.get('ragAssistant:githubToken')) || process.env['GITHUB_TOKEN'] || undefined,
      brightKey:   (await ctx.secrets.get('ragAssistant:brightDataKey')) || process.env['BRIGHTDATA_API_KEY'] || undefined,
      brightZone:  vscode.workspace.getConfiguration('ragAssistant').get<string>('brightDataZone') || process.env['BRIGHTDATA_ZONE'] || undefined,
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    });
    this.sidecar      = new SidecarManager();
    this.orchestrator = new SubagentOrchestrator(registry, msg =>
      this.post({ type: 'systemMessage', text: msg })
    );
    // Wire terminal buffer and background-command notify into ToolRunner
    this.tools.terminalBufFn = () => this.terminalBuf;
    this.tools.onBackground  = msg =>
      this.post({ type: 'systemMessage', text: msg });
    ctx.subscriptions.push({ dispose: () => this.sidecar.dispose() });
    // ── OWL slash command registry (§21) ──────────────────────
    registerBuiltinOWLCommands(SlashCommandRegistry.getInstance());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')]
    };
    view.webview.html = this.loadHtml();
    view.webview.onDidReceiveMessage(msg => {
      void this.onMessage(msg as Record<string, unknown>);
    });
  }

  refreshModels(): void { this.postModels(); }

  newChat(): void {
    if (this.running) { this.showInfo('Stop the current run before starting a new session.'); return; }
    this.sessions.saveCurrent(this.history);
    this.sessions.newSession();
    this.pendingPlan = null;
    this.history  = [];
    this.traj.reset();
    this.streaming = false;
    this.activeRole = 'default';
    this.planningMode = false;
    this.post({ type: 'clearChat' });
    this.postSessionInfo();
  }

  private postSessionInfo(): void {
    const s = this.sessions.current();
    this.post({ type: 'sessionInfo', title: s.title, bookmarked: s.bookmarked });
  }

  private postSessionList(): void {
    this.post({
      type: 'sessionList', sessions: this.sessions.list(), currentId: this.sessions.current().id
    });
  }

  private openSession(id: string): void {
    if (this.running) { this.showInfo('Stop the current run before switching sessions.'); return; }
    if (id === this.sessions.current().id) return;
    this.sessions.saveCurrent(this.history);
    const s = this.sessions.switchTo(id);
    if (!s) return;
    this.history = [...s.messages];
    this.traj.setMessages(this.history);
    this.post({ type: 'clearChat' });
    if (this.history.length) this.post({ type: 'history', messages: this.history });
    this.postSessionInfo();
    this.postSessionList();
  }

  // ── Incoming messages from webview ───────────────────────────
  private async onMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.cancelPermissions();      // a reloaded webview cannot answer cards from the old one
        this.postModels();
        this.postStatus();
        this.postSessionInfo();
        this.postMode();
        this.postRunState();           // a reloaded panel learns that tasks are still running
        if (this.history.length) {
          this.post({ type: 'history', messages: this.history });
        }
        break;
      case 'send':       await this.handleInput(String(msg.text ?? ''));        break;
      case 'stop':       this.stopAll(); break;
      case 'cancelQueued': this.cancelQueued(String(msg.runId ?? '')); break;
      case 'reviewAction': {
        const p = String(msg.path ?? '');
        if (!p) break;
        if (msg.action === 'accept') this.review.acceptFile(p);
        else if (msg.action === 'revert') await this.review.revertFile(p);
        else if (msg.action === 'open') await this.review.openFile(p);
        break;
      }
      case 'cardResponse': {
        const id = String(msg.id ?? ''), value = String(msg.value ?? 'skip');
        const text = msg.text ? String(msg.text) : undefined;
        if (this.pendingPerms.has(id)) { this.pendingPerms.get(id)!({ choice: value, feedback: text }); break; }
        if (id === this.planCardId) await this.answerPlanCard(value, text);
        else if (id === this.restoreCardId) await this.answerRestoreCard(value);
        else if (id === this.researchCardId) await this.answerResearchCard(value);
        break;
      }
      case 'restoreRequest': await this.requestRestore(String(msg.id ?? '')); break;
      case 'openResearch': {
        const found = await this.readResearch();
        const dir = this.planDir();
        if (found && dir) void vscode.window.showTextDocument(vscode.Uri.joinPath(dir, 'Research.md'), { preview: true, viewColumn: vscode.ViewColumn.Beside });
        break;
      }
      case 'voice':      await this.toggleVoiceTyping();                        break;
      case 'setModel':   await this.registry.setActiveModel(String(msg.modelId)); break;
      case 'addModel':   await vscode.commands.executeCommand('ragAssistant.addModel'); break;
      case 'removeModel': {
        // webviews cannot show confirm() dialogs, so ask from the extension side
        const target = this.registry.getModels().find(m => m.id === String(msg.modelId));
        if (!target) break;
        const ok = await vscode.window.showWarningMessage(`Remove model "${target.name}"?`, { modal: true }, 'Remove');
        if (ok === 'Remove') {
          await this.registry.removeModel(target.id);
          this.postModels();
        }
        break;
      }
      case 'setMode':        this.setMode(String(msg.mode ?? ''));                break;
      case 'openPlan': {
        const dir = this.planDir();
        if (dir) void vscode.window.showTextDocument(vscode.Uri.joinPath(dir, 'implementation_plan.md'), { preview: true, viewColumn: vscode.ViewColumn.Beside });
        break;
      }
      case 'fileSearch': {
        const query = String(msg.query ?? '');
        this.post({ type: 'fileResults', query, files: await this.searchFiles(query) });
        break;
      }
      case 'addContext':     await this.addContext();                             break;
      case 'browseWeb':      await this.browseWeb();                              break;
      case 'sessions':       this.postSessionList();                              break;
      case 'openSession':    this.openSession(String(msg.id ?? ''));              break;
      case 'bookmarkSession': {
        this.sessions.toggleBookmark(String(msg.id ?? this.sessions.current().id));
        this.postSessionInfo();
        this.postSessionList();
        break;
      }
      case 'deleteSession':
        if (this.sessions.remove(String(msg.id ?? ''))) this.postSessionList();
        break;
      case 'newChat':    this.newChat();     break;
      case 'createFiles': await this.createPendingFiles(); break;
      case 'discardFiles': this.pendingFiles = []; break;
      case 'imageAttach':
        if (msg.data) { this.pendingImages.push(String(msg.data)); this.post({ type: 'imageAdded', count: this.pendingImages.length }); }
        break;
      case 'clearImages': this.pendingImages = []; this.pendingAudio = []; break;
      case 'audioAttach': {
        const data = String(msg.data ?? '');
        if (data) this.pendingAudio.push({ data, format: String(msg.format ?? 'wav').toLowerCase() });
        break;
      }
      case 'removeAudio': this.pendingAudio.splice(Number(msg.index), 1); break;
      case 'removeImage': this.pendingImages.splice(Number(msg.index), 1); break;
      case 'toggleRAG':
        this.ragEnabled = !this.ragEnabled;
        if (this.ragEnabled) { void getRAGEngine().invalidate(); }
        this.postStatus();
        break;
      case 'pinContext':
        if (msg.label && msg.content) {
          this.pinnedContext.set(String(msg.label), String(msg.content));
          this.showInfo(`📌 Pinned: "${msg.label}"`);
        }
        break;
      case 'unpinContext':
        this.pinnedContext.delete(String(msg.label ?? ''));
        break;
      case 'clearPinContext':
        this.pinnedContext.clear();
        break;
    }
  }

  // ── Route input: slash commands vs. chat ─────────────────────
  private async handleInput(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed && !trimmed.startsWith('/')) this.analytics.message();

    // Slash command routing
    if (trimmed.startsWith('/')) {
      const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
      const c    = cmd.toLowerCase();
      const args = rest.join(' ');
      // The command is the user's message: show it as a turn (sticky card) and let the output go under it.
      // Skipped where the handler already creates its own turn, or where the chat is cleared right away.
      const own = new Set(['new', 'diag', 'fix', 'subagent']);
      if (c === 'orchestrate' && args) own.add('orchestrate');   // delegates to /subagent, which creates its own turn
      const approving = c === 'plan' && rest[0]?.toLowerCase() === 'approve';
      // Commands that start work share workspace state (plan files, battle, sub-agents): one at a time, the rest wait.
      if (['plan', 'battle', 'sdk', 'subagent', 'orchestrate'].includes(c) && !approving) {
        await this.schedule({ kind: 'exclusive', modelId: '', text: trimmed, fn: async () => {
          if (!own.has(c)) this.postUser(trimmed, false);
          await this.runSlash(cmd, rest, args, trimmed);
        } });
        return;
      }
      if (!own.has(c) && !approving) this.post({ type: 'userMessage', text: trimmed, hasImages: false });
      await this.runSlash(cmd, rest, args, trimmed);
      return;
    }

    // Plan and Research mode share the plan files: one at a time. Chat modes: the scheduler decides (queue or parallel).
    if (this.mode === 'plan')     { await this.schedule({ kind: 'exclusive', modelId: '', text: trimmed, fn: () => this.handlePlanModeInput(trimmed) }); return; }
    if (this.mode === 'research') { await this.schedule({ kind: 'exclusive', modelId: '', text: trimmed, fn: () => this.handleResearchInput(trimmed) }); return; }
    await this.doChat(trimmed);
  }

  private async runSlash(cmd: string, rest: string[], args: string, trimmed: string): Promise<void> {
      switch (cmd.toLowerCase()) {
        case 'plan':        await this.handlePlanApproval(args ? args.split(/\s+/) : ['Plan the current task']);  return;
        case 'battle':      await this.doBattle(args || trimmed.slice(8));      return;
        case 'sdk':         await this.doSDK(args);                             return;
        case 'agent':       this.setAgent(args);                                 return;
        case 'checkpoint':  await this.handleCheckpoint(rest);                  return;
        case 'knowledge':   await this.handleKnowledge(rest);                   return;
        case 'fork':        await this.handleFork(args);                        return;
        case 'rag':         this.ragEnabled = !this.ragEnabled; this.postStatus();
                            this.showInfo(`RAG ${this.ragEnabled ? 'enabled' : 'disabled'}`); return;
        case 'diag':        await this.doChat(`Show me the current diagnostics: ${this.diag.getActiveFileDiagnostics() || 'No errors found.'}`, undefined, '/diag'); return;
        case 'fix':         await this.doAutoFix(); return;
        case 'subagent':    await this.doSubagent(args); return;
        case 'orchestrate': await this.doOrchestrate(args); return;
        case 'sidecar':     await this.handleSidecar(rest); return;
        case 'terminal':    this.showInfo(`Last terminal output:\n\`\`\`\n${this.terminalBuf || '(empty)'}\n\`\`\``); return;
        case 'revert':      await this.handleRevert(rest);                        return;
        case 'pin':         await this.handlePin(rest);                           return;
        case 'security':    getPolicyGuardian().setEnabled(!args.includes('off')); this.showInfo(`PolicyGuardian ${args.includes('off') ? 'disabled' : 'enabled'}`); return;
        case 'permissions': this.showPermissions(args); return;
        case 'new':         this.newChat(); return;
        case 'model':       this.showModelPicker(); return;
        case 'tools':       this.showToolsList(); return;
        case 'context':     await this.showContext(); return;
        case 'analytics':   this.showAnalytics(args); return;
        case 'help':        this.showHelp(); return;
      }
      // ── OWL extensible slash command registry (§21) ───────────
      const owlResult = await SlashCommandRegistry.getInstance().invoke(trimmed.slice(1));
      if (owlResult !== null) {
        this.post({ type: 'systemMessage', text: owlResult });
        return;
      }
      // Unknown slash command — show suggestion
      this.showInfo(`Unknown command: ${cmd}. Type /help for available commands.`);
      return;
  }

  /** Plan mode: every message goes through the planning pipeline, which writes implementation_plan.md. */
  private async handlePlanModeInput(text: string): Promise<void> {
    const planMsg: ChatMessage = { role: 'user', content: text, id: this.newMsgId() };
    this.postUser(text, false, planMsg.id);
    this.history.push(planMsg);
    this.traj.addMessage(planMsg, 'user_message');
    this.sessions.saveCurrent(this.history);
    this.postSessionInfo();

    if (this.pendingPlan) {
      // A plan is waiting: yes / no / anything else = modification feedback (spec: "approve? yes/no/modify")
      const t = text.toLowerCase().replace(/[.!\s]+$/g, '');
      if (['yes', 'y', 'ya', 'ok', 'oke', 'approve', 'setuju', 'lanjut'].includes(t)) { await this.handlePlanApproval(['approve']); return; }
      if (['no', 'n', 'tidak', 'reject', 'batal'].includes(t))                           { await this.handlePlanApproval(['reject']); return; }
      await this.handlePlanApproval(['modify', ...text.split(/\s+/)]);
      return;
    }
    await this.doPlan(text);
  }

  // ── Restore points (shadow git) ───────────────────────────────
  private shadow!: ShadowGit;
  private restoreCardId = '';
  private restoreTarget = '';

  private snapLock: Promise<unknown> = Promise.resolve();
  private newMsgId(): string { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

  private async takeRestorePoint(msg: ChatMessage): Promise<void> {
    if (!msg.id) return;
    const label = 'before: ' + msg.content.split('\n[Attached image analysis')[0].replace(/\s+/g, ' ').slice(0, 80);
    const job = this.snapLock.then(() => this.shadow.snapshot(label));   // parallel runs must not fight over git's index lock
    this.snapLock = job.catch(() => undefined);
    const sha = await job;
    if (sha) this.sessions.addSnap(msg.id, sha);
  }

  /** Restore icon on a user message: offer to roll back the code and/or the conversation to before it. */
  private async requestRestore(id: string): Promise<void> {
    if (this.running) { this.showInfo('Stop the current run before restoring.'); return; }
    const idx = this.history.findIndex(m => m.id === id);
    const sha = this.sessions.snapFor(id);
    if (idx < 0 && !sha) { this.showInfo('This message is no longer part of the conversation, so there is nothing to restore.'); return; }

    const changes = sha ? await this.shadow.changesSince(sha) : [];
    const word: Record<string, string> = { M: 'modified', A: 'created', D: 'deleted' };
    const list = changes.slice(0, 8).map(c => `${(word[c.status] ?? c.status).padEnd(8)} ${c.file}`).join('\n') +
      (changes.length > 8 ? `\n… and ${changes.length - 8} more` : '');
    const detail = !sha
      ? 'No code restore point exists for this message, so only the conversation can be restored.'
      : changes.length
        ? `${changes.length} file${changes.length > 1 ? 's' : ''} changed since this message:\n${list}`
        : 'No file changes since this message.';

    const options: Array<{ value: string; label: string; hint?: string }> = [];
    if (sha) options.push({ value: 'both', label: 'Restore code and conversation' });
    if (idx >= 0) options.push({ value: 'chat', label: 'Restore conversation', hint: '(keep the files as they are)' });
    if (sha) options.push({ value: 'code', label: 'Restore code', hint: '(keep the conversation)' });

    this.restoreTarget = id;
    this.restoreCardId = 'restore:' + Date.now().toString(36);
    this.post({
      type: 'choiceCard', id: this.restoreCardId, icon: 'restore', title: 'Restore to before this message?', detail, options
    });
  }

  private async answerRestoreCard(value: string): Promise<void> {
    const id = this.restoreTarget;
    this.restoreTarget = '';
    const done = (label: string) => this.post({ type: 'cardResolved', id: this.restoreCardId, label });
    if (!id || (value !== 'both' && value !== 'chat' && value !== 'code')) { done('Restore cancelled'); return; }
    if (this.running) { done('Restore cancelled — a run is in progress'); return; }

    let fileNote = '';
    if (value === 'both' || value === 'code') {
      const sha = this.sessions.snapFor(id);
      if (!sha) { done('No code restore point for this message'); return; }
      try {
        const r = await this.shadow.restore(sha);
        fileNote = `${r.changed} file${r.changed === 1 ? '' : 's'} restored` + (r.safety ? ` (backup snapshot ${r.safety.slice(0, 7)} kept)` : '');
      } catch (e) {
        done(`Restore failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }

    if (value === 'both' || value === 'chat') {
      const idx = this.history.findIndex(m => m.id === id);
      if (idx >= 0) {
        const original = this.history[idx].content.split('\n[Attached image analysis')[0];
        this.history = this.history.slice(0, idx);
        this.traj.setMessages(this.history);
        this.sessions.saveCurrent(this.history);
        this.pendingPlan = null;
        this.post({ type: 'clearChat' });
        if (this.history.length) this.post({ type: 'history', messages: this.history });
        this.post({ type: 'setInput', text: original });   // edit and resend, like a rewind
        this.postSessionInfo();
        this.post({
          type: 'systemMessage',
          text: `↩ Restored to before that message${fileNote ? ' — ' + fileNote : ''}. Your message is back in the input box.`
        });
        return;
      }
    }
    done(`↩ ${fileNote || 'Done'}`);
  }

  // ── @file mentions ────────────────────────────────────────────
  private fileIndex: Array<{ path: string; dir: boolean }> = [];
  private fileIndexAt = 0;

  /** Workspace files plus the folders that contain them (folders end with "/"). */
  private async getFileIndex(): Promise<Array<{ path: string; dir: boolean }>> {
    if (Date.now() - this.fileIndexAt > 30_000 || !this.fileIndex.length) {
      const uris = await vscode.workspace.findFiles(
        '**/*', '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.rag/**}', 5000);
      const files = uris.map(u => vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/'));
      const dirs = new Set<string>();
      for (const f of files) {
        const parts = f.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
      }
      this.fileIndex = [
        ...[...dirs].map(path => ({ path, dir: true })),
        ...files.map(path => ({ path, dir: false }))
      ];
      this.fileIndexAt = Date.now();
    }
    return this.fileIndex;
  }

  /** Entries matching what the user typed after "@": a folder's children, or ranked name / path / fuzzy matches. */
  private async searchFiles(query: string): Promise<Array<{ path: string; dir: boolean }>> {
    const all = await this.getFileIndex();
    const q = query.toLowerCase().replace(/\\/g, '/');
    const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
    const depth = (p: string) => p.replace(/\/$/, '').split('/').length;

    if (!q) return [...all].filter(e => depth(e.path) <= 2).sort(byPath).slice(0, 10);

    if (q.endsWith('/')) {              // browsing into a folder: show its direct children
      return all.filter(e => e.path.toLowerCase().startsWith(q) && e.path.length > q.length && depth(e.path) === depth(q) + 1)
        .sort(byPath).slice(0, 12);
    }

    const subsequence = (s: string) => { let i = 0; for (const c of s) if (c === q[i]) i++; return i === q.length; };
    const scored: Array<{ e: { path: string; dir: boolean }; s: number }> = [];
    for (const e of all) {
      const lower = e.path.toLowerCase();
      const base  = lower.replace(/\/$/, '').split('/').pop() ?? '';
      let s = 0;
      if (base === q) s = 100;
      else if (base.startsWith(q)) s = 80;
      else if (base.includes(q)) s = 60;
      else if (lower.includes(q)) s = 40;
      else if (subsequence(lower)) s = 20;
      if (s) scored.push({ e, s: s - Math.min(e.path.length, 80) / 100 });
    }
    return scored.sort((a, b) => b.s - a.s).slice(0, 10).map(x => x.e);
  }

  /** Reads files referenced as @path in the message so the model sees them for this turn only. */
  private async resolveMentions(text: string): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return '';
    const seen = new Set<string>();
    const blocks: string[] = [];
    for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
      const rel = m[1].replace(/[),.;:!?]+$/, '');
      if (seen.has(rel) || seen.size >= 5) continue;
      seen.add(rel);
      try {
        const uri = vscode.Uri.joinPath(root, rel);
        if (!uri.fsPath.toLowerCase().startsWith(root.fsPath.toLowerCase())) continue; // stay inside the workspace
        const stat = await vscode.workspace.fs.stat(uri);
        if (!(stat.type & vscode.FileType.File)) continue;
        const content = await this.readText(uri);
        if (content !== undefined) blocks.push(`<file path="${rel}">\n${content}\n</file>`);
      } catch { /* not a workspace file: leave the @text as plain text */ }
    }
    return blocks.length ? `\n\n[Files mentioned with @]\n${blocks.join('\n\n')}` : '';
  }

  // ── "+" menu: add context / browse the web ───────────────────
  // Both end up as pinned context (shown in the Pinned Context panel and sent with every request).
  private pin(label: string, content: string): void {
    const short = label.length > 50 ? '…' + label.slice(-49) : label;
    this.post({ type: 'addPin', label: short, content });
  }

  private async readText(uri: vscode.Uri): Promise<string | undefined> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > 300_000 || bytes.includes(0)) return undefined; // too large or binary
    return Buffer.from(bytes).toString('utf8').slice(0, 60_000);
  }

  private async addContext(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    const rel = (u: vscode.Uri) => vscode.workspace.asRelativePath(u);
    const items: Array<vscode.QuickPickItem & { id: 'file' | 'selection' | 'files' }> = [];
    if (ed) {
      items.push({ id: 'file', label: '$(file) Active file', description: rel(ed.document.uri) });
      if (!ed.selection.isEmpty) {
        const n = ed.selection.end.line - ed.selection.start.line + 1;
        items.push({ id: 'selection', label: '$(selection) Current selection', description: `${n} line${n > 1 ? 's' : ''}` });
      }
    }
    items.push({ id: 'files', label: '$(files) Choose files…', description: 'Search the workspace' });

    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Add context' });
    if (!pick) return;

    if (pick.id === 'file' && ed) {
      this.pin(rel(ed.document.uri), ed.document.getText().slice(0, 60_000));
    } else if (pick.id === 'selection' && ed) {
      const s = ed.selection;
      this.pin(`${rel(ed.document.uri)}:${s.start.line + 1}-${s.end.line + 1}`, ed.document.getText(s));
    } else if (pick.id === 'files') {
      const found = await vscode.workspace.findFiles(
        '**/*', '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**}', 500);
      const files = await vscode.window.showQuickPick(
        found.map(u => ({ label: rel(u), uri: u })).sort((a, b) => a.label.localeCompare(b.label)),
        { canPickMany: true, matchOnDescription: true, placeHolder: 'Select files to add as context' });
      const skipped: string[] = [];
      for (const f of files ?? []) {
        const text = await this.readText(f.uri);
        if (text === undefined) skipped.push(f.label); else this.pin(f.label, text);
      }
      if (skipped.length) this.showInfo(`Skipped (binary or over 300 KB): ${skipped.join(', ')}`);
    }
  }

  private async browseWeb(): Promise<void> {
    const raw = await vscode.window.showInputBox({
      prompt: 'Enter a URL to read, or a search query',
      placeHolder: 'https://example.com/docs  or  how to center a div'
    });
    const input = raw?.trim();
    if (!input) return;

    const looksLikeUrl = /^https?:\/\/\S+$/i.test(input) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(input);
    const url = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    this.showInfo(looksLikeUrl ? `🌐 Fetching ${url}…` : `🌐 Searching the web for "${input}"…`);

    const res = looksLikeUrl
      ? await this.tools.run({ name: 'web_fetch',  arguments: { url, max_chars: 12000 } })
      : await this.tools.run({ name: 'web_search', arguments: { query: input, max_results: 8 } });

    if (!res.ok) { this.post({ type: 'error', text: res.output }); return; }
    this.pin(looksLikeUrl ? `🌐 ${url.replace(/^https?:\/\//i, '')}` : `🌐 search: ${input}`, res.output);
  }

  // ── Permission modes ─────────────────────────────────────────
  // manual: ask before every edit/command · edit: edits auto, ask for commands · plan: read-only ·
  // auto: edits auto, commands pass through PolicyGuardian, ask only for destructive actions.
  private postMode(): void {
    this.post({ type: 'mode', mode: this.mode });
  }

  private setMode(m: string): void {
    if (m !== 'manual' && m !== 'edit' && m !== 'plan' && m !== 'research' && m !== 'auto') return;
    this.mode = m;
    void this.ctx.globalState.update('ragAssistant.mode', m);
    this.postMode();
  }

  /** Returns null if the tool may run, otherwise the message to hand back to the model. */
  private async gateTool(name: string, args: Record<string, unknown>): Promise<string | null> {
    const isMcp = this.mcp.isMCPTool(name);
    const kind: 'safe' | 'edit' | 'exec' | 'destructive' =
      ChatProvider.DESTRUCTIVE_TOOLS.has(name) ? 'destructive' :
      ChatProvider.EDIT_TOOLS.has(name)        ? 'edit' :
      (ChatProvider.EXEC_TOOLS.has(name) || isMcp) ? 'exec' : 'safe';
    if (kind === 'safe') return null;

    if (this.mode === 'plan' || this.mode === 'research') {
      return `${this.mode === 'plan' ? 'Plan' : 'Research'} mode is on, so "${name}" was NOT run. Do not modify files or run commands; ` +
             `explore with read-only tools and report what you found.`;
    }

    let ask: boolean;
    switch (this.mode) {
      case 'manual': ask = true; break;
      case 'edit':   ask = kind !== 'edit'; break;
      default:       ask = kind === 'destructive'; break;   // auto
    }
    if (!ask) return null;

    // "Always allow" is never offered for destructive tools or compound shell commands.
    const key = kind === 'destructive' ? null : this.permissionKey(name, args);
    if (key && (this.allowList('project').includes(key) || this.allowList('global').includes(key))) return null;

    const reply = await this.requestPermission(name, args, key);
    const resolved = (label: string) => this.post({ type: 'cardResolved', id: reply.id, label });

    switch (reply.choice) {
      case 'project': if (key) await this.addAllow('project', key); resolved(`✓ Allowed — always allow '${key}' in this project`); return null;
      case 'global':  if (key) await this.addAllow('global', key);  resolved(`✓ Allowed — always allow '${key}'`);            return null;
      case 'once':    resolved('✓ Allowed this time'); return null;
      case 'no': {
        const fb = reply.feedback?.trim();
        resolved(fb ? `✕ Denied — "${fb}"` : '✕ Denied');
        return fb
          ? `The user denied this action and said: "${fb}". Do not run it; do what they asked instead.`
          : 'The user denied this action. Do not retry it; ask how they would like to proceed.';
      }
      default:
        resolved('Skipped');
        return 'The user skipped this action. Do not retry it; continue without it or ask how to proceed.';
    }
  }

  // ── In-chat permission cards ─────────────────────────────────
  private pendingPerms = new Map<string, (r: { choice: string; feedback?: string }) => void>();

  /** What "always allow" remembers: the executable of a simple shell command, or the tool name. */
  private permissionKey(name: string, args: Record<string, unknown>): string | null {
    if (name !== 'run_command') return name;
    const cmd = String(args.command ?? '').trim();
    if (!cmd || /[;&|<>`$()\n]/.test(cmd)) return null;                 // compound command: ask every time
    const first = cmd.split(/\s+/)[0].replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
    return first || null;
  }

  private allowList(scope: 'project' | 'global'): string[] {
    return (scope === 'project' ? this.ctx.workspaceState : this.ctx.globalState)
      .get<string[]>(scope === 'project' ? 'ragAssistant.allow' : 'ragAssistant.allowGlobal') ?? [];
  }

  private async addAllow(scope: 'project' | 'global', key: string): Promise<void> {
    const list = this.allowList(scope);
    if (list.includes(key)) return;
    await (scope === 'project' ? this.ctx.workspaceState : this.ctx.globalState)
      .update(scope === 'project' ? 'ragAssistant.allow' : 'ragAssistant.allowGlobal', [...list, key]);
  }

  private requestPermission(
    name: string, args: Record<string, unknown>, key: string | null
  ): Promise<{ id: string; choice: string; feedback?: string }> {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const detail = String(args.command ?? args.path ?? args.source ?? JSON.stringify(args)).slice(0, 800);
    const options: Array<{ value: string; label: string; hint?: string; input?: string }> = [
      { value: 'once', label: 'Yes, allow this time' }
    ];
    if (key) {
      options.push({ value: 'project', label: `Yes, and always allow '${key}' in this project` });
      options.push({ value: 'global',  label: `Yes, and always allow '${key}'` });
    }
    options.push({ value: 'no', label: 'No', hint: '(tell the agent what to do instead)', input: 'Tell the agent what to do instead' });
    this.post({
      type: 'choiceCard', id, detail, options, icon: name === 'run_command' ? 'terminal' : 'file',
      title: `Allow ${String(args.description ?? name.replace(/_/g, ' '))}?`
    });
    return new Promise(resolve => {
      this.pendingPerms.set(id, r => { this.pendingPerms.delete(id); resolve({ id, ...r }); });
    });
  }

  /** Stop / new chat / webview reload: never leave the agent waiting on a card nobody can answer. */
  private cancelPermissions(): void {
    for (const answer of [...this.pendingPerms.values()]) answer({ choice: 'skip' });
  }

  private showPermissions(args: string): void {
    if (args.trim().toLowerCase() === 'clear') {
      void this.ctx.workspaceState.update('ragAssistant.allow', []);
      void this.ctx.globalState.update('ragAssistant.allowGlobal', []);
      this.showInfo('Cleared all "always allow" permissions.');
      return;
    }
    const p = this.allowList('project'), g = this.allowList('global');
    this.post({
      type: 'systemMessage',
      text: `## Permissions\n**This project:** ${p.length ? p.map(k => `\`${k}\``).join(', ') : '_none_'}\n\n` +
            `**Everywhere:** ${g.length ? g.map(k => `\`${k}\``).join(', ') : '_none_'}\n\n_Use \`/permissions clear\` to reset._`
    });
  }

  private static readonly EDIT_TOOLS = new Set([
    'create_file', 'edit_file', 'insert_at_line', 'apply_diff', 'move_file', 'write_blob', 'edit_notebook'
  ]);
  private static readonly REVIEWED_TOOLS = new Set(['create_file', 'edit_file', 'insert_at_line', 'apply_diff']);
  private static readonly DESTRUCTIVE_TOOLS = new Set([
    'delete_file', 'delete_directory', 'git_commit', 'deploy_firebase', 'cloud_sql_execute_sql', 'post_pr_review'
  ]);
  private static readonly EXEC_TOOLS = new Set([
    'run_command', 'send_command_input', 'execute_notebook', 'execute_browser_javascript', 'restart_dev_server',
    'set_up_firebase', 'set_up_cloud_sql'
  ]);

  // Voice input: webviews cannot reach the microphone, so toggle Windows Voice Typing (Win+H),
  // which dictates into the focused input box in the system's configured language.
  private async toggleVoiceTyping(): Promise<void> {
    const info = (text: string) => this.post({ type: 'systemMessage', text });
    if (process.platform !== 'win32') {
      info('🎤 Voice input uses Windows Voice Typing. On this OS, use your system dictation shortcut while the input box is focused.');
      return;
    }
    const script =
      `Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);';` +
      `Start-Sleep -Milliseconds 200;` +
      `[W.K]::keybd_event(0x5B,0,0,[UIntPtr]::Zero);[W.K]::keybd_event(0x48,0,0,[UIntPtr]::Zero);` +
      `[W.K]::keybd_event(0x48,0,2,[UIntPtr]::Zero);[W.K]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, err => {
      if (err) info('🎤 Could not start Voice Typing automatically. Click the input box and press Win+H.');
    });
  }

  /** Transcribes voice messages with an audio model, so a model that cannot hear still gets what was said. */
  private async describeAudio(
    listener: ModelConfig, active: ModelConfig, activeKey: string, clips: Array<{ data: string; format: string }>
  ): Promise<string> {
    let key = await this.registry.getApiKey(listener.id);
    if (!key && listener.baseUrl === active.baseUrl) key = activeKey;
    const msgs: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are the hearing module of a coding assistant. Transcribe the voice message word for word in the language it is spoken. ' +
                 'Add a short note only for things that change the meaning (tone, hesitation, background sounds). ' +
                 'Do not answer or perform what the speaker asks; another model will do that.'
      },
      { role: 'user', content: 'Transcribe the attached voice message.', audio: clips }
    ];
    let out = '';
    let err = '';
    await this.llm.streamChat(listener, key, msgs, { maxTokens: 2048, temperature: 0.1 }, c => {
      if (c.type === 'delta' && c.content) out += c.content;
      else if (c.type === 'error') err = c.error ?? 'stream error';
    });
    if (!out.trim()) throw new Error(err || 'empty response');
    return out.trim();
  }

  private async describeImages(
    vision: ModelConfig, active: ModelConfig, activeKey: string, request: string, images: string[]
  ): Promise<string> {
    let key = await this.registry.getApiKey(vision.id);
    if (!key && vision.baseUrl === active.baseUrl) key = activeKey; // same provider, same key

    const msgs: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are the vision module of a coding assistant. Report only what is visible: all text verbatim, ' +
                 'layout, UI components, colors (approximate hex), errors or warnings, and any code. ' +
                 'Do not perform the user\'s task and do not write code; another model will do that.'
      },
      { role: 'user', content: `The user will ask: "${request}"\nDescribe the attached image(s) with the details needed for that.`, images }
    ];

    let out = '';
    let err = '';
    await this.llm.streamChat(vision, key, msgs, { maxTokens: 2048, temperature: 0.2 }, c => {
      if (c.type === 'delta' && c.content) out += c.content;
      else if (c.type === 'error') err = c.error ?? 'stream error';
    });
    if (!out.trim()) throw new Error(err || 'empty response');
    return out.trim();
  }

  // ── Main agentic chat loop (CortexStep-style) ─────────────────
  private async doChat(text: string, systemOverride?: string, shown?: string): Promise<void> {
    if (!text.trim()) return;
    // Already inside a run (plan approval, plan-mode "yes"…): carry on in that run
    if (this.run.real) { await this.doChatInner(text, systemOverride, shown); return; }
    const model  = this.registry.getActiveModel();
    const images = this.pendingImages; this.pendingImages = [];     // attachments belong to this message, even if it has to wait
    const audio  = this.pendingAudio;  this.pendingAudio  = [];
    await this.schedule({
      kind: 'chat', modelId: model?.id ?? '', model, text, shown, images, audio, msgId: this.newMsgId(),
      fn: () => this.doChatInner(text, systemOverride, shown)
    });
  }

  /** Plan / research / battle entry points: inside a run they just run; from outside they wait their turn. */
  private async withRun(fn: () => Promise<void>): Promise<void> {
    if (this.run.real) { await fn(); return; }
    await this.schedule({ kind: 'exclusive', modelId: '', text: '', fn });
  }

  // ── Scheduler: same model = queue, different model = parallel ─────────────
  private newRunId(): string { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

  private configureLlm(c: LLMClient): void {
    const cfg = vscode.workspace.getConfiguration('ragAssistant');
    c.onUsage              = (m, p, o) => this.analytics.usage(m, p, o);
    c.openRouterReferer    = cfg.get<string>('openRouterAppUrl') || undefined;
    c.openRouterCategories = cfg.get<string>('openRouterCategories') || undefined;
  }

  /** Tags the message with the run that produced it, so the chat puts it under the right user message. */
  private post(msg: Record<string, unknown>): void {
    const r = this.run;
    this.view?.webview.postMessage(r.real && msg.runId === undefined ? { ...msg, runId: r.id } : msg);
  }

  /** The user's card for the current run: shown once, however many code paths ask for it. */
  private postUser(text: string, hasImages: boolean, id?: string): void {
    const r = this.run;
    if (r.real) { if (r.userPosted) return; r.userPosted = true; }
    this.post({ type: 'userMessage', text, hasImages, id });
  }

  private postRunState(): void {
    this.view?.webview.postMessage({ type: 'runState', running: this.activeRuns.size > 0, active: this.activeRuns.size, queued: this.queue.length });
  }

  private canStart(q: QueuedRun): boolean {
    if (q.kind === 'exclusive') return this.activeRuns.size === 0;
    for (const r of this.activeRuns.values()) if (r.kind === 'exclusive' || r.modelId === q.modelId) return false;
    return true;
  }

  private schedule(it: Omit<QueuedRun, 'id' | 'resolve' | 'preposted'>): Promise<void> {
    return new Promise<void>(resolve => {
      const q: QueuedRun = { ...it, id: this.newRunId(), resolve, preposted: false };
      this.queue.push(q);
      this.drain();
      if (!this.queue.includes(q)) return;                         // it started right away
      // Has to wait: put the user's card in the chat now, marked as queued
      q.preposted = true;
      if (q.text) this.view?.webview.postMessage({ type: 'userMessage', text: q.shown ?? q.text, hasImages: !!q.images?.length, id: q.msgId, runId: q.id });
      const blocker = [...this.activeRuns.values()].find(r => r.kind === 'exclusive' || r.modelId === q.modelId);
      const name = blocker?.model?.name;
      this.view?.webview.postMessage({
        type: 'queued', runId: q.id,
        text: q.kind === 'chat' && name ? `Queued — runs after the current ${name} task` : 'Queued — runs when the current task finishes'
      });
      this.postRunState();
    });
  }

  /** Starts every queued message that may start now, in order; a message never overtakes an earlier one for the same model. */
  private drain(): void {
    const blocked = new Set<string>();
    let blockAll = false;
    for (const q of [...this.queue]) {
      if (blockAll) break;
      if (!blocked.has(q.modelId) && this.canStart(q)) {
        this.queue.splice(this.queue.indexOf(q), 1);
        this.startRun(q);
        if (q.kind === 'exclusive') blockAll = true;
      } else {
        blocked.add(q.modelId);
        if (q.kind === 'exclusive') blockAll = true;
      }
    }
  }

  private startRun(q: QueuedRun): void {
    const llm = new LLMClient();
    this.configureLlm(llm);
    const ctx: RunCtx = {
      id: q.id, real: true, kind: q.kind, modelId: q.modelId, model: q.model, llm, stop: false, outcome: 'done', tools: 0,
      streaming: false, userPosted: q.preposted, msgId: q.msgId, images: q.images, audio: q.audio
    };
    this.activeRuns.set(ctx.id, ctx);
    const startedAt = Date.now();
    this.postRunState();
    void this.als.run(ctx, async () => {
      this.view?.webview.postMessage({ type: 'runStarted', runId: ctx.id });
      try {
        await q.fn();
      } catch (e) {
        ctx.outcome = 'error';
        this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
      } finally {
        ctx.streaming = false;
        this.analytics.run(this.mode, ctx.stop ? 'stopped' : ctx.outcome);
        this.sessions.saveCurrent(this.history);
        this.postSessionInfo();
        this.post({ type: 'runDone', status: ctx.stop ? 'stopped' : ctx.outcome, ms: Date.now() - startedAt, tools: ctx.tools });
      }
    }).then(() => {
      this.activeRuns.delete(ctx.id);
      this.postRunState();
      q.resolve();
      this.drain();
    });
  }

  private cancelQueued(runId: string): void {
    const i = this.queue.findIndex(q => q.id === runId);
    if (i < 0) return;
    const [q] = this.queue.splice(i, 1);
    this.view?.webview.postMessage({ type: 'queueCancelled', runId });
    q.resolve();
    this.postRunState();
  }

  /** Stop button: ends every running task and drops everything that was waiting. */
  private stopAll(): void {
    for (const r of this.activeRuns.values()) { r.stop = true; r.llm.abortAll(); }
    for (const q of this.queue.splice(0)) { this.view?.webview.postMessage({ type: 'queueCancelled', runId: q.id }); q.resolve(); }
    this.cancelPermissions();
    this.postRunState();
  }

  private async doChatInner(text: string, systemOverride?: string, shown?: string): Promise<void> {
    if (!text.trim()) return;
    const bubble = shown ?? text;          // what the user's card in the chat says

    const model = this.run.model ?? this.registry.getActiveModel();
    if (!model) {
      this.runOutcome = 'error';
      this.post({ type: 'error', text: 'No model configured. Click + to add a model.' });
      return;
    }

    const cfg  = vscode.workspace.getConfiguration('ragAssistant');
    const maxT = cfg.get<number>('maxTokens')   ?? 8192;
    const temp = cfg.get<number>('temperature') ?? 0.7;

    // Build system prompt via PromptAssembler (7 layers)
    let sysPrompt: string;
    if (systemOverride) {
      sysPrompt = systemOverride;
    } else {
      sysPrompt = await this.assembler.buildSystemPrompt(text, {
        role:        this.activeRole,
        includeRAG:  this.ragEnabled,
        includeFile: true,
        includeDiag: true
      });
    }

    // Attach pending images if any
    const userMsg: ChatMessage = { role: 'user', content: text, id: this.run.msgId ?? this.newMsgId() };
    const apiKey  = await this.registry.getApiKey(model.id);
    let hadImages = false;
    let posted    = false;      // the user's message is already on screen
    const imagesIn = this.run.images ?? this.pendingImages;
    if (this.run.images === undefined) this.pendingImages = [];
    if (imagesIn.length) {
      const images = [...imagesIn];
      hadImages = true;
      this.post({ type: 'imageAdded', count: 0 });

      // Images are analyzed by the vision model (Gemma 4); the selected model still writes the reply.
      const vision = this.registry.getVisionModel();
      if (vision && vision.id !== model.id) {
        this.streaming = true;
        posted = true;
        this.postUser(bubble, true, userMsg.id);
        this.post({ type: 'systemMessage', text: `🖼 Analyzing image with **${vision.name}**, reply will use **${model.name}**…` });
        try {
          const analysis = await this.describeImages(vision, model, apiKey, text, images);
          userMsg.content = `${text}\n\n[Attached image analysis by ${vision.name}]\n${analysis}`;
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          this.post({ type: 'error', text: `Image analysis failed (${vision.name}): ${m}` });
          userMsg.content = `${text}\n\n[An image was attached but could not be analyzed: ${m}]`;
        }
      } else {
        userMsg.images = images;
      }
    }
    // Voice messages: an audio model listens directly; any other model gets what the audio model heard.
    let turnAudio: Array<{ data: string; format: string }> | undefined;
    const audioIn = this.run.audio ?? this.pendingAudio;
    if (this.run.audio === undefined) this.pendingAudio = [];
    if (audioIn.length) {
      const clips = [...audioIn];
      this.post({ type: 'audioAdded', count: 0 });
      if (model.audio) {
        turnAudio = clips;
        userMsg.content = `${text}\n\n[Voice message attached: listen to it and respond to what it says.]`;
      } else {
        const listener = this.registry.getAudioModel();
        if (!listener) {
          userMsg.content = `${text}\n\n[A voice message was attached but no audio model is configured. Set "audio": true on a model in ragAssistant.models.]`;
          this.post({ type: 'error', text: 'No audio model configured: add "audio": true to a model in ragAssistant.models (e.g. Gemma 4 26B).' });
        } else {
          this.streaming = true;
          if (!posted) { posted = true; this.postUser(bubble, !!userMsg.images?.length, userMsg.id); }
          this.post({ type: 'systemMessage', text: `🎤 Listening with **${listener.name}**, reply will use **${model.name}**…` });
          try {
            const heard = await this.describeAudio(listener, model, apiKey, clips);
            userMsg.content = `${text}\n\n[Voice message transcript by ${listener.name}]\n${heard}`;
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            this.post({ type: 'error', text: `Could not listen to the voice message (${listener.name}): ${m}` });
            userMsg.content = `${text}\n\n[A voice message was attached but could not be transcribed: ${m}]`;
          }
        }
      }
    }
    this.history.push(userMsg);
    this.traj.addMessage(userMsg, 'user_message');
    this.sessions.saveCurrent(this.history);
    this.postSessionInfo();
    if (!posted) {
      this.postUser(bubble, !!userMsg.images?.length, userMsg.id);
    }
    await this.takeRestorePoint(userMsg);   // state of the workspace before this message's changes
    this.streaming = true;

    // Research tools are read-only, so every chat mode gets them: Auto researches on its own when it needs to
    const allToolDefs = [...TOOL_DEFS, ...RESEARCH_TOOL_DEFS, ...this.mcp.getToolDefs()];

    // Inject pinned context into system prompt
    if (this.pinnedContext.size > 0) {
      const pinned = [...this.pinnedContext.entries()]
        .map(([label, content]) => `[Pinned: ${label}]\n${content}`)
        .join('\n\n');
      sysPrompt = sysPrompt
        ? `${sysPrompt}\n\n<pinned_context>\n${pinned}\n</pinned_context>`
        : `<pinned_context>\n${pinned}\n</pinned_context>`;
    }

    sysPrompt += `\n\n<environment>OS: ${process.platform}. run_command shell: ${SHELL_LABEL}. ` +
      `Workspace root (current directory for commands): ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '(none)'}.</environment>` +
      `\n\n<research>You can research on your own. When the task involves a library, API or pattern you are unsure about ` +
      `or have no reference for in the workspace, look it up BEFORE writing code: package_info and google_search for the ` +
      `documentation of a dependency; github_fetch_top_repositories to download the most starred reference repositories ` +
      `(3 by default; if the user asks for another number, such as 10, pass exactly that as count) ` +
      `and then study them LOCALLY under .rag/references with grep_search / view_file (github_* file tools are only for a quick peek). ` +
      `list_directory / view_file read LOCAL files only. Research only what the task needs, briefly, then continue the task. ` +
      `For a larger, deliberate investigation the user can switch to Research mode, which writes Research.md.</research>` +
      `\n\n<bug-fixing>Errors are yours to fix, not to report. When a command, build or test fails, or an edit leaves [LINT] errors: ` +
      `read the real error output, locate the cause in the code it points to, fix it, then run the same command again, and repeat until it passes. ` +
      `Never end your turn on a failing command or on files with errors. Builds can be slow: pass a larger timeout (up to 600000 ms) or background:true for ` +
      `cargo/npm/gradle. After editing code, check get_diagnostics. If you are truly blocked, say exactly what is wrong and what you need.</bug-fixing>` +
      `\n\n<answering>Always answer the user's LAST message, and only that one. Earlier requests that were interrupted ` +
      `are not to be resumed unless the user asks. When the last message includes an image analysis, base your answer on it.</answering>`;
    if (this.mode === 'plan') {
      sysPrompt +='\n\n<mode>PLAN MODE: do not modify files or run commands. Explore with read-only tools, ' +
        'then present a clear step-by-step plan and wait for the user to approve it.</mode>';
    }

    // Auto-truncate history to fit context window
    // Only the message being sent right now may carry images; replaying old ones makes
    // non-vision models fail with "this model does not support image input".
    const lastIdx = this.history.length - 1;
    const mentioned = await this.resolveMentions(text); // @file contents, for this turn only (history stays clean)
    const rawMessages: ChatMessage[] = [
      ...(sysPrompt ? [{ role: 'system' as const, content: sysPrompt }] : []),
      ...this.history.flatMap((m, i): ChatMessage[] => {
        const cur: ChatMessage = i === lastIdx
          ? { ...m, ...(mentioned ? { content: m.content + mentioned } : {}), ...(turnAudio ? { audio: turnAudio } : {}) }
          : (m.images ? { role: m.role, content: m.content } : m);
        // Two user messages in a row mean the earlier run was interrupted (Stop, error, reload) and never answered.
        // Say so explicitly, otherwise the model tends to answer the older, bigger request instead of the last one.
        if (m.role === 'user' && i > 0 && this.history[i - 1].role === 'user') {
          return [{ role: 'assistant', content: '(That request was interrupted before I could answer it. I will not resume it unless asked.)' }, cur];
        }
        return [cur];
      })
    ];
    const cfg2  = vscode.workspace.getConfiguration('ragAssistant');
    const ctxWin = cfg2.get<number>('contextWindow') ?? 24000;
    const messages = truncateHistory(rawMessages, ctxWin);

    // Show token usage estimate
    const tokenEst = estimateTokens(messages);
    this.lastCtx = { tokens: tokenEst, max: ctxWin };
    this.post({ type: 'tokenUsage', tokens: tokenEst, max: ctxWin });

    // Auto-checkpoint at 85% token capacity
    if (tokenEst >= ctxWin * 0.85) {
      await this.autoCheckpoint(model, apiKey, messages, maxT, temp);
    }

    // ── Agentic loop ───────────────────────────────────────────
    // Bug-fix state (spec §8): the run is not finished while the last command failed or its own edits left errors.
    let lastFailure: { tool: string; output: string } | null = null;
    let nudges = 0;
    const editedFiles = new Set<string>();
    const lintDepth   = new Map<string, number>();
    let hitCap = false;
    const failStreak = new Map<string, number>();
    let loopBreak = false;
    let emptyReplies = 0;
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      let accumulated = '';
      const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

      this.post({ type: 'streamStart', model: model.name, iteration: iter });

      try {
        await this.llm.streamChat(
          model, apiKey, messages,
          { maxTokens: maxT, temperature: temp, tools: allToolDefs },
          chunk => {
            if (chunk.type === 'delta' && chunk.content) {
              accumulated += chunk.content;
              this.post({ type: 'streamDelta', content: chunk.content });
              // Realtime token counter update during streaming
              const liveTokens = tokenEst + Math.ceil(accumulated.length / 4);
              this.post({ type: 'tokenUsage', tokens: liveTokens, max: ctxWin });
            } else if (chunk.type === 'toolCall') {
              toolCalls.push({ name: chunk.toolName!, args: chunk.toolArgs ?? {} });
            } else if (chunk.type === 'error') {
              this.runOutcome = 'error';
              this.post({ type: 'error', text: chunk.error ?? 'Stream error' });
            }
          }
        );
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        this.runOutcome = 'error';
        this.post({ type: 'error', text: m });
        break;
      }

      if (this.stopRequested) {
        this.post({ type: 'streamEnd' });
        if (accumulated) this.history.push({ role: 'assistant', content: accumulated });
        this.post({ type: 'systemMessage', text: '⏹ Stopped.' });
        break;
      }

      // The model answered with nothing: never end on a silent "Done"
      if (!toolCalls.length && !accumulated.trim()) {
        this.post({ type: 'streamEnd' });
        if (this.runOutcome !== 'error') {
          if (emptyReplies < 1) {
            emptyReplies++;
            if (iter > 0) messages.push({ role: 'user', content: 'Reply to the user now with a short summary of what you did and the result.' });
            iter--;                                            // an empty answer does not use up a step
            continue;
          }
          this.runOutcome = 'error';
          this.post({ type: 'error', text: `${model.name} returned an empty reply (no text and no tool call). Send the message again, or switch model.` });
        }
        break;
      }

      let cleanText: string | undefined;
      if (!toolCalls.length && accumulated) {
        const known = new Map<string, string[]>();
        for (const d of allToolDefs) {
          const fn = (d as { function?: { name?: string; parameters?: { properties?: Record<string, unknown> } } }).function;
          if (fn?.name) known.set(fn.name, Object.keys(fn.parameters?.properties ?? {}));
        }
        const leaked = extractLeakedToolCalls(accumulated, known);
        if (leaked.calls.length) {
          toolCalls.push(...leaked.calls);
          accumulated = leaked.text;
          cleanText = leaked.text;
        } else if (leaked.unparsed.length) {
          this.post({
            type: 'error',
            text: `Tool call "${leaked.unparsed[0]}" came back malformed or incomplete and could not be recovered. Ask the model to retry.`
          });
        }
      }

      this.post({ type: 'streamEnd', text: cleanText });

      // About to finish: refuse to stop on an unresolved error (spec §8 AutoFixLints, max depth = nudge budget)
      if (!toolCalls.length && nudges < 3 && iter < MAX_TOOL_ITERATIONS - 1) {
        const nudge = this.unresolvedProblem(lastFailure, editedFiles, accumulated);
        if (nudge) {
          nudges++;
          if (accumulated) messages.push({ role: 'assistant', content: accumulated });
          messages.push({ role: 'user', content: nudge });
          this.post({ type: 'systemMessage', text: '🔧 Problem still unresolved — continuing to fix it…' });
          lastFailure = null;
          continue;
        }
      }

      if (accumulated) {
        messages.push({ role: 'assistant', content: accumulated });
        this.traj.addStep('assistant_message', { content: accumulated.slice(0, 200) });
        if (!toolCalls.length) {
          this.history.push({ role: 'assistant', content: accumulated });
          this.traj.addMessage({ role: 'assistant', content: accumulated }, 'assistant_message');
          const files = this.extractFiles(accumulated);
          if (files.length > 0) {
            this.pendingFiles = files;
            this.post({
              type:  'filesDetected',
              files: files.map(f => ({ path: f.filePath, bytes: Buffer.byteLength(f.content) }))
            });
          }
          // KI auto-creation (§22): after substantial responses (>300 chars), extract KIs
          if (accumulated.length > 300 && iter > 0) {
            void this.autoCreateKI(accumulated);
          }
          break;
        }
      } else {
        if (!toolCalls.length) break;
      }

      if (!toolCalls.length) break;

      // ── Execute tool calls ────────────────────────────────────
      const toolResultContent: string[] = [];
      for (const tc of toolCalls) {
        if (this.stopRequested) break;
        this.runTools++;
        this.analytics.tool(tc.name);
        this.post({ type: 'toolCall', name: tc.name, args: tc.args });
        this.traj.addStep('tool_call', { name: tc.name });

        const denied = await this.gateTool(tc.name, tc.args);
        if (denied) {
          this.post({ type: 'toolResult', name: tc.name, ok: false, output: denied });
          this.traj.addStep('tool_result', { name: tc.name, ok: false });
          toolResultContent.push(`[Tool: ${tc.name}]\n${denied}`);
          lastFailure = null;                       // the user said no: that is a decision, not a bug
          continue;
        }

        // Errors the file had BEFORE this edit, so only the ones the edit introduces are reported (LintDiff)
        const editPath = ChatProvider.EDIT_TOOLS.has(tc.name) ? String(tc.args.path ?? tc.args.file_path ?? '') : '';
        const errorsBefore = editPath ? this.fileErrors(editPath) : null;
        // The file as it was, so what the agent changes can be marked in the editor and accepted or reverted per hunk
        const reviewed = editPath && ChatProvider.REVIEWED_TOOLS.has(tc.name);
        let textBefore: string | undefined;
        if (reviewed) { try { textBefore = fs.readFileSync(this.fileUri(editPath).fsPath, 'utf8'); } catch { /* new file */ } }

        // Capture pre-edit state for revert (§7)
        if (tc.name === 'edit_file' && tc.args.path) {
          try {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const fp   = require('path').isAbsolute(String(tc.args.path))
              ? String(tc.args.path)
              : require('path').join(root, String(tc.args.path));
            const before = require('fs').readFileSync(fp, 'utf8') as string;
            this.traj.recordFileChange(String(tc.args.path), before);
          } catch { /* file may not exist yet */ }
        }

        let result;
        if (this.mcp.isMCPTool(tc.name)) {
          try {
            const out = await this.mcp.callTool(tc.name, tc.args);
            result    = { toolName: tc.name, ok: true, output: out };
          } catch (e) {
            result    = { toolName: tc.name, ok: false, output: `Error: ${e}` };
          }
        } else if (tc.name === 'edit_file' && tc.args.path && tc.args.old_str !== undefined) {
          // FastApply (§7): route edit_file through fast model if configured
          const cfg = vscode.workspace.getConfiguration('ragAssistant');
          const fastModelId = cfg.get<string>('fastApplyModel') ?? '';
          if (fastModelId) {
            const faResult = await this.fastApplyEdit(
              String(tc.args.path), String(tc.args.old_str), String(tc.args.new_str ?? '')
            );
            result = { toolName: tc.name, ok: faResult.ok, output: faResult.output };
          } else {
            result = await this.tools.run({ name: tc.name, arguments: tc.args });
          }
          // Repair prompt: if edit_file fails with "old_str not found", inject repair instructions
          if (!result.ok && result.output.includes('old_str not found')) {
            const fp  = String(tc.args.path ?? '');
            // The usual cause of a repeated "not found": the first call worked and the text is already changed
            let applied = false;
            try { const nw = String(tc.args.new_str ?? ''); applied = nw.trim() !== '' && fs.readFileSync(this.fileUri(fp).fsPath, 'utf8').includes(nw); } catch { /* unreadable */ }
            if (applied) result.output += `\n\n[ALREADY APPLIED] new_str is already in ${fp}, so this edit was almost certainly applied by an earlier call. ` +
              `Do NOT send it again. view_file the lines once to confirm, then carry on with the next step or report the result.`;
            result.output = result.output + `\n\n[REPAIR INSTRUCTIONS]\n` +
              `The old_str was not found verbatim. Repair rules:\n` +
              `1. Re-read the file with view_file to see its current exact content.\n` +
              `2. The old_str must match character-for-character including whitespace.\n` +
              `3. Use the shortest unique slice of the target block — no leading/trailing blank lines.\n` +
              `4. The new_str must preserve all unchanged surrounding code.\n` +
              `5. Do not guess — only use text you can see in the file.\n` +
              `Re-read ${fp} now and retry with the corrected old_str.`;
          }
        } else {
          result = await this.tools.run({ name: tc.name, arguments: tc.args });
        }

        // LintDiff post-edit check: errors this edit introduced go straight back to the model
        if (reviewed && result.ok) this.review.track(this.fileUri(editPath).fsPath, textBefore);
        if (editPath && result.ok && errorsBefore) {
          editedFiles.add(editPath);
          const fresh = await this.newErrorsAfter(editPath, errorsBefore);
          const depth = (lintDepth.get(editPath) ?? 0) + 1;
          lintDepth.set(editPath, depth);
          if (fresh.length && depth <= 4) {
            result.output += `\n\n[LINT] This edit introduced ${fresh.length} new error(s) in ${editPath}:\n` +
              fresh.slice(0, 10).map(l => '  ' + l).join('\n') +
              `\nFix them now (view_file the affected lines, then edit_file) before moving on.`;
          }
        }
        // The same call failing again and again cannot succeed: say so, and after a few times stop and report
        const sig = tc.name + '|' + JSON.stringify(tc.args);
        if (result.ok) failStreak.delete(sig);
        else {
          const times = (failStreak.get(sig) ?? 0) + 1;
          failStreak.set(sig, times);
          if (times >= 2) result.output += `\n\n[LOOP GUARD] This exact call has failed ${times} times in a row. Repeating it cannot work: change the approach (re-read the file, check whether the change is already there) or tell the user what is blocking you.`;
          if (times >= 4) loopBreak = true;
        }
        if (result.ok) { if (tc.name === 'run_command' || ChatProvider.EDIT_TOOLS.has(tc.name)) lastFailure = null; }
        else if (tc.name === 'run_command' || ChatProvider.EDIT_TOOLS.has(tc.name)) lastFailure = { tool: tc.name, output: result.output };

        this.post({
          type: 'toolResult', name: tc.name, ok: result.ok, output: result.output
        });
        this.traj.addStep('tool_result', { name: tc.name, ok: result.ok });

        // Stdin classifier: if run_command output suggests terminal is waiting, warn LLM
        if (tc.name === 'run_command' && result.ok) {
          const needsInput = await this.classifyTerminalNeedsInput(result.output);
          if (needsInput) {
            result.output += '\n\n[STDIN CLASSIFIER] The terminal appears to be waiting for user input. Use send_command_input tool to respond, or run_command with a non-interactive alternative.';
          }
        }

        toolResultContent.push(`[Tool: ${tc.name}]\n${result.output}`);
      }

      if (this.stopRequested) {
        this.post({ type: 'systemMessage', text: '⏹ Stopped.' });
        break;
      }
      messages.push({ role: 'user', content: toolResultContent.join('\n\n') });
      if (iter === MAX_TOOL_ITERATIONS - 1 || loopBreak) { hitCap = true; if (loopBreak) break; }
    }

    // Out of steps (or the loop ended) with the work unfinished: say so plainly instead of ending on a silent "Done".
    if (hitCap && !this.stopRequested && this.runOutcome !== 'error' && messages[messages.length - 1]?.role === 'user') {
      await this.wrapUp(model, apiKey, messages, maxT, temp, lastFailure, loopBreak ? 'You kept repeating a call that fails' : 'You ran out of steps');
    }

    this.streaming = false;
  }

  // ── Bug-fix helpers (spec §8: Diagnostics → ExplainAndFix → LintDiff → AutoFixLints) ──
  private fileUri(p: string): vscode.Uri {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return vscode.Uri.file(nodePath.isAbsolute(p) ? p : nodePath.join(root, p));
  }

  /** Current error diagnostics of one file as "line:col message [source]" keyed by message (line numbers shift on edit). */
  private fileErrors(p: string): Map<string, string> {
    const out = new Map<string, string>();
    try {
      for (const d of vscode.languages.getDiagnostics(this.fileUri(p))) {
        if (d.severity !== vscode.DiagnosticSeverity.Error) continue;
        out.set(`${d.source ?? ''}|${d.message}`, `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}${d.source ? ` [${d.source}]` : ''}`);
      }
    } catch { /* file outside the workspace */ }
    return out;
  }

  /** Waits for the language server to re-check the file, then returns the errors that were not there before. */
  private async newErrorsAfter(p: string, before: Map<string, string>): Promise<string[]> {
    await new Promise(r => setTimeout(r, 1200));
    const now = this.fileErrors(p);
    return [...now].filter(([k]) => !before.has(k)).map(([, v]) => v);
  }

  /** Returns an instruction when the run must not end yet, otherwise null. */
  private unresolvedProblem(
    failure: { tool: string; output: string } | null, edited: Set<string>, finalText: string
  ): string | null {
    if (failure) {
      return `The last ${failure.tool === 'run_command' ? 'command' : 'edit'} FAILED and the problem is not solved yet:\n` +
        `${failure.output.slice(-1500)}\n\n` +
        `Do not stop here. Read the error, find the root cause (view_file / grep_search the code it points to), fix it, and run the command again. ` +
        `Repeat until it succeeds. Only if you are truly blocked (a missing tool, permission or information from the user) ` +
        `explain exactly what is wrong and what you need.`;
    }
    const left: string[] = [];
    for (const f of edited) {
      const errs = [...this.fileErrors(f).values()];
      if (errs.length) left.push(`${f}:\n` + errs.slice(0, 8).map(e => '  ' + e).join('\n'));
    }
    if (left.length) {
      return `Files you edited still have errors:\n${left.slice(0, 4).join('\n')}\n\n` +
        `Fix them (view_file the lines, edit_file), then check again with get_diagnostics before you finish.`;
    }
    if (!finalText.trim() && edited.size) {
      return 'You ended without a message. Summarize what you changed and whether it works.';
    }
    return null;
  }

  /** No tools: the model reports where things stand when the step budget ran out. */
  private async wrapUp(
    model: ModelConfig, apiKey: string, messages: ChatMessage[], maxT: number, temp: number,
    failure: { tool: string; output: string } | null, why = 'You ran out of steps'
  ): Promise<void> {
    const ask = failure
      ? `${why} and the last ${failure.tool} still fails:\n${failure.output.slice(-1200)}\n\n` +
        `Tell the user: what is failing, the likely root cause, what you already tried, and the exact next step (or command) to fix it.`
      : `${why}. Tell the user briefly what is done, what is left, and the exact next step. If an edit was already applied, say so.`;
    let text = '';
    this.post({ type: 'streamStart', model: model.name, iteration: MAX_TOOL_ITERATIONS });
    try {
      await this.llm.streamChat(model, apiKey, [...messages, { role: 'user', content: ask }], { maxTokens: Math.min(maxT, 1500), temperature: temp }, c => {
        if (c.type === 'delta' && c.content) { text += c.content; this.post({ type: 'streamDelta', content: c.content }); }
      });
    } finally {
      this.post({ type: 'streamEnd' });
    }
    if (text.trim()) {
      this.history.push({ role: 'assistant', content: text });
      this.traj.addMessage({ role: 'assistant', content: text }, 'assistant_message');
    }
  }

  // ── Planning Mode (§13) — 5 roles + file persistence + approval ──
  // SUCCESSION_THRESHOLD: if trajectory has more than this many steps, spawn a successor (§13)
  // Tool calls inside plan/research loops count as steps, so the old limit of 80 fired on every plan
  private static readonly SUCCESSION_THRESHOLD = 400;

  // Plan files live next to the workspace, one folder per chat session (spec §13: <conversation-id>/).
  private planDir(): vscode.Uri | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    return root ? vscode.Uri.joinPath(root, '.rag', 'plans', this.sessions.current().id) : undefined;
  }

  /**
   * Read-only agent loop shared by plan discovery and research: the model may only call `allowed` tools.
   * When the iteration budget runs out it is asked once, without tools, to write its final report.
   */
  private async runReadOnlyAgent(
    model: ModelConfig, apiKey: string, system: string, userPrompt: string,
    allowed: Set<string>, defs: Array<{ function: { name: string; parameters: { properties?: Record<string, unknown> } } }>,
    maxIters: number, maxTokens: number,
    // Returns a corrective instruction when the model's answer is not an acceptable final report, otherwise null.
    validate?: (text: string, used: Set<string>) => string | null
  ): Promise<string> {
    const used = new Set<string>();
    let nudges = 2;
    const known = new Map<string, string[]>();
    for (const d of defs) known.set(d.function.name, Object.keys(d.function.parameters.properties ?? {}));

    const msgs: ChatMessage[] = [
      { role: 'system', content: system + '\n\n<environment>' + `OS: ${process.platform}. Workspace: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '(none)'}.</environment>` },
      { role: 'user', content: userPrompt }
    ];
    let last = '';
    for (let i = 0; i < maxIters && !this.stopRequested; i++) {
      let out = '';
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      await this.llm.streamChat(model, apiKey, msgs, { maxTokens, temperature: 0.2, tools: defs }, c => {
        if (c.type === 'delta' && c.content) out += c.content;
        else if (c.type === 'toolCall') calls.push({ name: c.toolName!, args: c.toolArgs ?? {} });
      });
      if (!calls.length && out) {
        const leaked = extractLeakedToolCalls(out, known);
        if (leaked.calls.length) { calls.push(...leaked.calls); out = leaked.text; }
      }
      if (out) last = out;
      if (!calls.length) {
        const fix = validate?.(out, used);
        if (!fix) return out;
        if (nudges-- > 0 && i < maxIters - 1) {          // not a real report yet: push the model to continue
          msgs.push({ role: 'assistant', content: out });
          msgs.push({ role: 'user', content: fix });
          continue;
        }
        break;                                           // out of nudges: fall through to the forced final report
      }

      // never put placeholder text here: the model copies whatever it sees in its own earlier turns
      msgs.push({ role: 'assistant', content: out });
      const results: string[] = [];
      for (const call of calls) {
        if (this.stopRequested) break;
        used.add(call.name);
        this.runTools++;
        this.analytics.tool(call.name);
        this.post({ type: 'toolCall', name: call.name, args: call.args });
        const r = allowed.has(call.name)
          ? await this.tools.run({ name: call.name, arguments: call.args })
          : { toolName: call.name, ok: false, output: `"${call.name}" is not available while researching (read-only).` };
        this.post({ type: 'toolResult', name: call.name, ok: r.ok, output: r.output });
        results.push(`[Tool: ${call.name}]\n${r.output.slice(0, 12000)}`);
      }
      msgs.push({ role: 'user', content: results.join('\n\n') || 'No usable tool results.' });
    }
    if (this.stopRequested) return last;

    // budget used up: ask for the final report without offering tools
    msgs.push({ role: 'user', content: 'Stop calling tools. Write the final report now as the requested Markdown document, using everything you gathered.' });
    let report = '';
    await this.llm.streamChat(model, apiKey, msgs, { maxTokens, temperature: 0.2 }, c => {
      if (c.type === 'delta' && c.content) report += c.content;
    });
    return report || last || '(no report produced)';
  }

  private static readonly LOCAL_READ_ONLY = new Set(['view_file', 'read_multiple_files', 'list_directory', 'grep_search', 'search_symbol', 'get_file_outline']);

  /** Researcher (plan discovery): explores the user's own workspace. */
  private researchCodebase(model: ModelConfig, apiKey: string, system: string, task: string): Promise<string> {
    const defs = TOOL_DEFS.filter(d => ChatProvider.LOCAL_READ_ONLY.has(d.function.name));
    return this.runReadOnlyAgent(model, apiKey, system,
      `You are the RESEARCHER (read-only). Task: "${task}"\n\n` +
      `Explore the workspace with the tools (list_directory, view_file, grep_search...). ` +
      `Then output a structured discovery report: 1) relevant files, 2) existing patterns and conventions, ` +
      `3) dependencies, 4) risks. Do not propose edits yet.`,
      ChatProvider.LOCAL_READ_ONLY, defs, 6, 2048);
  }

  // ── Research mode: explore code you have no reference for, write Research.md for the planner ──
  private researchCardId = '';
  private researchTask   = '';

  private async handleResearchInput(text: string): Promise<void> {
    const msg: ChatMessage = { role: 'user', content: text, id: this.newMsgId() };
    this.postUser(text, false, msg.id);
    this.history.push(msg);
    this.traj.addMessage(msg, 'user_message');
    this.sessions.saveCurrent(this.history);
    this.postSessionInfo();
    await this.withRun(() => this.doResearchInner(text));
  }

  private async readResearch(): Promise<{ text: string; rel: string } | undefined> {
    const dir  = this.planDir();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    for (const uri of [dir && vscode.Uri.joinPath(dir, 'Research.md'), root && vscode.Uri.joinPath(root, 'Research.md')]) {
      if (!uri) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return { text: Buffer.from(bytes).toString('utf8'), rel: vscode.workspace.asRelativePath(uri) };
      } catch { /* try the next location */ }
    }
    return undefined;
  }

  private async doResearchInner(task: string): Promise<void> {
    const model = this.registry.getActiveModel();
    if (!model) { this.runOutcome = 'error'; this.post({ type: 'error', text: 'No model configured' }); return; }
    const apiKey = await this.registry.getApiKey(model.id);
    const ragCtx = await this.assembler.buildSystemPrompt(task, { includeRAG: true });

    // ── 1/3 Break the request down into requirements ─────────────────
    this.showInfo('🧩 Research 1/3 — breaking the request down into requirements…');
    let breakdown = '';
    await this.llm.streamChat(model, apiKey, [
      { role: 'system', content: ragCtx },
      { role: 'user', content:
        `The user wants:\n"${task}"\n\n` +
        `Break this down into the concrete REQUIREMENTS that must be built. Output a numbered list R1, R2, … (max 8). ` +
        `For each: a short title, one line saying what must work when it is done, and search hints ` +
        `(keywords, likely libraries or algorithms). If the request is vague, state your reasonable assumptions ` +
        `in a final "Assumptions" line. Output only the list.` }
    ], { maxTokens: 1200, temperature: 0.2 }, c => { if (c.type === 'delta' && c.content) breakdown += c.content; });
    breakdown = breakdown.trim() || `R1. ${task}`;
    this.post({ type: 'systemMessage', text: `## 🧩 Requirements\n\n${breakdown}` });
    if (this.stopRequested) return;

    // ── 2/3 Find matching reference code for each requirement ────────
    this.showInfo('🔎 Research 2/3 — finding reference code for each requirement…');
    const allowed = new Set<string>([...ChatProvider.LOCAL_READ_ONLY, 'web_fetch', ...RESEARCH_TOOL_NAMES]);
    const defs = [...TOOL_DEFS.filter(d => allowed.has(d.function.name)), ...RESEARCH_TOOL_DEFS];

    const report = await this.runReadOnlyAgent(model, apiKey, ragCtx,
      `You are the RESEARCHER of a coding assistant.\n\nUser request:\n"${task}"\n\nRequirements already agreed:\n${breakdown}\n\n` +
      `The user has NO reference code for this. For EACH requirement, find code that implements it and capture the actual functions.\n` +
      `Tools: github_fetch_top_repositories (PREFERRED: finds the most starred repositories for a topic, downloads them as zip and extracts them under .rag/references; ` +
      `count defaults to 3, but if the user asked for a number of repositories pass exactly that number), ` +
      `github_download_repository (one specific repository), google_search (documentation of the libraries involved), package_info (dependency versions and docs), ` +
      `and the local read-only tools list_directory, grep_search, get_file_outline, view_file, which you use to STUDY the downloaded repositories and this project.\n\n` +
      `Method (do not skip steps): 1) list the workspace ONCE and read its manifest to know the stack; ` +
      `2) call github_fetch_top_repositories with keywords taken from the requirements (2-3 calls in total; count = the number of repositories the user asked for, default 3, most starred first); ` +
      `3) study the downloaded code LOCALLY: grep_search / get_file_outline to find the relevant functions, then view_file to read them and copy the exact code ` +
      `(each ≤ 60 lines, no paraphrasing) together with its path under .rag/references/ and its line numbers; ` +
      `4) look up the documentation of the dependencies involved with package_info / google_search (only a few queries: searches get throttled). ` +
      `Do not repeat the same tool call.\n\n` +
      `Your LAST message is the final answer, a Markdown document saved as Research.md and read by the planner. ` +
      `No preamble, never a placeholder. Use exactly this structure:\n` +
      `# Research: <short title>\n` +
      `## Requirements\n(the R1..Rn list above, plus assumptions)\n` +
      `## Reference code\n` +
      `### R1 — <title>\n` +
      `- Source: <owner/repo> · local \`.rag/references/<owner>__<repo>/path/to/file\` · lines a–b · function \`name\`\n` +
      `- Why it fits: one or two sentences\n` +
      `\`\`\`<language>\n<the exact function code copied from github_file_content>\n\`\`\`\n` +
      `- Adapt: what must change to fit this project\n` +
      `(repeat for every requirement; several candidates are fine; if no code was found say so)\n` +
      `## Dependencies and documentation\n(name, version, key APIs, links)\n` +
      `## Mapping\n| Requirement | Reference function | Implement in (this project) |\n` +
      `## Risks and open questions\n` +
      `## Implementation approach\n(ordered bullets the planner can turn into steps)\n\n` +
      `Cite every source as a URL or repo/path and never invent code or facts.`,
      allowed, defs, 18, 6000,
      (text, used) => {
        const usedRepos = used.has('github_fetch_top_repositories') || used.has('github_download_repository');
        const usedFile  = used.has('view_file') || used.has('read_multiple_files') || used.has('github_file_content');
        if (text.trim().length < 900 || !/^#\s*Research/mi.test(text) || !/^##\s*Reference code/mi.test(text) || !text.includes('```')) {
          return 'That is not the report I asked for. ' +
            (usedRepos ? '' : 'You have not fetched any reference repository yet: call github_fetch_top_repositories (top 3 by stars) first. ') +
            (usedFile ? '' : 'You have not read any reference code yet: use grep_search / get_file_outline / view_file on the downloaded folders under .rag/references and copy the relevant functions. ') +
            'Then reply with the FULL Markdown report: "# Research:", "## Requirements", "## Reference code" with one section per requirement ' +
            'that contains the actual function code in fenced code blocks, then the remaining sections.';
        }
        return null;
      });
    if (this.stopRequested) return;

    // ── 3/3 Save Research.md for the planner ─────────────────────────
    this.showInfo('📝 Research 3/3 — saving Research.md…');
    const dir = this.planDir();
    let uri: vscode.Uri | undefined;
    const doc = `<!-- RAG Research · ${new Date().toISOString()} · request: ${task.replace(/\s+/g, ' ').slice(0, 160)} -->\n\n${report.trim()}\n`;
    if (dir) {
      try {
        await vscode.workspace.fs.createDirectory(dir);
        uri = vscode.Uri.joinPath(dir, 'Research.md');
        await vscode.workspace.fs.writeFile(uri, Buffer.from(doc, 'utf8'));
        void vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside });
      } catch (e) {
        this.runOutcome = 'error';
        this.post({ type: 'error', text: `Could not write Research.md: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    const rel = uri ? vscode.workspace.asRelativePath(uri) : '';
    const summary = `## 🔎 Research\n\n${report.trim().slice(0, 3500)}${report.length > 3500 ? '\n\n… (full report in the file)' : ''}\n` +
      (rel ? `\n📄 Saved to \`${rel}\`: requirements, reference functions with code, and how to adapt them. Plan mode reads it when it writes \`implementation_plan.md\`.` : '');
    this.post({ type: 'systemMessage', text: summary });
    this.history.push({ role: 'assistant', content: summary });
    this.traj.addMessage({ role: 'assistant', content: summary }, 'assistant_message');

    this.researchTask = task;
    this.researchCardId = 'research:' + Date.now().toString(36);
    this.post({
      type: 'choiceCard', id: this.researchCardId, icon: 'plan',
      title: 'Research is ready. Create an implementation plan from it?',
      detail: rel || 'Research.md could not be saved (no workspace folder).',
      options: [
        { value: 'plan', label: 'Yes, switch to Plan mode and write the plan' },
        { value: 'no',   label: 'No, keep researching' }
      ],
      link: rel ? { label: 'Open Research.md', action: 'openResearch' } : undefined
    });
  }

  private async answerResearchCard(value: string): Promise<void> {
    const done = (label: string) => this.post({ type: 'cardResolved', id: this.researchCardId, label });
    if (value !== 'plan') { done('Research kept — refine it by sending another message.'); return; }
    done('✓ Switching to Plan mode');
    this.setMode('plan');
    await this.doPlan(`${this.researchTask}\n\n(Use Research.md for the external findings.)`);
  }

  private async doPlan(task: string): Promise<void> {
    await this.withRun(() => this.doPlanInner(task));
  }

  private async doPlanInner(task: string): Promise<void> {
    const model = this.registry.getActiveModel();
    if (!model) { this.runOutcome = 'error'; this.post({ type: 'error', text: 'No model configured' }); return; }

    this.traj.addStep('planning_start', { task });
    this.post({ type: 'planningStart', task });

    const apiKey = await this.registry.getApiKey(model.id);
    const ragCtx = await this.assembler.buildSystemPrompt(task, { includeRAG: true });
    const ask = async (user: string, maxTokens: number): Promise<string> => {
      let out = '';
      await this.llm.streamChat(model, apiKey,
        [{ role: 'system', content: ragCtx }, { role: 'user', content: user }],
        { maxTokens, temperature: 0.3 },
        c => { if (c.type === 'delta' && c.content) out += c.content; });
      return out;
    };

    // ── Phase 1: Discovery — Researcher reads the codebase ──────────
    this.showInfo('📋 Planning 1/3 — Researcher is exploring the codebase…');
    const localDiscovery = await this.researchCodebase(model, apiKey, ragCtx, task);
    if (this.stopRequested) return;

    // Research.md (written in Research mode) holds the external findings: fold it into the discovery
    const research = await this.readResearch();
    if (research) this.showInfo(`📖 Planning with the findings in ${research.rel}`);
    const discoveryReport = research
      ? `${localDiscovery}\n\n## External research (${research.rel})\n${research.text.slice(0, 14000)}`
      : localDiscovery;

    // ── Phase 2: Planning — Planner + PlanReviewer ──────────────────
    this.showInfo('📋 Planning 2/3 — Planner is writing the implementation plan…');
    let planOut = await ask(
      `You are the PLANNER. Based on this discovery report:\n${discoveryReport}\n\n` +
      `Create a numbered implementation plan (max 10 steps). Format each step as:\n` +
      `1. [Action] — [file/tool]\n2. ...\n\nTask: "${task}"` +
      (research
        ? `\n\nThe discovery report contains Research.md: the user's requirements (R1..Rn) and reference functions with their code. ` +
          `Cover EVERY requirement. Each step must name the requirement it satisfies (R#) and, where one exists, the reference ` +
          `function/file to adapt (adapt it to this project, do not copy blindly), plus the file of this project to change.`
        : ''), 2000);
    if (this.stopRequested) return;

    this.showInfo('📋 Planning 3/3 — PlanReviewer is checking the plan…');
    const reviewOut = await ask(
      `You are the PLAN REVIEWER. Review this plan for gaps, risks, or missing steps:\n${planOut}\n\n` +
      `Output: issues found (or "LGTM" if no issues).`, 600);
    if (reviewOut && !reviewOut.toUpperCase().includes('LGTM') && !this.stopRequested) {
      const revised = await ask(
        `You are the PLANNER. Your plan:\n${planOut}\n\nReviewer feedback:\n${reviewOut}\n\n` +
        `Revise the plan to address the feedback. Output the revised numbered plan only.`, 1500);
      if (revised.trim()) planOut = revised;
    }
    if (this.stopRequested) return;

    // ── Write plan files (spec §13: implementation_plan.md + progress.md) ──
    const planMd =
      `# Implementation Plan\n\n**Task:** ${task}\n**Generated:** ${new Date().toISOString()}\n\n` +
      (research ? `**Research:** based on \`${research.rel}\`\n\n` : '') +
      `## Discovery Report\n${localDiscovery}\n\n## Steps\n${planOut}\n\n## Review\n${reviewOut || 'LGTM'}\n`;
    const progressMd =
      `# Progress\n\n**Task:** ${task}\n**Status:** pending approval\n\n## Steps\n` +
      `${planOut.split('\n').map(l => l.match(/^\s*\d+\./) ? `- [ ] ${l.trim()}` : l).join('\n')}\n`;

    let planUri: vscode.Uri | undefined;
    const dir = this.planDir();
    if (dir) {
      try {
        await vscode.workspace.fs.createDirectory(dir);
        planUri = vscode.Uri.joinPath(dir, 'implementation_plan.md');
        await vscode.workspace.fs.writeFile(planUri, Buffer.from(planMd, 'utf8'));
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'progress.md'), Buffer.from(progressMd, 'utf8'));
        void vscode.window.showTextDocument(planUri, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside });
      } catch (e) {
        this.runOutcome = 'error';
        this.post({ type: 'error', text: `Could not write plan files: ${e instanceof Error ? e.message : String(e)}` });
      }
    } else {
      this.showInfo('Open a folder to save plan files; the plan is shown below only.');
    }

    const rel = planUri ? vscode.workspace.asRelativePath(planUri) : '';
    const summary =
      `## 📋 Implementation Plan\n\n${planOut}\n\n**Review:** ${reviewOut || 'LGTM'}\n` +
      (rel ? `\n📄 Saved to \`${rel}\` (and \`progress.md\` next to it).` : '');
    this.post({ type: 'systemMessage', text: summary });
    this.history.push({ role: 'assistant', content: summary });
    this.traj.addMessage({ role: 'assistant', content: summary }, 'assistant_message');

    this.pendingPlan = { task, planOut };
    this.planCardId = 'plan:' + Date.now().toString(36);
    this.post({
      type: 'choiceCard', id: this.planCardId, icon: 'plan',
      title: 'Approve this implementation plan?',
      detail: rel || 'The plan is shown above (no workspace folder to save it in).',
      options: [
        { value: 'approve', label: 'Yes, approve and run this plan' },
        { value: 'modify',  label: 'No, modify the plan', hint: '(tell the agent what to change)', input: 'What should change in the plan?' },
        { value: 'reject',  label: 'No, reject the plan' }
      ],
      link: rel ? { label: 'Open plan file', action: 'openPlan' } : undefined
    });
    this.traj.addStep('planning_done', { task });
    this.post({ type: 'planningEnd' });

    // ── Succession Protocol (§13) ────────────────────────────────
    this.checkSuccessionThreshold(task, planOut);
  }

  // Succession Protocol (§13): if trajectory exceeds threshold, spawn successor with handoff
  private checkSuccessionThreshold(task: string, planOut: string): void {
    const steps = this.traj.getSteps();
    if (steps.length < ChatProvider.SUCCESSION_THRESHOLD) return;

    this.showInfo('🔄 Succession Protocol: trajectory size exceeded — preparing handoff...');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;

    // Read progress.md for current state
    const readProgress = async () => {
      if (!root) return '(no workspace)';
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'progress.md'));
        return Buffer.from(bytes).toString('utf8').slice(0, 2000);
      } catch { return '(no progress.md)'; }
    };

    readProgress().then(progress => {
      const handoff = {
        original_task:    task,
        progress_summary: progress,
        pending_plan:     planOut.slice(0, 1000),
        trajectory_steps: steps.length,
        timestamp:        new Date().toISOString()
      };

      // Clear trajectory to give successor a fresh start, preserve handoff context
      this.traj.addStep('succession_handoff', handoff);
      // Truncate old steps (keep only recent 20 + the handoff)
      const allSteps = this.traj.getSteps();
      const recentSteps = allSteps.slice(-21); // last 20 + handoff
      this.traj.reset(recentSteps);

      this.showInfo(`✅ Succession complete: trajectory reset to ${recentSteps.length} steps. Successor context injected.`);
      this.post({
        type: 'systemMessage',
        text: `## 🔄 Succession Protocol\n\nTrajectory reset (was ${steps.length} steps). Successor inherits:\n- Task: ${task.slice(0, 100)}\n- Progress: ${progress.slice(0, 200)}`
      });
    }).catch(() => { /* non-fatal */ });
  }

  // ── Plan approval / rejection ────────────────────────────────────
  private pendingPlan: { task: string; planOut: string } | null = null;
  private planCardId = '';

  /** Answer from the plan approval card. */
  private async answerPlanCard(value: string, text?: string): Promise<void> {
    if (value === 'approve' || value === 'reject') { await this.handlePlanApproval([value]); return; }
    if (value === 'modify') {
      const fb = text?.trim() || await vscode.window.showInputBox({ prompt: 'What should change in the plan?' });
      if (fb?.trim()) await this.handlePlanApproval(['modify', ...fb.trim().split(/\s+/)]);
      else this.post({ type: 'cardResolved', id: this.planCardId, label: 'Plan left unchanged — approve, modify or reject it any time by typing.' });
      return;
    }
    this.post({ type: 'cardResolved', id: this.planCardId, label: 'Skipped — type "yes", "no", or what to change.' });
  }

  private async handlePlanApproval(args: string[]): Promise<void> {
    const sub = args[0]?.toLowerCase();
    if (sub === 'approve') {
      if (!this.pendingPlan) { this.showInfo('No pending plan. Run /plan <task> first.'); return; }
      const { task, planOut } = this.pendingPlan;
      this.pendingPlan = null;
      this.post({ type: 'cardResolved', id: this.planCardId, label: '✓ Plan approved' });
      // Plan mode blocks edits and commands, so approving hands over to the Coder in Auto mode.
      if (this.mode === 'plan') {
        this.setMode('auto');
        this.showInfo('✅ Plan approved — switched to Auto mode to execute it.');
      } else {
        this.showInfo('✅ Plan approved — starting execution...');
      }
      const dir = this.planDir();
      const progressRel = dir ? vscode.workspace.asRelativePath(vscode.Uri.joinPath(dir, 'progress.md')) : '';
      const research = await this.readResearch();
      // Role 3: Coder executes the approved plan
      await this.doChat(
        `EXECUTE THE APPROVED PLAN.\n\nTask: ${task}\n\nPlan:\n${planOut}\n\n` +
        `Implement each step with your tools, so that the user's requirements are met. ` +
        (research ? `The reference functions and code are in ${research.rel}: read the relevant section with view_file before each step and adapt that code to this project. ` : '') +
        (progressRel ? `After finishing a step, mark it done (- [x]) in ${progressRel}.` : ''),
        undefined, '▶ Plan approved — execute it');
    } else if (sub === 'reject') {
      this.pendingPlan = null;
      this.post({ type: 'cardResolved', id: this.planCardId, label: '✕ Plan rejected' });
      this.showInfo('❌ Plan rejected. Describe the task again (or adjust it) to create a new plan.');
    } else if (sub === 'modify') {
      // §13: user requests plan revision with feedback
      if (!this.pendingPlan) { this.showInfo('No pending plan to modify. Run /plan <task> first.'); return; }
      const feedback = args.slice(1).join(' ');
      if (!feedback) { this.showInfo('Usage: /plan modify <feedback>'); return; }
      const { task } = this.pendingPlan;
      this.pendingPlan = null;
      this.post({ type: 'cardResolved', id: this.planCardId, label: `✎ Revising the plan — "${feedback}"` });
      await this.doPlan(`${task}\n\n[MODIFICATION REQUEST]: ${feedback}`);
    } else if (sub === 'status') {
      const dir = this.planDir();
      if (!dir) { this.showInfo('No workspace open.'); return; }
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'progress.md'));
        this.post({ type: 'systemMessage', text: `## Progress\n\`\`\`\n${Buffer.from(bytes).toString('utf8').slice(0, 2000)}\n\`\`\`` });
      } catch { this.showInfo('No progress.md found. Run /plan <task> first.'); }
    } else {
      await this.doPlan(args.join(' '));
    }
  }

  // ── Battle Mode (§19) — two agents compete, judge evaluates ──────
  private async doBattle(prompt: string): Promise<void> {
    const models = this.registry.getModels();
    if (models.length < 2) {
      this.post({ type: 'error', text: 'Battle mode needs at least 2 models. Add another model first.' });
      return;
    }

    const task   = prompt.trim() || 'Explain the best approach for the current coding task.';
    const battle = new BattleMode(this.registry, this.traj);

    this.post({ type: 'streamStart', model: 'Battle Mode', iteration: 0 });
    this.streaming = true;

    try {
      const result = await battle.run(task, {
        modelA: models[0].name,
        modelB: models[1].name,
        judgeModel: models[2]?.name  // third model as judge if available
      });

      const formatted = BattleMode.formatResult(result);
      this.post({ type: 'streamDelta', content: formatted });
      this.post({ type: 'streamEnd' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.post({ type: 'error', text: `Battle Mode error: ${msg}` });
    } finally {
      this.streaming = false;
    }
  }

  // ── SDK Executor (§23) — run Python SDK agent scripts ─────────────
  private async doSDK(args: string): Promise<void> {
    const executor = getSDKExecutor(this.ctx);
    const trimmed  = args.trim();

    if (!trimmed || trimmed === 'help') {
      this.showInfo([
        '**SDK Executor (§23)** — run Python SDK agent scripts',
        '',
        'Usage:',
        '  `/sdk run <python_file>` — execute a Python SDK agent script',
        '  `/sdk inline <code>` — run inline Python code',
        '  `/sdk list` — list running SDK sidecars',
        '  `/sdk sidecar <python_file>` — start as sidecar (restart=always)',
        '  `/sdk init` — initialize the Python venv',
      ].join('\n'));
      return;
    }

    const [sub, ...rest] = trimmed.split(/\s+/);
    const subArgs = rest.join(' ');

    this.post({ type: 'streamStart', model: 'SDK Executor', iteration: 0 });

    try {
      switch (sub) {
        case 'run': {
          if (!subArgs) { this.showInfo('Usage: /sdk run <python_file>'); return; }
          const result = await executor.execute({ scriptPath: subArgs });
          const out = [`SDK Result (exit ${result.exitCode}):`, result.stdout, result.stderr ? `stderr: ${result.stderr}` : ''].filter(Boolean).join('\n');
          this.post({ type: 'streamDelta', content: out });
          break;
        }
        case 'inline': {
          if (!subArgs) { this.showInfo('Usage: /sdk inline <python_code>'); return; }
          const result = await executor.execute({ script: subArgs });
          this.post({ type: 'streamDelta', content: `SDK inline (exit ${result.exitCode}):\n${result.stdout}` });
          break;
        }
        case 'list': {
          const sidecars = executor.listSidecars();
          const text = sidecars.length
            ? sidecars.map(s => `• ${s.id} [${s.status}] ${s.script}`).join('\n')
            : 'No SDK sidecars running.';
          this.post({ type: 'streamDelta', content: text });
          break;
        }
        case 'sidecar': {
          if (!subArgs) { this.showInfo('Usage: /sdk sidecar <python_file>'); return; }
          const result = await executor.startSidecar({ scriptPath: subArgs }, 'always');
          this.post({ type: 'streamDelta', content: result });
          break;
        }
        case 'init': {
          await executor.init();
          this.post({ type: 'streamDelta', content: '✅ SDK Python venv initialized.' });
          break;
        }
        default:
          this.showInfo(`Unknown SDK subcommand: ${sub}. Use /sdk help.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.post({ type: 'error', text: `SDK error: ${msg}` });
    } finally {
      this.post({ type: 'streamEnd' });
    }
  }

  // ── Agent role switcher ────────────────────────────────────────
  private setAgent(role: string): void {
    const valid = ['default', ...Object.keys(AGENT_PROMPTS)];
    const r     = role.toLowerCase().trim();
    if (!valid.includes(r)) {
      this.showInfo(`Unknown agent role. Available: ${valid.join(', ')}`);
      return;
    }
    this.activeRole = r as AgentRole;
    this.showInfo(`Agent role set to: ${r}`);
    this.postStatus();
  }

  // ── Checkpoint commands (/checkpoint save/restore/list/delete) ──
  private async handleCheckpoint(args: string[]): Promise<void> {
    const sub = args[0]?.toLowerCase();
    switch (sub) {
      case 'save': {
        const name = args.slice(1).join(' ') || `checkpoint_${Date.now()}`;
        const cp   = this.traj.saveCheckpoint(name);
        this.showInfo(`✅ Checkpoint saved: "${cp.name}" (id: ${cp.id})`);
        break;
      }
      case 'list': {
        const cps = this.traj.listCheckpoints();
        if (!cps.length) { this.showInfo('No checkpoints saved.'); return; }
        const text = cps.map(c => `• ${c.id}: "${c.name}" (${c.created.slice(0, 10)})`).join('\n');
        this.post({ type: 'systemMessage', text: `**Checkpoints:**\n${text}` });
        break;
      }
      case 'restore': {
        const id = args[1];
        if (!id) { this.showInfo('Usage: /checkpoint restore <id>'); return; }
        const ok  = this.traj.restoreCheckpoint(id);
        if (ok) {
          this.history = this.traj.getMessages();
          this.post({ type: 'clearChat' });
          this.post({ type: 'history', messages: this.history });
          this.showInfo(`✅ Restored checkpoint: ${id}`);
        } else {
          this.showInfo(`Checkpoint not found: ${id}`);
        }
        break;
      }
      case 'delete': {
        const id = args[1];
        const ok  = id ? this.traj.deleteCheckpoint(id) : false;
        this.showInfo(ok ? `Deleted checkpoint: ${id}` : `Checkpoint not found: ${id}`);
        break;
      }
      default:
        this.showInfo('Usage: /checkpoint save [name] | list | restore <id> | delete <id>');
    }
  }

  // ── Knowledge base commands (/knowledge add/list/search) ────────
  private async handleKnowledge(args: string[]): Promise<void> {
    const sub = args[0]?.toLowerCase();
    switch (sub) {
      case 'add': {
        // /knowledge add <title> | <content>
        const body = args.slice(1).join(' ');
        const pipe = body.indexOf('|');
        const title   = pipe >= 0 ? body.slice(0, pipe).trim() : body.trim();
        const content = pipe >= 0 ? body.slice(pipe + 1).trim() : '';
        if (!title) { this.showInfo('Usage: /knowledge add <title> | <content>'); return; }
        const item = this.kb.add(title, content || title);
        this.showInfo(`✅ Knowledge item added: "${item.title}" (${item.id})`);
        break;
      }
      case 'list': {
        const items = this.kb.list();
        if (!items.length) { this.showInfo('No knowledge items. Use /knowledge add <title> | <content>'); return; }
        const text = items.map(i => `• ${i.id}: **${i.title}**`).join('\n');
        this.post({ type: 'systemMessage', text: `**Knowledge Items:**\n${text}` });
        break;
      }
      case 'search': {
        const query   = args.slice(1).join(' ');
        const results = this.kb.search(query);
        if (!results.length) { this.showInfo('No matches found.'); return; }
        const text = results.map(i => `• **${i.title}**: ${i.content.slice(0, 100)}...`).join('\n');
        this.post({ type: 'systemMessage', text: `**Knowledge Search Results:**\n${text}` });
        break;
      }
      case 'delete': {
        const id = args[1];
        const ok = id ? this.kb.remove(id) : false;
        this.showInfo(ok ? `Deleted knowledge item: ${id}` : `Not found: ${id}`);
        break;
      }
      case 'consolidate': {
        const merged = this.kb.consolidate();
        this.showInfo(`✅ Consolidated knowledge base: merged ${merged} duplicate item(s).`);
        break;
      }
      case 'prune': {
        const days    = parseInt(args[1] ?? '30', 10);
        const removed = this.kb.prune(isNaN(days) ? 30 : days);
        this.showInfo(`✅ Pruned ${removed} stale knowledge item(s) (older than ${days} days).`);
        break;
      }
      default:
        this.showInfo('Usage: /knowledge add <title> | <content> | list | search <query> | delete <id> | consolidate | prune [days]');
    }
  }

  // ── Conversation fork ──────────────────────────────────────────
  private async handleFork(checkpointId: string): Promise<void> {
    if (!checkpointId) {
      const cps = this.traj.listCheckpoints();
      if (!cps.length) {
        this.showInfo('No checkpoints to fork from. Use /checkpoint save first.');
        return;
      }
      const picks = cps.map(c => ({ label: c.name, description: c.id }));
      const pick  = await vscode.window.showQuickPick(picks, { placeHolder: 'Select checkpoint to fork from' });
      if (!pick) return;
      checkpointId = pick.description ?? '';
    }

    const forked = this.traj.forkFromCheckpoint(checkpointId);
    if (!forked) { this.showInfo(`Checkpoint not found: ${checkpointId}`); return; }
    this.history = forked;
    this.post({ type: 'clearChat' });
    this.post({ type: 'history', messages: this.history });
    this.showInfo(`✅ Forked from checkpoint: ${checkpointId}`);
  }

  // ── Subagent System ──────────────────────────────────────────────
  private async doSubagent(prompt: string): Promise<void> {
    if (!prompt) { this.showInfo('Usage: /subagent <task>'); return; }
    this.postUser(`/subagent ${prompt}`, false);
    this.post({ type: 'streamStart', model: 'Subagent Orchestrator', iteration: 0 });
    try {
      const ctx   = this.history.slice(-6).map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n');
      const result = await this.orchestrator.orchestrate(prompt, ctx);
      this.post({ type: 'streamDelta', content: result });
      this.post({ type: 'streamEnd' });
      this.history.push({ role: 'assistant', content: result });
    } catch (e) {
      this.post({ type: 'error', text: String(e) });
      this.post({ type: 'streamEnd' });
    }
  }

  // ── Orchestrate multi-role team ──────────────────────────────────
  private async doOrchestrate(prompt: string): Promise<void> {
    if (!prompt) { this.showInfo('Usage: /orchestrate <complex task>'); return; }
    await this.doSubagent(prompt);
  }

  // ── Sidecar process management ───────────────────────────────────
  private async handleSidecar(args: string[]): Promise<void> {
    const sub = args[0]?.toLowerCase();
    switch (sub) {
      case 'start': {
        // /sidecar start <name> [--restart always|on-failure] <command>
        let name = args[1];
        let restartIdx = args.indexOf('--restart');
        let restartPolicy: import('./SidecarManager').RestartPolicy = 'null';
        let cmdArgs = args.slice(2);
        if (restartIdx >= 2) {
          restartPolicy = (args[restartIdx + 1] ?? 'null') as import('./SidecarManager').RestartPolicy;
          cmdArgs = [...args.slice(2, restartIdx), ...args.slice(restartIdx + 2)];
        }
        const cmd = cmdArgs.join(' ');
        if (!name || !cmd) { this.showInfo('Usage: /sidecar start <name> [--restart always|on-failure] <command>'); return; }
        const proc = this.sidecar.start(name, cmd, undefined, restartPolicy);
        this.showInfo(`✅ Sidecar "${name}" started (PID ${proc.pid}, restart: ${restartPolicy})`);
        break;
      }
      case 'stop': {
        const name = args[1];
        if (!name) { this.showInfo('Usage: /sidecar stop <name>'); return; }
        void this.sidecar.stopGraceful(name).then(ok =>
          this.showInfo(ok ? `Stopped sidecar: ${name}` : `Sidecar not found: ${name}`)
        );
        break;
      }
      case 'list': {
        const list = this.sidecar.list();
        if (!list.length) { this.showInfo('No sidecars running.'); return; }
        const text = list.map(p => `• ${p.name} [${p.status}] PID:${p.pid} — ${p.command}`).join('\n');
        this.post({ type: 'systemMessage', text: `**Sidecars:**\n${text}` });
        break;
      }
      case 'logs': {
        const name   = args[1];
        if (!name) { this.showInfo('Usage: /sidecar logs <name>'); return; }
        const output = this.sidecar.getOutput(name);
        this.post({ type: 'systemMessage', text: `**${name} output:**\n\`\`\`\n${output || '(empty)'}\n\`\`\`` });
        break;
      }
      default:
        this.showInfo('Usage: /sidecar start <name> <cmd> | stop <name> | list | logs <name>');
    }
  }

  // ── Auto-fix from diagnostics ───────────────────────────────────
  private async doAutoFix(): Promise<void> {
    const diagCtx = this.diag.getActiveFileDiagnostics();
    if (!diagCtx) { this.showInfo('No errors/warnings in active file.'); return; }
    const editor = vscode.window.activeTextEditor;
    const file   = editor ? vscode.workspace.asRelativePath(editor.document.uri) : 'the active file';
    await this.doChat(`Fix all errors and warnings in ${file}. Here are the diagnostics:\n${diagCtx}`, undefined, `/fix ${file}`);
  }

  // ── Pin context management ──────────────────────────────────────
  private async handlePin(args: string[]): Promise<void> {
    const sub = args[0]?.toLowerCase();
    if (sub === 'clear') {
      this.pinnedContext.clear();
      this.post({ type: 'systemMessage', text: '📌 All pinned context cleared.' });
      return;
    }
    if (sub === 'list') {
      if (!this.pinnedContext.size) { this.showInfo('No pinned context.'); return; }
      const list = [...this.pinnedContext.keys()].map(k => `• ${k}`).join('\n');
      this.showInfo(`**Pinned context:**\n${list}`);
      return;
    }
    // /pin <file-path-or-label>
    const label = args.join(' ');
    if (!label) { this.showInfo('Usage: /pin <file> | list | clear'); return; }
    try {
      const root    = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const fp      = require('path').isAbsolute(label) ? label : require('path').join(root, label);
      const content = require('fs').readFileSync(fp, 'utf8') as string;
      this.pinnedContext.set(label, content.slice(0, 8000));
      this.post({ type: 'pinContext', label, content: content.slice(0, 8000) });
      this.showInfo(`📌 Pinned file: ${label} (${content.length} chars)`);
    } catch {
      // treat as raw text/snippet
      const body = args.slice(1).join(' ');
      if (body) {
        this.pinnedContext.set(sub ?? label, body);
        this.showInfo(`📌 Pinned text: "${sub ?? label}"`);
      } else {
        this.showInfo(`Usage: /pin <file-path> | /pin <label> <content>`);
      }
    }
  }

  // ── Interactive stdin classifier (§terminal) ───────────────────
  // Sub-call: classify if terminal output indicates it's waiting for user input
  async classifyTerminalNeedsInput(terminalOutput: string): Promise<boolean> {
    const model = this.registry.getActiveModel();
    if (!model || !terminalOutput.trim()) return false;
    const apiKey = await this.registry.getApiKey(model.id);
    let answer = '';
    try {
      await this.llm.streamChat(model, apiKey,
        [{ role: 'system', content: 'You are a terminal input classifier. Answer only YES or NO.' },
         { role: 'user',   content: `Does this terminal output indicate the program is waiting for user input (YES) or not (NO)?\n\nTerminal output:\n${terminalOutput.slice(-500)}` }],
        { maxTokens: 5, temperature: 0.0 },
        c => { if (c.type === 'delta' && c.content) answer += c.content; }
      );
    } catch { return false; }
    return answer.trim().toUpperCase().startsWith('YES');
  }

  // ── KI auto-creation (§22) ─────────────────────────────────────
  private async autoCreateKI(responseText: string): Promise<void> {
    const model  = this.registry.getActiveModel();
    if (!model) return;
    const apiKey = await this.registry.getApiKey(model.id);
    let extraction = '';
    try {
      await this.llm.streamChat(model, apiKey,
        [{ role: 'system', content: 'Extract reusable knowledge from this response. For each important fact, pattern, or lesson, output one line: "KI: [title] | content". Max 3 items. Skip trivial info.' },
         { role: 'user', content: responseText.slice(0, 2000) }],
        { maxTokens: 256, temperature: 0.2 },
        c => { if (c.type === 'delta' && c.content) extraction += c.content; }
      );
    } catch { return; }
    const created = this.kb.autoCreate(extraction);
    if (created.length) {
      this.post({ type: 'systemMessage', text: `💡 Auto-created ${created.length} knowledge item(s): ${created.map(i => `"${i.title}"`).join(', ')}` });
    }
  }

  // ── Auto-checkpoint (§5) — triggered at 85% token capacity ────
  private async autoCheckpoint(
    model: import('./ModelRegistry').ModelConfig,
    apiKey: string,
    messages: ChatMessage[],
    maxTokens: number,
    temperature: number
  ): Promise<void> {
    this.post({ type: 'systemMessage', text: '⚡ Context near limit — generating auto-checkpoint summary...' });
    const summaryPrompt: ChatMessage[] = [
      ...messages,
      { role: 'user', content: 'SYSTEM: Context window is 85% full. Summarize the conversation so far into a compact checkpoint. Include: (1) original task, (2) what has been done, (3) current state of files changed, (4) open questions or next steps. Be concise but complete.' }
    ];
    let summary = '';
    try {
      await this.llm.streamChat(model, apiKey, summaryPrompt, { maxTokens: 1024, temperature: 0.3 }, chunk => {
        if (chunk.type === 'delta' && chunk.content) summary += chunk.content;
      });
    } catch { summary = '[auto-checkpoint: summary failed]'; }
    const cpMsg: ChatMessage = { role: 'assistant', content: `[AUTO-CHECKPOINT]\n${summary}` };
    this.traj.saveCheckpoint(`auto_${Date.now()}`);
    // Collapse history to keep only the last 4 exchanges + the summary
    const tail = this.history.slice(-4);
    this.history = [cpMsg, ...tail];
    this.traj.addMessage(cpMsg, 'auto_checkpoint');
    this.post({ type: 'systemMessage', text: '✅ Auto-checkpoint created. History compacted.' });
  }

  // ── FastApply (§7) — use fast model to apply code edits ────────
  // If ragAssistant.fastApplyModel is set, use that model to apply
  // ReplacementChunks. Falls back to direct edit_file if fast model unavailable.
  private async fastApplyEdit(
    filePath: string,
    oldStr: string,
    newStr: string
  ): Promise<{ ok: boolean; output: string }> {
    const cfg         = vscode.workspace.getConfiguration('ragAssistant');
    const fastModelId = cfg.get<string>('fastApplyModel') ?? '';
    const model       = this.registry.getActiveModel();
    if (!model) return { ok: false, output: 'No model configured.' };

    // If no fast model configured, fall through to standard edit_file
    const fastModel = fastModelId
      ? this.registry.getModels().find(m => m.id === fastModelId || m.modelId === fastModelId)
      : null;

    const fs   = require('fs')  as typeof import('fs');
    const path = require('path') as typeof import('path');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const fp   = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);

    let fileContent: string;
    try { fileContent = fs.readFileSync(fp, 'utf8'); }
    catch { return { ok: false, output: `Cannot read file: ${filePath}` }; }

    if (!fastModel) {
      // Standard replacement
      if (!fileContent.includes(oldStr)) return { ok: false, output: `old_str not found in ${filePath}` };
      fs.writeFileSync(fp, fileContent.replace(oldStr, newStr), 'utf8');
      return { ok: true, output: `FastApply (direct): applied edit to ${filePath}` };
    }

    // Use Gemini 2.5 Flash (or configured fast model) to apply the change
    const apiKey = await this.registry.getApiKey(fastModel.id);
    const prompt = `You are an expert code editor. Apply EXACTLY this change to the file content.

FILE PATH: ${filePath}
ORIGINAL CONTENT:
\`\`\`
${fileContent.slice(0, 6000)}
\`\`\`

FIND THIS EXACT TEXT:
\`\`\`
${oldStr}
\`\`\`

REPLACE WITH:
\`\`\`
${newStr}
\`\`\`

Output ONLY the complete modified file content with no other text, no markdown fences, no explanation.`;

    let result = '';
    try {
      await this.llm.streamChat(fastModel, apiKey,
        [{ role: 'user', content: prompt }],
        { maxTokens: 8192, temperature: 0.0 },
        c => { if (c.type === 'delta' && c.content) result += c.content; }
      );
    } catch (e) {
      // Fall back to direct replacement on FastApply model error
      if (fileContent.includes(oldStr)) {
        fs.writeFileSync(fp, fileContent.replace(oldStr, newStr), 'utf8');
        return { ok: true, output: `FastApply fallback (direct): applied edit to ${filePath}` };
      }
      return { ok: false, output: `FastApply error: ${e}` };
    }

    if (result.trim()) {
      fs.writeFileSync(fp, result, 'utf8');
      return { ok: true, output: `FastApply (${fastModel.modelId}): applied edit to ${filePath}` };
    }
    return { ok: false, output: 'FastApply model returned empty output.' };
  }

  // ── Revert command — roll back FILE_CHANGE steps (§7) ───────────
  private async handleRevert(args: string[]): Promise<void> {
    const changes = this.traj.getFileChanges();
    if (!changes.length) { this.showInfo('No recorded file edits to revert.'); return; }

    if (!args[0]) {
      const list = changes.slice(-10).map((c, i) => `${i + 1}. ${c.path}`).join('\n');
      this.showInfo(`Recorded file edits (last 10):\n${list}\n\nUsage:\n/revert last — undo last edit\n/revert <N> — undo last N edits\n/revert all — undo all edits`);
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const fs   = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');

    let toRevert: Array<{ path: string; before: string }> = [];
    if (args[0] === 'all') {
      toRevert = [...changes];
    } else if (args[0] === 'last') {
      const last = changes[changes.length - 1];
      if (last) toRevert = [last];
    } else {
      const n = parseInt(args[0], 10);
      if (isNaN(n) || n < 1) { this.showInfo('Usage: /revert last | all | <N>'); return; }
      toRevert = changes.slice(-n);
    }

    // Deduplicate: for same file, keep only the earliest snapshot
    const seen = new Map<string, string>();
    for (const c of toRevert) {
      if (!seen.has(c.path)) seen.set(c.path, c.before);
    }

    let reverted = 0;
    for (const [filePath, before] of seen.entries()) {
      try {
        const fp = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, before, 'utf8');
        reverted++;
      } catch (e) {
        this.showInfo(`❌ Failed to revert ${filePath}: ${e}`);
      }
    }
    this.showInfo(`✅ Reverted ${reverted} file(s): ${[...seen.keys()].join(', ')}`);
  }

  // ── Helper UI methods ──────────────────────────────────────────
  private showModelPicker(): void {
    const models  = this.registry.getModels();
    const active  = this.registry.getActiveModel();
    const text    = models.map(m => `• ${m.id === active?.id ? '▶ ' : '  '}${m.name} (${m.modelId})`).join('\n');
    this.post({
      type: 'systemMessage',
      text: `**Models:**\n${text}\n\nUse the dropdown above to switch models.`
    });
  }

  private showToolsList(): void {
    const builtIn = TOOL_DEFS.map(t => `• \`${t.function.name}\` — ${t.function.description}`);
    const mcp     = this.mcp.getToolDefs().map(t => `• \`${t.function.name}\` — ${t.function.description}`);
    const all     = [...builtIn, ...(mcp.length ? ['', '**MCP Tools:**', ...mcp] : [])];
    this.post({ type: 'systemMessage', text: `**Available Tools:**\n${all.join('\n')}` });
  }

  private async showContext(): Promise<void> {
    const sys = await this.assembler.buildSystemPrompt('', { includeRAG: false });
    this.post({
      type: 'systemMessage',
      text: `**Current System Prompt** (layers 1,2,4,6,7 — RAG excluded):\n\`\`\`\n${sys.slice(0, 1000)}\n\`\`\``
    });
  }

  private showAnalytics(args: string): void {
    if (/^reset/i.test(args.trim())) { this.analytics.reset(); this.showInfo('Analytics cleared.'); return; }
    const model = this.registry.getActiveModel();
    this.showInfo(this.analytics.report({
      title:         this.sessions.current().title || 'New session',
      messages:      this.history.filter(m => m.role === 'user').length,
      contextTokens: this.lastCtx.tokens || estimateTokens(this.history),
      contextWindow: this.lastCtx.max || (vscode.workspace.getConfiguration('ragAssistant').get<number>('contextWindow') ?? 24000),
      model:         model ? model.name : '(none)',
      mode:          this.mode,
      role:          this.activeRole
    }));
  }

  private showHelp(): void {
    const help = [
      '**Autopilot — Slash Commands**',
      '',
      '**Chat**',
      '`/new` — Start new conversation',
      '`/model` — List available models',
      '`/tools` — List available tools',
      '`/context` — Show current system prompt context',
      '`/analytics` — Token usage, active hours, models and tools used',
      '',
      '**Planning**',
      '`/plan [task]` — 4-phase planning mode',
      '`/fix` — Auto-fix current file diagnostics',
      '`/diag` — Show IDE diagnostics',
      '',
      '**Battle Mode**',
      '`/battle [prompt]` — Compare 2 models side-by-side',
      '',
      '**Agent Roles**',
      '`/agent [role]` — Switch agent role',
      `Available roles: ${['default', ...Object.keys(AGENT_PROMPTS)].join(', ')}`,
      '',
      '**Checkpoints**',
      '`/checkpoint save [name]` — Save conversation state',
      '`/checkpoint list` — List checkpoints',
      '`/checkpoint restore <id>` — Restore checkpoint',
      '`/fork [checkpoint-id]` — Fork from checkpoint',
      '`/revert [n]` — Roll back last N file edits',
      '',
      '**Knowledge Base**',
      '`/knowledge add <title> | <content>` — Add knowledge item',
      '`/knowledge list` — List knowledge items',
      '`/knowledge search <query>` — Search knowledge',
      '`/knowledge delete <id>` — Delete item',
      '',
      '**RAG**',
      '`/rag` — Toggle workspace RAG search on/off',
      '',
      '**Subagent / Teamwork**',
      '`/subagent <task>` — Run task through Orchestrator (Architect → Dev → Reviewer)',
      '`/orchestrate <task>` — Same as /subagent',
      '',
      '**Sidecar Processes**',
      '`/sidecar start <name> <command>` — Start background process',
      '`/sidecar stop <name>` — Stop background process',
      '`/sidecar list` — List running sidecars',
      '`/sidecar logs <name>` — View sidecar output',
      '',
      '**Security & Terminal**',
      '`/security [off]` — Toggle PolicyGuardian security checks',
      '`/terminal` — Show last terminal output in context',
    ];
    this.post({ type: 'systemMessage', text: help.join('\n') });
  }

  private showInfo(text: string): void {
    this.post({ type: 'systemMessage', text });
  }

  // ── Post helpers ──────────────────────────────────────────────
  private postModels(): void {
    const models = this.registry.getModels();
    const active = this.registry.getActiveModel();
    this.post({
      type:     'models',
      models:   models.map(m => ({ id: m.id, name: m.name, provider: m.provider, modelId: m.modelId, description: m.description, family: m.family, variant: m.variant })),
      activeId: active?.id ?? ''
    });
  }

  private postStatus(): void {
    this.post({
      type:       'status',
      ragEnabled: this.ragEnabled,
      role:       this.activeRole,
      diagErrors: this.diag.getErrorCount(),
      mcpTools:   this.mcp.getToolDefs().length
    });
  }

  // ── File extraction helpers ────────────────────────────────────
  private extractFiles(content: string): PendingFile[] {
    const files: PendingFile[] = [];
    const re = /###\s*FILE:\s*([^\n]+)\n```[^\n]*\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const filePath = m[1].trim().replace(/^\//, '');
      const fileContent = m[2];
      if (filePath && fileContent !== undefined) {
        files.push({ filePath, content: fileContent });
      }
    }
    return files;
  }

  private async createPendingFiles(): Promise<void> {
    if (!this.pendingFiles.length) return;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { vscode.window.showErrorMessage('RAG: Open a workspace folder first.'); return; }

    const created: string[] = [];
    for (const file of this.pendingFiles) {
      try {
        const uri = vscode.Uri.joinPath(root, file.filePath);
        const dir = vscode.Uri.joinPath(uri, '..');
        try { await vscode.workspace.fs.createDirectory(dir); } catch { /* exists */ }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(file.content, 'utf8'));
        created.push(file.filePath);
      } catch (e) {
        vscode.window.showErrorMessage(`RAG: Failed to create ${file.filePath}: ${e}`);
      }
    }
    this.pendingFiles = [];
    this.post({ type: 'filesCreated', files: created });
    if (created.length > 0) {
      vscode.window.showInformationMessage(`RAG: Created ${created.length} file(s)`);
      const first = vscode.Uri.joinPath(root, created[0]);
      vscode.window.showTextDocument(first, { preview: false });
    }
  }

  private loadHtml(): string {
    const p = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview.html');
    return fs.readFileSync(p.fsPath, 'utf8');
  }
}
