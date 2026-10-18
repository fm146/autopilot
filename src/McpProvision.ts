import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import * as cp   from 'child_process';

/**
 * Lazy provisioning of MCP servers that are launched with `npx <package>`:
 *  - the package is downloaded once, on first use, into ~/.rag-assistant/mcp-packages and run directly with node
 *  - if the package drives a browser (playwright / puppeteer) the Chrome or Edge that is already installed is used;
 *    Chromium is only downloaded when no browser is found at all.
 */
export interface McpLaunch { command: string; args: string[]; env: Record<string, string>; }
type Progress = (message: string) => void;

const BASE = path.join(os.homedir(), '.rag-assistant', 'mcp-packages');
const BROWSER_PKGS = ['playwright', 'playwright-core', 'puppeteer', 'puppeteer-core'];

// ── system browser ───────────────────────────────────────────────
export function findSystemBrowser(): string | undefined {
  const env = process.env;
  const candidates: string[] =
    process.platform === 'win32' ? [
      path.join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ] : process.platform === 'darwin' ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ] : [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser'
    ];
  return candidates.find(p => { try { return !!p && fs.existsSync(p); } catch { return false; } });
}

// Makes Playwright launch the given browser executable whenever the server did not choose one itself.
const PRELOAD = `'use strict';
const Module = require('module');
const exe = process.env.RAG_SYSTEM_BROWSER;
if (exe) {
  const load = Module._load;
  const done = new WeakSet();
  Module._load = function (request) {
    const m = load.apply(this, arguments);
    if (/(^|[\\\\/])playwright(-core)?$/.test(String(request)) && m && m.chromium && !done.has(m.chromium)) {
      done.add(m.chromium);
      for (const fn of ['launch', 'launchPersistentContext']) {
        const orig = m.chromium[fn];
        if (typeof orig !== 'function') continue;
        m.chromium[fn] = function () {
          const a = Array.prototype.slice.call(arguments);
          const i = fn === 'launch' ? 0 : 1;
          const o = Object.assign({}, a[i] || {});
          if (!o.executablePath && !o.channel) o.executablePath = exe;
          a[i] = o;
          return orig.apply(this, a);
        };
      }
    }
    return m;
  };
}
`;

// ── helpers ──────────────────────────────────────────────────────
function run(cmd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(cmd, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().slice(-600)));
      else resolve(stdout.toString());
    });
  });
}

/** `-y @scope/name@1.2 --flag` -> { spec, rest } ; undefined when the command is not a plain npx launch. */
function parseNpx(command: string, args: string[]): { spec: string; rest: string[] } | undefined {
  if (!/^npx(\.cmd)?$/i.test(path.basename(command))) return undefined;
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (/^(-p|--package|-c|--call)$/.test(args[i])) return undefined;      // advanced npx usage: leave it to npx
    i++;
  }
  return i < args.length ? { spec: args[i], rest: args.slice(i + 1) } : undefined;
}

function pkgNameOf(spec: string): string {
  const m = /^(@[^/]+\/[^@]+|[^@]+)(?:@.+)?$/.exec(spec);
  return m ? m[1] : spec;
}

function binEntry(pkgDir: string, pkgName: string): string | undefined {
  const j = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string>; main?: string };
  let rel: string | undefined;
  if (typeof j.bin === 'string') rel = j.bin;
  else if (j.bin) {
    const short = pkgName.split('/').pop() ?? pkgName;
    rel = j.bin[short] ?? Object.values(j.bin)[0];
  } else rel = j.main;
  return rel ? path.join(pkgDir, rel) : undefined;
}

// ── main entry ───────────────────────────────────────────────────
export async function provisionMcpServer(
  command: string, args: string[], env: Record<string, string>, progress: Progress
): Promise<McpLaunch> {
  const npx = parseNpx(command, args);
  if (!npx) return { command, args, env };

  const dir     = path.join(BASE, npx.spec.replace(/[^a-z0-9._-]/gi, '_'));
  const name    = pkgNameOf(npx.spec);
  const pkgDir  = path.join(dir, 'node_modules', ...name.split('/'));
  const outEnv  = { ...env };

  // 1) download the package once
  if (!fs.existsSync(path.join(pkgDir, 'package.json'))) {
    progress(`Downloading MCP package ${npx.spec} (first use only)…`);
    fs.mkdirSync(dir, { recursive: true });
    // --ignore-scripts: skips postinstall hooks such as "playwright install chromium"; we decide about browsers below
    await run(`npm install --prefix "${dir}" "${npx.spec}" --no-audit --no-fund --loglevel=error --ignore-scripts`, 10 * 60_000);
    if (!fs.existsSync(path.join(pkgDir, 'package.json'))) throw new Error(`npm did not install ${npx.spec}`);
  }

  // 2) browser-driving package? reuse the installed Chrome/Edge, download Chromium only if there is none
  const nm = path.join(dir, 'node_modules');
  const needsBrowser = BROWSER_PKGS.some(p => fs.existsSync(path.join(nm, p, 'package.json')));
  const extra: string[] = [];
  if (needsBrowser) {
    const system = findSystemBrowser();
    if (system) {
      Object.assign(outEnv, {
        RAG_SYSTEM_BROWSER: system, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', PUPPETEER_SKIP_DOWNLOAD: '1',
        PUPPETEER_EXECUTABLE_PATH: system, CHROME_PATH: system
      });
      const preload = path.join(BASE, 'rag-browser-preload.js');
      fs.mkdirSync(BASE, { recursive: true });
      fs.writeFileSync(preload, PRELOAD);
      extra.push('--require', preload);
    } else {
      const cli = ['playwright', 'playwright-core'].map(p => path.join(nm, p, 'cli.js')).find(p => fs.existsSync(p));
      const marker = path.join(dir, '.chromium-installed');
      if (cli && !fs.existsSync(marker)) {
        progress('No Chrome or Edge found: downloading Chromium (about 150 MB, first use only)…');
        await run(`node "${cli}" install chromium`, 15 * 60_000);
        fs.writeFileSync(marker, new Date().toISOString());
      }
    }
  }

  // 3) run the package's entry point directly with node (no npx, no network check on every start)
  const entry = binEntry(pkgDir, name);
  if (!entry || !fs.existsSync(entry)) throw new Error(`${name} has no runnable entry point`);
  return { command: 'node', args: [...extra, entry, ...npx.rest], env: outEnv };
}
