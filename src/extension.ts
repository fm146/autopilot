import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';
import { ChatProvider }               from './ChatProvider';
import { ModelRegistry, ModelConfig } from './ModelRegistry';
import { TrajectoryStore }            from './TrajectoryStore';
import { KnowledgeBase }              from './KnowledgeBase';
import { DiagnosticsCollector }       from './DiagnosticsCollector';
import { PromptAssembler }            from './PromptAssembler';
import { MCPClient }                  from './MCPClient';
import { getRAGEngine }               from './RAGEngine';

let trajectoryStore: TrajectoryStore | undefined;
let mcpClient:       MCPClient       | undefined;

/** The extension was renamed (rag-rebuild.rag-assistant -> hintstechnology.autopilot): bring the stored sessions, knowledge and snapshots along, once. */
function migrateOldStorage(ctx: vscode.ExtensionContext): void {
  try {
    const dest   = ctx.globalStorageUri.fsPath;
    const old    = path.join(path.dirname(dest), 'rag-rebuild.rag-assistant');
    const marker = path.join(dest, '.migrated-from-rag-assistant');
    if (!fs.existsSync(old) || fs.existsSync(marker)) return;
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(old, dest, { recursive: true, force: false, errorOnExist: false });
    fs.writeFileSync(marker, new Date().toISOString());
  } catch { /* start fresh */ }
}

export function activate(ctx: vscode.ExtensionContext): void {
  migrateOldStorage(ctx);
  // Initialize all subsystems
  const registry = new ModelRegistry(ctx);
  const traj     = new TrajectoryStore(ctx);
  const kb       = new KnowledgeBase(ctx);
  const diag     = new DiagnosticsCollector();
  const rag      = getRAGEngine();
  const assembler = new PromptAssembler(rag, diag, kb);
  const mcp      = new MCPClient();

  trajectoryStore = traj;
  mcpClient       = mcp;

  // Start diagnostics listener
  diag.start();
  ctx.subscriptions.push({ dispose: () => diag.dispose() });

  // Load MCP config from workspace (async, non-blocking)
  void mcp.loadConfig();
  ctx.subscriptions.push({ dispose: () => mcp.dispose() });

  // ── ContextChangeEvents (§RAG triggers) ──────────────────────
  // ACTIVE_DOCUMENT: re-index when active file changes
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => rag.invalidate())
  );
  // CURSOR_POSITION: notify provider (debounced — only on meaningful moves)
  let cursorTimer: ReturnType<typeof setTimeout> | undefined;
  ctx.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => {
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => {
        const fn = (provider as unknown as Record<string, (() => void) | undefined>)['_onCursorChange'];
        if (typeof fn === 'function') fn();
      }, 500);
    })
  );
  // OPEN_DOCUMENTS: invalidate when tabs change
  ctx.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => rag.invalidate())
  );

  // FILE_CHANGE: invalidate RAG index when source files change
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cpp,h,md,json}');
  fileWatcher.onDidCreate(() => rag.invalidate());
  fileWatcher.onDidChange(() => rag.invalidate());
  fileWatcher.onDidDelete(() => rag.invalidate());
  ctx.subscriptions.push(fileWatcher);

  // Terminal Diagnostic Pipeline — capture terminal output (VS Code 1.87+)
  try {
    const termApi = vscode.window as unknown as { onDidWriteTerminalData?: (cb: (e: { data: string }) => void) => vscode.Disposable };
    if (typeof termApi.onDidWriteTerminalData === 'function') {
      const tw = termApi.onDidWriteTerminalData((event) => {
        const buf = String((provider as unknown as Record<string, unknown>)['terminalBuf'] ?? '');
        (provider as unknown as Record<string, unknown>)['terminalBuf'] = (buf + event.data).slice(-2048);
      });
      ctx.subscriptions.push(tw);
    }
  } catch {
    // proposed API terminalDataWriteEvent is gated in some hosts (e.g. Antigravity IDE); skip terminal capture
  }

  const provider = new ChatProvider(ctx, registry, traj, kb, diag, assembler, mcp);

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ragAssistant.chatView', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // ── Commands ─────────────────────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand('ragAssistant.newChat', () => provider.newChat())
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('ragAssistant.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'ragAssistant')
    )
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('ragAssistant.addModel', async () => {
      await addModelWizard(registry);
      provider.refreshModels();
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('ragAssistant.setApiKey', async () => {
      await setApiKeyWizard(registry);
    })
  );

  // Optional credentials for Research mode (stored in the IDE's secret storage)
  const secretCommand = (command: string, key: string, title: string, prompt: string) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(command, async () => {
      const value = await vscode.window.showInputBox({ title, prompt, password: true, ignoreFocusOut: true });
      if (value === undefined) return;
      if (value.trim()) await ctx.secrets.store(key, value.trim());
      else await ctx.secrets.delete(key);
      vscode.window.showInformationMessage(value.trim() ? `${title}: saved.` : `${title}: removed.`);
    }));
  secretCommand('ragAssistant.setOpenRouterKey', 'ragAssistant:key:provider:openrouter', 'OpenRouter API key',
    'One key for every OpenRouter model (Nemotron, Xing, Gemma, Inkling…). Get it at openrouter.ai/keys. Leave empty to remove.');
  secretCommand('ragAssistant.setGithubToken', 'ragAssistant:githubToken', 'GitHub token',
    'Optional. Raises the GitHub API limit from 60 to 5000 requests/hour for Research mode. Leave empty to remove.');
  secretCommand('ragAssistant.setBrightDataKey', 'ragAssistant:brightDataKey', 'Bright Data API key',
    'Optional. Bright Data API token for real Google results (SERP API); also set ragAssistant.brightDataZone. Without it Research mode falls back to DuckDuckGo. Leave empty to remove.');

  ctx.subscriptions.push(
    vscode.commands.registerCommand('ragAssistant.indexWorkspace', async () => {
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'RAG: Indexing workspace...', cancellable: false },
        async () => {
          rag.invalidate();
          await rag.ensureIndexed();
          vscode.window.showInformationMessage('RAG: Workspace indexed.');
        }
      );
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('ragAssistant.reloadMCP', async () => {
      mcp.dispose();
      await mcp.loadConfig();
      vscode.window.showInformationMessage('RAG: MCP servers reloaded.');
    })
  );
}

