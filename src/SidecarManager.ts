import * as vscode from 'vscode';
import * as cp     from 'child_process';

export type RestartPolicy = 'always' | 'on-failure' | 'null';

export interface SidecarConfig {
  name:          string;
  command:       string;
  cwd?:          string;
  restartPolicy: RestartPolicy;  // always | on-failure | null
  maxRestarts?:  number;         // default 5
}

export interface SidecarProcess {
  name:          string;
  command:       string;
  pid:           number;
  status:        'running' | 'stopped' | 'error';
  output:        string;
  started:       string;
  restartPolicy: RestartPolicy;
  restartCount:  number;
}

export class SidecarManager {
  private procs     = new Map<string, { proc: cp.ChildProcess; meta: SidecarProcess; cfg: SidecarConfig }>();
  private statusBar: vscode.StatusBarItem;

  constructor() {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusBar.tooltip = 'RAG Sidecar Processes';
    this.updateStatusBar();
  }

  start(name: string, command: string, cwd?: string, restartPolicy: RestartPolicy = 'null'): SidecarProcess {
    this.stop(name);
    const cfg: SidecarConfig = { name, command, cwd, restartPolicy, maxRestarts: 5 };
    return this.spawn(cfg, 0);
  }

  private spawn(cfg: SidecarConfig, restartCount: number): SidecarProcess {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const proc = cp.spawn(cfg.command, {
      cwd:         cfg.cwd ?? root,
      shell:       true,
      windowsHide: true,
      stdio:       ['ignore', 'pipe', 'pipe']
    });

    const meta: SidecarProcess = {
      name:          cfg.name,
      command:       cfg.command,
      pid:           proc.pid ?? 0,
      status:        'running',
      output:        '',
      started:       new Date().toISOString(),
      restartPolicy: cfg.restartPolicy,
      restartCount
    };

    const appendOutput = (chunk: Buffer | string) => {
      meta.output = (meta.output + String(chunk)).slice(-4096);
    };

    proc.stdout?.on('data', appendOutput);
    proc.stderr?.on('data', appendOutput);

    proc.on('exit', (code, signal) => {
      const failed = code !== 0 && signal !== 'SIGTERM';
      meta.status = failed ? 'error' : 'stopped';
      this.updateStatusBar();

      const maxRestarts = cfg.maxRestarts ?? 5;
      const shouldRestart =
        meta.status === 'error'   && cfg.restartPolicy === 'on-failure' && restartCount < maxRestarts ||
        (code !== null || signal !== 'SIGTERM') && cfg.restartPolicy === 'always' && restartCount < maxRestarts;

      if (shouldRestart) {
        meta.output += `\n[Restarting (${restartCount + 1}/${maxRestarts})...]`;
        setTimeout(() => {
          if (!this.procs.has(cfg.name)) return; // was explicitly stopped
          const newMeta = this.spawn(cfg, restartCount + 1);
          meta.output += `\n[Restarted PID ${newMeta.pid}]`;
        }, 1000 * Math.min(restartCount + 1, 5)); // backoff: 1s, 2s, 3s, 4s, 5s
      }
    });

    proc.on('error', (e) => {
      meta.status  = 'error';
      meta.output += `\nError: ${e.message}`;
      this.updateStatusBar();
    });

    this.procs.set(cfg.name, { proc, meta, cfg });
    this.updateStatusBar();
    return meta;
  }

  // SIGTERM + waitOrKill (architecture §sidecar)
  async stopGraceful(name: string, timeoutMs = 5000): Promise<boolean> {
    const entry = this.procs.get(name);
    if (!entry) return false;
    entry.meta.status      = 'stopped';
    entry.cfg.restartPolicy = 'null'; // prevent auto-restart
    this.procs.delete(name);

    return new Promise(resolve => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          try { entry.proc.kill('SIGKILL'); } catch { /* already dead */ }
          resolve(true);
        }
      }, timeoutMs);

      entry.proc.on('exit', () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(true);
        }
      });

      try { entry.proc.kill('SIGTERM'); } catch { done = true; clearTimeout(timer); resolve(false); }
    });
  }

  stop(name: string): boolean {
    const entry = this.procs.get(name);
    if (!entry) return false;
    entry.meta.status       = 'stopped';
    entry.cfg.restartPolicy = 'null';
    this.procs.delete(name);
    try { entry.proc.kill('SIGTERM'); } catch { /* already dead */ }
    this.updateStatusBar();
    return true;
  }

  stopAll(): void {
    for (const name of [...this.procs.keys()]) this.stop(name);
  }

  list(): SidecarProcess[] {
    return [...this.procs.values()].map(e => ({ ...e.meta }));
  }

  getOutput(name: string): string {
    return this.procs.get(name)?.meta.output ?? '';
  }

  isRunning(name: string): boolean {
    const e = this.procs.get(name);
    return !!e && e.meta.status === 'running';
  }

  private updateStatusBar(): void {
    const running = [...this.procs.values()].filter(e => e.meta.status === 'running').length;
    if (running > 0) {
      this.statusBar.text = `$(gear~spin) ${running} sidecar`;
      this.statusBar.show();
    } else {
      this.statusBar.hide();
    }
  }

  dispose(): void {
    this.stopAll();
    this.statusBar.dispose();
  }
}
