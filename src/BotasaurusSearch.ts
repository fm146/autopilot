import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import * as cp   from 'child_process';
import { findPython, Progress } from './ScholarMcp';
import { findSystemBrowser } from './McpProvision';

/**
 * Botasaurus (https://github.com/omkarcloud/botasaurus) as the way through bot challenges and IP blocks.
 *
 * Plain HTTP requests to Google and DuckDuckGo are answered with "unusual traffic" pages. Botasaurus drives a real Chrome with
 * its anti-detection patches and human-like behaviour, which is served normal results. It is a Python package, so on first use
 * (and only then) it is installed into a private virtual environment in ~/.rag-assistant/mcp-packages/botasaurus using a
 * Python 3.10+ already on the machine; nothing is added to the extension itself. An installed Google Chrome is required.
 *
 * Used when the plain engines are blocked (web search) and when a page answers web_fetch with a challenge (Cloudflare etc.).
 */
const BASE = process.env['RAG_BOTASAURUS_HOME'] || path.join(os.homedir(), '.rag-assistant', 'mcp-packages', 'botasaurus');

export interface StealthHit { title: string; url: string; snippet: string; }
export interface StealthOptions { progress: Progress; proxy?: string; }

const RUNNER = `import json, sys, re, time
from urllib.parse import urlencode, quote_plus, unquote
from botasaurus.browser import browser, Driver

job = json.loads(open(sys.argv[1], encoding='utf-8').read())

def decorate(headless):
    kw = dict(headless=headless, block_images=True, output=None, create_error_logs=False, reuse_driver=False,
              window_size=(1100, 800), raise_exception=True, close_on_crash=True)
    if job.get('proxy'):
        kw['proxy'] = job['proxy']
    return browser(**kw)

def clean(s):
    return re.sub(r'\\s+', ' ', re.sub(r'<[^>]+>', ' ', s or '')).strip()

def ddg(driver, q, limit):
    driver.get('https://html.duckduckgo.com/html/?q=' + quote_plus(q))
    driver.sleep(0.8)
    html = driver.page_html
    low = html.lower()
    if 'bots use duckduckgo' in low or 'select all squares' in low:
        return None
    hits = []
    for b in re.split(r'class="result__body"|class="result results_links', html)[1:]:
        m = re.search(r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', b, re.S)
        if not m:
            continue
        u = m.group(1).replace('&amp;', '&')
        mm = re.search(r'uddg=([^&]+)', u)
        if mm:
            u = unquote(mm.group(1))
        if u.startswith('//'):
            u = 'https:' + u
        sn = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', b, re.S)
        hits.append({'title': clean(m.group(2)), 'url': u, 'snippet': clean(sn.group(1)) if sn else ''})
        if len(hits) >= limit:
            break
    return hits

def bing(driver, q, limit):
    driver.get('https://www.bing.com/search?' + urlencode({'q': q, 'setlang': 'en'}))
    driver.sleep(0.8)
    rows = driver.run_js("""return Array.from(document.querySelectorAll('li.b_algo')).map(li => {
      const a = li.querySelector('h2 a'); const p = li.querySelector('.b_caption p, p');
      return a ? {title: (li.querySelector('h2') || a).innerText, url: a.href, snippet: p ? p.innerText : ''} : null; }).filter(Boolean);""") or []
    hits = []
    for r in rows:
        u = r['url']
        m = re.search(r'[?&]u=a1([^&]+)', u)
        if m:                                   # Bing wraps links: u=a1<base64url(real url)>
            import base64
            s = m.group(1) + '=' * (-len(m.group(1)) % 4)
            try:
                u = base64.urlsafe_b64decode(s).decode('utf-8')
            except Exception:
                pass
        hits.append({'title': r['title'].strip(), 'url': u, 'snippet': (r.get('snippet') or '').strip()})
        if len(hits) >= limit:
            break
    return hits

def search_impl(driver: Driver, data):
    for name, fn in (('DuckDuckGo', ddg), ('Bing', bing)):
        try:
            hits = fn(driver, data['query'], data['limit'])
        except Exception:
            hits = None
        if hits:
            return {'engine': name, 'hits': hits}
    return {'engine': '', 'hits': []}

def fetch_impl(driver: Driver, data):
    driver.google_get(data['url'], bypass_cloudflare=True)
    driver.sleep(1.5)
    text = driver.run_js("return document.body ? document.body.innerText : ''") or ''
    return {'title': driver.title, 'url': driver.current_url, 'text': text[: data.get('max_chars', 20000)]}

if job['mode'] == 'search':
    result = decorate(True)(search_impl)(job)
else:                                           # Cloudflare and similar need a visible (non-headless) browser
    result = decorate(False)(fetch_impl)(job)

with open(job['out'], 'w', encoding='utf-8') as f:
    json.dump(result, f)
`;