async function addModelWizard(registry: ModelRegistry): Promise<void> {
  const providerOptions: vscode.QuickPickItem[] = [
    { label: 'ollama',     description: 'Local Ollama server  •  http://localhost:11434' },
    { label: 'gemini',     description: 'Google Gemini API   •  generativelanguage.googleapis.com' },
    { label: 'openai',     description: 'OpenAI API          •  api.openai.com' },
    { label: 'openrouter', description: 'OpenRouter.ai       •  openrouter.ai/api  (100+ models)' },
    { label: 'custom',     description: 'Any OpenAI-compatible endpoint' },
  ];

  const pick = await vscode.window.showQuickPick(providerOptions, {
    title: 'Autopilot — Add Model (1/4)',
    placeHolder: 'Select provider type'
  });
  if (!pick) return;

  const provider = pick.label as ModelConfig['provider'];

  const defaults: Record<string, [string, string]> = {
    ollama:     ['http://localhost:11434',                          'llama3.2'],
    gemini:     ['https://generativelanguage.googleapis.com',      'gemini-2.5-flash'],
    openai:     ['https://api.openai.com',                         'gpt-4o'],
    openrouter: ['https://openrouter.ai/api',                      'google/gemini-2.5-flash'],
    custom:     ['http://localhost:8080',                          'my-model'],
  };

  const [defaultUrl, defaultModel] = defaults[provider];

  const baseUrl = await vscode.window.showInputBox({
    title: 'Autopilot — Add Model (2/4)',
    prompt: 'Base URL of the REST API endpoint',
    value: defaultUrl,
    validateInput: v => (v?.startsWith('http') ? null : 'Must start with http:// or https://')
  });
  if (!baseUrl) return;

  const modelId = await vscode.window.showInputBox({
    title: 'Autopilot — Add Model (3/4)',
    prompt: 'Model identifier (as expected by the API)',
    value: defaultModel,
    placeHolder: 'e.g. gemini-2.5-flash, llama3.2, gpt-4o'
  });
  if (!modelId) return;

  const name = await vscode.window.showInputBox({
    title: 'Autopilot — Add Model (4/4)',
    prompt: 'Display name (shown in the model selector)',
    value: `${modelId} (${provider})`
  });
  if (!name) return;

  let apiKey = '';
  if (provider !== 'ollama') {
    const keyInput = await vscode.window.showInputBox({
      title: 'Autopilot — API Key (optional)',
      prompt: 'API key — stored securely in VS Code Secret Storage',
      password: true,
      placeHolder: 'Leave empty for local or key-free endpoints'
    });
    if (keyInput === undefined) return;
    apiKey = keyInput;
  }

  const id = `${provider}-${Date.now()}`;
  await registry.addModel({ id, name, provider, baseUrl, modelId }, apiKey);
  vscode.window.showInformationMessage(`Autopilot: model "${name}" added.`);
}

async function setApiKeyWizard(registry: ModelRegistry): Promise<void> {
  const models = registry.getModels();
  if (!models.length) {
    vscode.window.showWarningMessage('No models configured. Use "RAG: Add Model" first.');
    return;
  }

  const picks: vscode.QuickPickItem[] = models.map(m => ({
    label:       m.name,
    description: `${m.provider}  •  ${m.modelId}`,
    detail:      m.id
  }));

  const picked = await vscode.window.showQuickPick(picks, {
    title: 'Autopilot — Set API Key: select model'
  });
  if (!picked) return;

  const key = await vscode.window.showInputBox({
    title:       'Autopilot — Enter API Key',
    prompt:      `API key for "${picked.label}" (stored in VS Code Secret Storage)`,
    password:    true,
    placeHolder: 'Paste your API key here'
  });
  if (key === undefined) return;

  await registry.setApiKey(picked.detail!, key);
  vscode.window.showInformationMessage(`Autopilot: API key saved for "${picked.label}".`);
}

export function deactivate(): void {
  trajectoryStore?.flush();
  mcpClient?.dispose();
}
