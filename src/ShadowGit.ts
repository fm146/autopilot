import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';
import { execFile } from 'child_process';

/**
 * Local restore points for the workspace, kept in a hidden "shadow" git repository
 * (git dir lives in the extension's storage, work tree is the workspace). It never touches the
 * project's own .git, and it captures everything the agent did, including shell commands.
 */
export class ShadowGit {
  private gitDir: string;
  private root:   string;
  private ready:  Promise<boolean> | undefined;
  private queue:  Promise<unknown> = Promise.resolve();

  constructor(ctx: vscode.ExtensionContext) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    this.root = folder?.uri.fsPath ?? '';
    const ws = (folder?.name ?? 'default').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
    this.gitDir = path.join(ctx.globalStorageUri.fsPath, 'shadow', `${ws}.git`);
  }

  private run(args: string[]): Promise<string> {
    const base = ['--git-dir', this.gitDir, '--work-tree', this.root,
      '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=false',
      '-c', 'user.name=Autopilot', '-c', 'user.email=rag@local', '-c', 'commit.gpgsign=false'];
    const gits = ['git', 'C:\\Program Files\\Git\\cmd\\git.exe'];
    const attempt = (i: number): Promise<string> => new Promise((resolve, reject) => {
      execFile(gits[i], [...base, ...args], { cwd: this.root, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 120_000 },
        (err, stdout, stderr) => {
          if (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT' && i + 1 < gits.length) { resolve(attempt(i + 1)); return; }
            reject(new Error((stderr || err.message).toString().trim()));
          } else resolve(stdout.toString());
        });
    });
    return attempt(0);
  }

  /** Git operations run one at a time (they share one index). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** True when a workspace is open and git is available; creates the shadow repo on first use. */
  available(): Promise<boolean> {
    if (!this.root) return Promise.resolve(false);
    this.ready ??= (async () => {
      try {
        if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) {
          fs.mkdirSync(this.gitDir, { recursive: true });
          await this.run(['init', '-q']);
          fs.mkdirSync(path.join(this.gitDir, 'info'), { recursive: true });
          fs.writeFileSync(path.join(this.gitDir, 'info', 'exclude'),
            ['.git/', 'node_modules/', '.rag/', '.venv/', '__pycache__/', '.next/', '*.vsix', ''].join('\n'));
        }
        return true;
      } catch { return false; }
    })();
    return this.ready;
  }

  /** Commit the current workspace state; returns the commit id (undefined if git is unavailable). */
  snapshot(label: string): Promise<string | undefined> {
    return this.serial(async () => {
      if (!(await this.available())) return undefined;
      try {
        await this.run(['add', '-A', '--ignore-errors']);
        await this.run(['commit', '-q', '--allow-empty', '--no-verify', '-m', label.slice(0, 200)]);
        return (await this.run(['rev-parse', 'HEAD'])).trim();
      } catch { return undefined; }
    });
  }

  /** Files that differ between the restore point and the workspace right now: [status, path]. */
  changesSince(sha: string): Promise<Array<{ status: string; file: string }>> {
    return this.serial(async () => {
      if (!(await this.available())) return [];
      try {
        await this.run(['add', '-A', '--ignore-errors']);
        const out = await this.run(['diff', '--cached', '--name-status', '-z', sha]);
        const parts = out.split('\0').filter(Boolean);
        const res: Array<{ status: string; file: string }> = [];
        for (let i = 0; i + 1 < parts.length; i += 2) res.push({ status: parts[i][0], file: parts[i + 1] });
        return res;
      } catch { return []; }
    });
  }

  /** Put the workspace back to the restore point. A safety snapshot of the current state is taken first. */
  async restore(sha: string): Promise<{ changed: number; safety?: string }> {
    const changes = await this.changesSince(sha);
    const safety = await this.snapshot('safety snapshot before restore');
    return this.serial(async () => {
      // files that did not exist at the restore point are removed; everything else is checked out again
      const added = (await this.run(['diff', '--name-only', '--diff-filter=A', '-z', sha, safety ?? 'HEAD']))
        .split('\0').filter(Boolean);
      for (const rel of added) {
        try { fs.unlinkSync(path.join(this.root, rel)); } catch { /* already gone */ }
      }
      await this.run(['checkout', '-q', sha, '--', '.']);
      return { changed: changes.length, safety };
    });
  }
}
