import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import * as cp   from 'child_process';
import { MCPServer } from './MCPClient';
import { httpGetBuffer, extractZip } from './ResearchTools';

/**
 * https://github.com/JackKuo666/Google-Scholar-MCP-Server, run as a local MCP server.
 *
 * It is a Python program, so on first use (and only then) it is prepared in ~/.rag-assistant/mcp-packages/google-scholar:
 * the repository is downloaded as a zip, a private virtual environment is created with a Python 3.10+ that is already on
 * the machine, and its dependencies are installed into it. Nothing is added to the extension itself.
 */
const BASE     = path.join(os.homedir(), '.rag-assistant', 'mcp-packages', 'google-scholar');
const REPO_ZIP = 'https://github.com/JackKuo666/Google-Scholar-MCP-Server/archive/HEAD.zip';

// The server and `scholarly` only work with these majors: mcp 2.x renamed FastMCP and bibtexparser 2.x dropped
// bibtexparser.bibdatabase. `scholarly` is installed without its dependencies: the rest of its list is Sphinx and other
// documentation tooling that it never imports, which would make the first start several minutes slower.
const PIP_PACKAGES = [
  'requests', 'beautifulsoup4', 'mcp[cli]>=1.4.1,<2', 'bibtexparser<2', 'arrow', 'deprecated', 'fake-useragent',
  'free-proxy', 'httpx', 'python-dotenv', 'requests[socks]', 'selenium', 'typing-extensions'
];

export type Progress = (message: string) => void;
interface PythonExe { file: string; args: string[]; version: string; }

function exec(file: string, args: string[], timeoutMs: number, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(((stderr || '') + (stdout || '') || err.message).toString().trim().slice(-700)));
      else resolve(String(stdout) + String(stderr));
    });
  });
}

/** A Python 3.10+ already installed on this machine. (The Windows Store "python" alias is not one: it prints an install hint.) */
export async function findPython(): Promise<PythonExe | undefined> {
  const env = process.env;
  const candidates: Array<{ file: string; args: string[] }> = [];
  if (env['RAG_PYTHON']) candidates.push({ file: env['RAG_PYTHON']!, args: [] });
  candidates.push({ file: 'py', args: ['-3'] }, { file: 'python3', args: [] }, { file: 'python', args: [] });
  const scan = (dir: string, re: RegExp, exe: string) => {
    try { for (const n of fs.readdirSync(dir)) if (re.test(n)) candidates.push({ file: path.join(dir, n, exe), args: [] }); } catch { /* not there */ }
  };
  if (process.platform === 'win32') {
    scan(path.join(env['LOCALAPPDATA'] ?? '', 'Programs', 'Python'), /^Python3\d+$/i, 'python.exe');
    scan(env['ProgramFiles'] ?? 'C:\\Program Files', /^Python3\d+$/i, 'python.exe');
  } else {
    candidates.push({ file: '/usr/local/bin/python3', args: [] }, { file: '/opt/homebrew/bin/python3', args: [] }, { file: '/usr/bin/python3', args: [] });
  }
  let best: (PythonExe & { n: number }) | undefined;
  for (const c of candidates) {
    try {
      const out = await exec(c.file, [...c.args, '--version'], 10_000);
      const m = /Python (\d+)\.(\d+)\.(\d+)/.exec(out);
      if (!m) continue;
      const major = +m[1], minor = +m[2];
      if (major !== 3 || minor < 10) continue;
      const n = minor * 1000 + +m[3];
      if (!best || n > best.n) best = { file: c.file, args: c.args, version: `${m[1]}.${m[2]}.${m[3]}`, n };
    } catch { /* not a usable interpreter */ }
  }
  return best;
}

const venvPython = (): string => path.join(BASE, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');

function findServerScript(): string | undefined {
  const flat = path.join(BASE, 'google_scholar_server.py');           // the zip extractor drops the repository's top folder
  if (fs.existsSync(flat)) return flat;
  try {
    for (const n of fs.readdirSync(BASE)) {
      const p = path.join(BASE, n, 'google_scholar_server.py');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* not downloaded yet */ }
  return undefined;
}

let installing: Promise<{ python: string; script: string }> | undefined;

/** Downloads the server and builds its environment once. Resolves with the interpreter and the script to run. */
export function ensureScholarInstalled(progress: Progress): Promise<{ python: string; script: string }> {
  return installing ??= (async () => {
    const ready = path.join(BASE, 'ready.json');
    const script0 = findServerScript();
    if (fs.existsSync(ready) && script0 && fs.existsSync(venvPython())) return { python: venvPython(), script: script0 };

    const py = await findPython();
    if (!py) throw new Error('Google Scholar MCP needs Python 3.10 or newer, and none was found. Install Python (python.org) or set the RAG_PYTHON environment variable to its path.');
    fs.mkdirSync(BASE, { recursive: true });

    if (!script0) {
      progress('Downloading the Google Scholar MCP server (first use only)…');
      const r = await httpGetBuffer(REPO_ZIP, {}, 5, 30_000_000);
      if (r.status !== 200) throw new Error(`Could not download the Google Scholar MCP server (HTTP ${r.status}).`);
      extractZip(r.body, BASE);
    }
    const script = findServerScript();
    if (!script) throw new Error('The downloaded Google Scholar MCP server has no google_scholar_server.py.');

    if (!fs.existsSync(venvPython())) {
      progress(`Creating a Python ${py.version} environment for it…`);
      await exec(py.file, [...py.args, '-m', 'venv', path.join(BASE, 'venv')], 3 * 60_000);
    }
    progress('Installing its dependencies (first use only, a few minutes)…');
    await exec(venvPython(), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...PIP_PACKAGES], 15 * 60_000);
    await exec(venvPython(), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-deps', 'scholarly>=1.7.0'], 5 * 60_000);
    await exec(venvPython(), ['-c', 'import mcp.server.fastmcp, scholarly, bs4, requests'], 60_000);     // fail now, not at the first search
    fs.writeFileSync(ready, JSON.stringify({ python: py.version, installed: new Date().toISOString() }));
    return { python: venvPython(), script };
  })().finally(() => { installing = undefined; });
}

/** The running server. Started on demand, stopped when the research run ends. */
export class ScholarMcp {
  private server?: MCPServer;
  private starting?: Promise<MCPServer>;

  private async start(progress: Progress): Promise<MCPServer> {
    const { python, script } = await ensureScholarInstalled(progress);
    progress('Starting the Google Scholar MCP server…');
    const server = new MCPServer('google-scholar', {
      command: python, args: [script], env: { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
    });
    await server.start();
    const tools = (await server.listTools()).map(t => t.name);
    if (!tools.includes('search_google_scholar_key_words')) { server.stop(); throw new Error(`The Google Scholar MCP server started but lists unexpected tools: ${tools.join(', ') || '(none)'}`); }
    return server;
  }

  async call(tool: string, args: Record<string, unknown>, progress: Progress): Promise<string> {
    this.server ??= await (this.starting ??= this.start(progress).finally(() => { this.starting = undefined; }));
    return this.server.callTool(tool, args);
  }

  dispose(): void { this.server?.stop(); this.server = undefined; }
}