const venvPython = (): string => path.join(BASE, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');

function exec(file: string, args: string[], timeoutMs: number, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(((stderr || '') + (stdout || '') || err.message).toString().trim().slice(-700)));
      else resolve(String(stdout) + String(stderr));
    });
  });
}

let installing: Promise<string> | undefined;

/** Installs Botasaurus once. Resolves with the virtual environment's Python. */
export function ensureBotasaurus(progress: Progress): Promise<string> {
  return installing ??= (async () => {
    if (!findSystemBrowser()) throw new Error('Botasaurus needs Google Chrome (or Edge), and none is installed.');
    const ready = path.join(BASE, 'ready.json');
    fs.mkdirSync(path.join(BASE, 'work'), { recursive: true });
    fs.writeFileSync(path.join(BASE, 'runner.py'), RUNNER, 'utf8');
    if (fs.existsSync(ready) && fs.existsSync(venvPython())) return venvPython();

    const py = await findPython();
    if (!py) throw new Error('Botasaurus needs Python 3.10 or newer, and none was found. Install Python (python.org) or set the RAG_PYTHON environment variable to its path.');
    if (!fs.existsSync(venvPython())) {
      progress(`Creating a Python ${py.version} environment for the stealth browser…`);
      await exec(py.file, [...py.args, '-m', 'venv', path.join(BASE, 'venv')], 3 * 60_000);
    }
    progress('Installing Botasaurus, the stealth browser that gets through bot challenges (first use only, about 5 minutes)…');
    await exec(venvPython(), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'botasaurus'], 20 * 60_000);
    await exec(venvPython(), ['-c', 'from botasaurus.browser import browser, Driver'], 60_000);
    fs.writeFileSync(ready, JSON.stringify({ python: py.version, installed: new Date().toISOString() }));
    return venvPython();
  })().finally(() => { installing = undefined; });
}

let chain: Promise<unknown> = Promise.resolve();          // one browser at a time

async function runJob<T>(job: Record<string, unknown>, opts: StealthOptions, timeoutMs: number): Promise<T> {
  const task = chain.then(async () => {
    const python = await ensureBotasaurus(opts.progress);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const jobFile = path.join(os.tmpdir(), `autopilot-stealth-${id}.json`), outFile = path.join(os.tmpdir(), `autopilot-stealth-${id}.out.json`);
    fs.writeFileSync(jobFile, JSON.stringify({ ...job, out: outFile, proxy: opts.proxy || undefined }), 'utf8');
    try {
      await exec(python, [path.join(BASE, 'runner.py'), jobFile], timeoutMs, path.join(BASE, 'work'));
      if (!fs.existsSync(outFile)) throw new Error('the stealth browser produced no result');
      return JSON.parse(fs.readFileSync(outFile, 'utf8')) as T;
    } finally { for (const f of [jobFile, outFile]) { try { fs.unlinkSync(f); } catch { /* gone */ } } }
  });
  chain = task.catch(() => undefined);
  return task;
}

/** A web search through a real, anti-detection Chrome (DuckDuckGo, then Bing). */
export async function stealthSearch(query: string, limit: number, opts: StealthOptions): Promise<{ engine: string; hits: StealthHit[] }> {
  return runJob<{ engine: string; hits: StealthHit[] }>({ mode: 'search', query, limit }, opts, 120_000);
}

/** A page fetched through the stealth browser, for sites that answer a plain request with a challenge. This one is visible: challenge pages detect headless Chrome. */
export async function stealthFetch(url: string, maxChars: number, opts: StealthOptions): Promise<{ title: string; url: string; text: string }> {
  opts.progress('Opening the page in the stealth browser (a Chrome window appears for a moment)…');
  return runJob<{ title: string; url: string; text: string }>({ mode: 'fetch', url, max_chars: maxChars }, opts, 180_000);
}
