// ── SDK Executor (§23) ─────────────────────────────────────────
// Runs Python SDK agents in an isolated virtualenv subprocess.
// Communicates back via stdout/stderr; ANTIGRAVITY_* env vars injected.
// Source: third_party/jetski/language_server/sdk_executor/

import * as vscode from 'vscode';
import * as cp     from 'child_process';
import * as path   from 'path';
import * as fs     from 'fs';
import * as os     from 'os';

export interface SDKAgentSpec {
  // Path to the Python script, or inline code as string
  script?:      string;
  scriptPath?:  string;
  // Environment variables to inject
  env?:         Record<string, string>;
  // Timeout in ms (default 30s)
  timeout?:     number;
  // Conversation/trajectory IDs for context bridging
  conversationId?: string;
  trajectoryId?:   string;
}

export interface SDKResult {
  stdout:         string;
  stderr:         string;
  exitCode:       number;
  conversationId: string;
  success:        boolean;
}

export class SDKExecutor {
  private sdkDir: string;
  private venvPath: string;
  private pythonBin: string;
  private initialized = false;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.sdkDir   = path.join(ctx.globalStorageUri.fsPath, 'sdk_executor');
    this.venvPath = path.join(this.sdkDir, 'venv');
    this.pythonBin = this.getPythonBin();
  }

  // Ensure venv is created and antigravity-sdk stub is installed
  async init(): Promise<void> {
    if (this.initialized) return;

    fs.mkdirSync(this.sdkDir, { recursive: true });

    if (!fs.existsSync(this.venvPath)) {
      await this.runSystem(`${this.pythonBin} -m venv "${this.venvPath}"`, {}, 30000);
    }

    // Install minimal SDK stub if not present
    const sitePackages = this.getSitePackages();
    const sdkStub = path.join(sitePackages, 'antigravity_sdk');
    if (!fs.existsSync(sdkStub)) {
      await this.installSDKStub(sdkStub);
    }

    this.initialized = true;
  }

  // Execute Python SDK agent code (inline script or file path)
  async execute(spec: SDKAgentSpec): Promise<SDKResult> {
    await this.init();

    const convId = spec.conversationId ?? `sdk_${Date.now().toString(36)}`;
    const trajId = spec.trajectoryId  ?? convId;

    // Write inline script to temp file if provided
    let scriptFile = spec.scriptPath;
    let tmpFile: string | undefined;
    if (spec.script && !scriptFile) {
      tmpFile   = path.join(this.sdkDir, `agent_${Date.now().toString(36)}.py`);
      fs.writeFileSync(tmpFile, spec.script, 'utf8');
      scriptFile = tmpFile;
    }

    if (!scriptFile) {
      return { stdout: '', stderr: 'No script provided', exitCode: 1, conversationId: convId, success: false };
    }

    const venvPython = this.getVenvPython();
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ANTIGRAVITY_CONVERSATION_ID: convId,
      ANTIGRAVITY_TRAJECTORY_ID:   trajId,
      ANTIGRAVITY_SDK_TOKEN:       'local_dev_token',
      ANTIGRAVITY_LS_ADDRESS:      'localhost:0',
      PYTHONPATH:                  this.getSitePackages(),
      ...spec.env
    };

    try {
      const result = await this.runSystem(
        `"${venvPython}" "${scriptFile}"`,
        env,
        spec.timeout ?? 30000
      );
      return {
        stdout:         result.stdout,
        stderr:         result.stderr,
        exitCode:       result.code,
        conversationId: convId,
        success:        result.code === 0
      };
    } finally {
      if (tmpFile && fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    }
  }

  // List running SDK sidecars (tracked in globalState)
  listSidecars(): Array<{ id: string; script: string; pid: number; status: string }> {
    return (this.ctx.globalState.get<Array<{ id: string; script: string; pid: number; status: string }>>('sdkSidecars') ?? []);
  }

  // Run as sidecar with restart policy
  async startSidecar(spec: SDKAgentSpec, restartPolicy: 'always' | 'on-failure' | null = null): Promise<string> {
    await this.init();

    const convId = spec.conversationId ?? `sidecar_${Date.now().toString(36)}`;
    const venvPython = this.getVenvPython();

    // Write script to persistent file
    let scriptFile = spec.scriptPath;
    if (spec.script && !scriptFile) {
      scriptFile = path.join(this.sdkDir, `sidecar_${convId}.py`);
      fs.writeFileSync(scriptFile, spec.script, 'utf8');
    }
    if (!scriptFile) return 'No script provided';

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ANTIGRAVITY_CONVERSATION_ID: convId,
      ANTIGRAVITY_SDK_TOKEN:       'local_dev_token',
      ANTIGRAVITY_LS_ADDRESS:      'localhost:0',
      PYTHONPATH:                  this.getSitePackages(),
      ...spec.env
    };

    const spawnSidecar = () => {
      const proc = cp.spawn(`"${venvPython}"`, [`"${scriptFile!}"`], {
        shell:      true,
        detached:   true,
        env,
        windowsHide: true
      });

      const sidecars = this.listSidecars();
      sidecars.push({ id: convId, script: scriptFile!, pid: proc.pid ?? 0, status: 'running' });
      void this.ctx.globalState.update('sdkSidecars', sidecars);

      proc.on('exit', (code) => {
        const list = this.listSidecars();
        const idx  = list.findIndex(s => s.id === convId);
        if (idx >= 0) list[idx].status = `exited(${code ?? '?'})`;
        void this.ctx.globalState.update('sdkSidecars', list);

        const shouldRestart = restartPolicy === 'always' ||
          (restartPolicy === 'on-failure' && code !== 0);
        if (shouldRestart) {
          setTimeout(spawnSidecar, 1000);
        }
      });

      proc.unref();
    };

    spawnSidecar();
    return `SDK sidecar started (conversation_id: ${convId})`;
  }

  // ── Private helpers ──────────────────────────────────────────

  private runSystem(cmd: string, env: Record<string, string>, timeout: number): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      cp.exec(cmd, { env: { ...process.env, ...env } as NodeJS.ProcessEnv, timeout, encoding: 'utf8' },
        (err, stdout, stderr) => {
          resolve({
            stdout:  stdout?.slice(0, 8000) ?? '',
            stderr:  stderr?.slice(0, 2000) ?? (err?.message ?? ''),
            code:    err?.code ?? (err ? 1 : 0)
          });
        }
      );
    });
  }

  private getPythonBin(): string {
    // Try python3 first, then python
    const candidates = process.platform === 'win32'
      ? ['python', 'python3']
      : ['python3', 'python'];
    // Return first candidate; actual availability checked at runtime
    return candidates[0];
  }

  private getVenvPython(): string {
    return process.platform === 'win32'
      ? path.join(this.venvPath, 'Scripts', 'python.exe')
      : path.join(this.venvPath, 'bin', 'python3');
  }

  private getSitePackages(): string {
    // Approximate; real path found via venv after creation
    return process.platform === 'win32'
      ? path.join(this.venvPath, 'Lib', 'site-packages')
      : path.join(this.venvPath, 'lib', 'python3.x', 'site-packages');
  }

  private async installSDKStub(stubDir: string): Promise<void> {
    // Install a minimal antigravity_sdk stub so agents can import it
    fs.mkdirSync(stubDir, { recursive: true });
    const initContent = `# antigravity-sdk stub (local dev)
# In production this is the real antigravity-sdk-python package.

import os

CONVERSATION_ID = os.environ.get('ANTIGRAVITY_CONVERSATION_ID', '')
TRAJECTORY_ID   = os.environ.get('ANTIGRAVITY_TRAJECTORY_ID', '')
SDK_TOKEN       = os.environ.get('ANTIGRAVITY_SDK_TOKEN', '')

def send_message(conversation_id: str, message: str) -> None:
    """Stub: in production sends message to conversation via agentapi."""
    print(f"[SDK] send_message({conversation_id}): {message}")

def get_conversation_metadata(conversation_id: str) -> dict:
    """Stub: returns metadata for a conversation."""
    return {"conversation_id": conversation_id, "status": "active"}

def new_conversation(task: str) -> str:
    """Stub: creates a new conversation and returns its ID."""
    import time
    cid = f"conv_{int(time.time()*1000):x}"
    print(f"[SDK] new_conversation created: {cid}")
    return cid
`;
    fs.writeFileSync(path.join(stubDir, '__init__.py'), initContent, 'utf8');
  }
}

let _executor: SDKExecutor | undefined;
export function getSDKExecutor(ctx: vscode.ExtensionContext): SDKExecutor {
  if (!_executor) _executor = new SDKExecutor(ctx);
  return _executor;
}
