import * as https from 'https';
import * as fs    from 'fs';
import * as path  from 'path';
import * as zlib  from 'zlib';
import * as http  from 'http';

/**
 * Built-in research tools (no external servers, no npm dependencies):
 *  - GitHub explorer: summary / directory tree / file content / file search of any public repository
 *  - Google search: official Custom Search API when a key is configured, DuckDuckGo HTML otherwise
 *  - package_info: npm / PyPI / pub.dev / crates.io metadata with documentation links
 */
export interface ResearchOpts {
  githubToken?: string;
  brightKey?:   string;   // Bright Data API token (Google SERP API)
  brightZone?:  string;   // Bright Data SERP zone name
  workspaceRoot?: string; // where github_download_repository saves zips (<root>/.rag/references)
  /** Web search through a real, anti-detection browser (Botasaurus): used when the plain engines are blocked. */
  stealthSearch?: (query: string, limit: number) => Promise<{ engine: string; hits: Array<{ title: string; url: string; snippet: string }> }>;
}

const str = (d: string) => ({ type: 'string', description: d });

export const RESEARCH_TOOL_DEFS = [
  {
    type: 'function' as const,
    function: {
      name: 'github_search_repositories',
      description: 'List GitHub repositories for a topic or technology (e.g. "webgpu c++ game engine", "voxel engine wasm"), ' +
        'most starred first (default: the top 3). To also download them use github_fetch_top_repositories instead.',
      parameters: { type: 'object', properties: {
        query:    str('What to look for: keywords, technologies, topics'),
        language: str('Optional programming language filter, e.g. "C++", "Rust", "TypeScript"'),
        limit:    { type: 'number', description: 'Number of repositories (default 3; use the number the user asked for, max 30)' }
      }, required: ['query'] }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'github_fetch_top_repositories',
      description: 'PREFERRED way to find reference code on GitHub: searches repositories for a topic, keeps the most starred ones, ' +
        'downloads each as a zip into .rag/references, extracts them and returns their local folders. ' +
        'Default is the TOP 3 by stars; if the user asks for another number of repositories, pass exactly that number as count. ' +
        'Then study the code locally with list_directory, grep_search, get_file_outline and view_file.',
      parameters: { type: 'object', properties: {
        query:    str('What to look for: keywords, technologies, topics (e.g. "webgpu c++ game engine")'),
        language: str('Optional programming language filter, e.g. "C++", "Rust"'),
        count:    { type: 'number', description: 'How many of the most starred repositories to fetch. Default 3; use the number the user asked for (max 20)' }
      }, required: ['query'] }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'github_repository_versions',
      description: 'List the releases, tags and branches of a GitHub repository, so a version the user names can be matched to one that exists before downloading it.',
      parameters: { type: 'object', properties: { repo: str('Repository as "owner/name" or a github.com URL') }, required: ['repo'] }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'github_download_repository',
      description: 'Download ONE specific version of a GitHub repository as a zip, save it under .rag/references/<owner>__<repo>[@<ref>].zip, extract it ' +
        'and return where it is. If the user asks for a different version than the one already downloaded (another tag, release, branch or commit), ' +
        'pass it as ref: every version is stored side by side. Then STUDY the code locally with list_directory, grep_search, get_file_outline, view_file. ' +
        'Not rate limited.',
      parameters: { type: 'object', properties: {
        repo:    str('Repository as "owner/name" or a github.com URL'),
        ref:     str('Version to download: a tag or release ("v2.1.0" or "2.1.0"), a branch ("develop") or a commit SHA. Default: the default branch'),
        refresh: { type: 'boolean', description: 'Download again even if this exact version is already stored locally' }
      }, required: ['repo'] }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'github_repository_summary',
      description: 'Summarize a public GitHub repository: description, stars, license, languages, README excerpt and top-level files. Use it first to understand a reference repository.',
      parameters: { type: 'object', properties: {
        repo:   str('Repository as "owner/name" or a github.com URL'),
        branch: str('Branch or tag (default: the default branch)')
      }, required: ['repo'] }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'github_repository_structure',
      description: 'Show the directory tree of a GitHub repository (or of one folder in it) as an ASCII tree.',
      parameters: { type: 'object', properties: {
        repo:   str('Repository as "owner/name" or a github.com URL'),
        path:   str('Folder inside the repository (default: root)'),
        depth:  { type: 'number', description: 'How many levels to show (default 3)' },
        branch: str('Branch or tag (default: the default branch)')
      }, required: ['repo'] }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'github_file_content',
      description: 'Read a file from a GitHub repository, with line numbers.',
      parameters: { type: 'object', properties: {
        repo:       str('Repository as "owner/name" or a github.com URL'),
        path:       str('File path inside the repository'),
        start_line: { type: 'number', description: 'First line to return (1-based)' },
        end_line:   { type: 'number', description: 'Last line to return' },
        branch:     str('Branch or tag (default: the default branch)')
      }, required: ['repo', 'path'] }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'github_search_files',
      description: 'Find files in a GitHub repository whose path contains a text (case-insensitive), e.g. "router" or ".proto".',
      parameters: { type: 'object', properties: {
        repo:   str('Repository as "owner/name" or a github.com URL'),
        query:  str('Text that must appear in the file path'),
        path:   str('Optional folder to search in; use it for very large repositories'),
        branch: str('Branch or tag (default: the default branch)')
      }, required: ['repo', 'query'] }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'google_search',
      description: 'Search the web for documentation, API references or examples (e.g. the docs of a dependency). Returns titles, URLs and snippets.',
      parameters: { type: 'object', properties: {
        query: str('Search query'),
        limit: { type: 'number', description: 'Number of results (default 8, max 10)' }
      }, required: ['query'] }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'package_info',
      description: 'Look up a dependency in its package registry: latest version, description, homepage, repository and documentation links.',
      parameters: { type: 'object', properties: {
        ecosystem: { type: 'string', enum: ['npm', 'pypi', 'pub', 'crates'], description: 'Package registry' },
        name:      str('Package name')
      }, required: ['ecosystem', 'name'] }
    }
  }
];

RESEARCH_TOOL_DEFS.push({
  type: 'function' as const,
  function: {
    name: 'stackoverflow_search',
    description: 'Search Stack Overflow (official API) for a programming error or problem and return the best matching questions with their accepted or ' +
      'top-voted answer, code included. Use it when a build, test or run fails and the error text alone does not tell you the fix: ' +
      'pass the core of the error message (without file paths), optionally with tags such as "python,numpy".',
    parameters: { type: 'object', properties: {
      query: str('The error message or the problem, e.g. "ModuleNotFoundError: No module named numpy" or "TypeError: unhashable type: list"'),
      tags:  str('Optional tags, comma separated, e.g. "python,pandas"'),
      limit: { type: 'number', description: 'Questions to return (default 3, max 5)' }
    }, required: ['query'] }
  }
} as (typeof RESEARCH_TOOL_DEFS)[number]);

export const RESEARCH_TOOL_NAMES = new Set(RESEARCH_TOOL_DEFS.map(d => d.function.name));

// ── HTTP ─────────────────────────────────────────────────────────
interface HttpResult { status: number; body: string; }
interface BufResult  { status: number; body: Buffer; }

function getBuffer(url: string, headers: Record<string, string> = {}, redirects = 5, maxBytes = 3_000_000): Promise<BufResult> {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'GET', timeout: 60_000,
      headers: { 'User-Agent': 'rag-assistant-research', Accept: '*/*', ...headers }
    }, res => {
      const code = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url);
        const h = { ...headers };
        if (next.hostname !== u.hostname) delete h['Authorization'];   // never leak the token to another host
        resolve(getBuffer(next.toString(), h, redirects - 1, maxBytes));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: code, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function get(url: string, headers: Record<string, string> = {}, redirects = 4, maxBytes = 3_000_000): Promise<HttpResult> {
  const r = await getBuffer(url, headers, redirects, maxBytes);
  return { status: r.status, body: r.body.toString('utf8') };
}

export { getBuffer as httpGetBuffer };

/** What the last GitHub reference searches found: the research agent reads it to decide whether paper research is allowed. */
export const githubSearchStats = { searches: 0, lastCount: -1 };

// ── ZIP extraction (no dependencies: central directory + zlib) ───
const SKIP_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tga', 'psd', 'ttf', 'otf', 'woff', 'woff2', 'eot',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'webm', 'mov', 'avi', 'zip', 'gz', 'tgz', '7z', 'rar', 'jar', 'wasm', 'exe', 'dll', 'so',
  'dylib', 'a', 'lib', 'obj', 'o', 'pyc', 'class', 'bin', 'pdf', 'blend', 'fbx', 'glb', 'data', 'pak', 'dat']);

export function extractZip(buf: Buffer, dest: string): { files: number; bytes: number; skipped: number } {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('The download is not a valid zip file.');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (total === 0xFFFF || p === 0xFFFFFFFF) throw new Error('zip64 archive: the repository is too large to download.');

  const root = path.resolve(dest);
  let files = 0, bytes = 0, skipped = 0;
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip (bad central directory).');
    const method   = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size     = buf.readUInt32LE(p + 24);
    const nameLen  = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const extAttr  = buf.readUInt32LE(p + 38);
    const lhOff    = buf.readUInt32LE(p + 42);
    const name     = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const rel = name.split('/').slice(1).join('/');                        // drop the "<repo>-<branch>/" wrapper
    if (!rel || name.endsWith('/')) continue;                              // directories are created on demand
    const isSymlink = ((extAttr >>> 16) & 0o170000) === 0o120000;
    const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
    if (isSymlink || SKIP_EXT.has(ext) || size > 1_500_000 || /(^|\/)(node_modules|\.git)\//.test(rel)) { skipped++; continue; }
    if (bytes + size > 300_000_000) { skipped++; continue; }

    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) { skipped++; continue; }   // zip-slip guard

    const dataStart = lhOff + 30 + buf.readUInt16LE(lhOff + 26) + buf.readUInt16LE(lhOff + 28);
    const raw  = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : undefined;
    if (!data) { skipped++; continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files++; bytes += data.length;
  }
  return { files, bytes, skipped };
}

function post(url: string, body: string, headers: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', timeout: 60_000,
      headers: { 'User-Agent': 'rag-assistant-research', 'Content-Length': Buffer.byteLength(body), ...headers }
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… [truncated, ${s.length - n} more characters]` : s);

// ── GitHub ───────────────────────────────────────────────────────
function parseRepo(input: unknown): { owner: string; name: string } {
  const s = String(input ?? '').trim().replace(/\.git$/, '');
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+)/i.exec(s) ?? /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (!m) throw new Error(`"${s}" is not a GitHub repository. Use "owner/name" or a github.com URL.`);
  return { owner: m[1], name: m[2] };
}

// The unauthenticated GitHub API allows only 60 requests/hour, and models repeat calls: answer repeats from memory.
const ghCache = new Map<string, { at: number; body: string }>();
const GH_TTL = 10 * 60_000;

async function gh<T = unknown>(path: string, o: ResearchOpts, maxBytes = 3_000_000): Promise<T> {
  const key = (o.githubToken ? 't:' : 'u:') + path;
  const hit = ghCache.get(key);
  if (hit && Date.now() - hit.at < GH_TTL) return JSON.parse(hit.body) as T;

  const r = await get('https://api.github.com' + path, {
    Accept: 'application/vnd.github+json',
    ...(o.githubToken ? { Authorization: `Bearer ${o.githubToken}` } : {})
  }, 4, maxBytes);
  if (r.status === 404) throw new Error(`Not found on GitHub (or private): ${path}`);
  if (r.status === 403 || r.status === 429) {
    throw new Error('GitHub API rate limit reached (60 requests/hour without a token). Run "RAG: Set GitHub Token" to raise it to 5000/hour.');
  }
  if (r.status >= 400) throw new Error(`GitHub API error ${r.status}: ${r.body.slice(0, 200)}`);
  if (ghCache.size > 200) ghCache.clear();
  ghCache.set(key, { at: Date.now(), body: r.body });
  return JSON.parse(r.body) as T;
}

interface RepoMeta { description?: string; stargazers_count: number; forks_count: number; default_branch: string; license?: { spdx_id?: string }; pushed_at: string; topics?: string[]; html_url: string; archived?: boolean; }
interface TreeItem { path: string; type: 'blob' | 'tree'; size?: number; }

async function resolveBranch(owner: string, name: string, branch: unknown, o: ResearchOpts): Promise<string> {
  if (branch) return String(branch);
  return (await gh<RepoMeta>(`/repos/${owner}/${name}`, o)).default_branch;
}

/**
 * Recursive file tree. With `folder` only that subtree is requested (paths are then relative to it),
 * which keeps huge repositories (emscripten, chromium…) within a sane response size.
 */
async function repoTree(owner: string, name: string, branch: string, o: ResearchOpts, folder = ''): Promise<{ items: TreeItem[]; truncated: boolean }> {
  const ref = folder ? `${branch}:${folder}` : branch;
  try {
    const t = await gh<{ tree: TreeItem[]; truncated: boolean }>(
      `/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`, o, 60_000_000);
    return { items: t.tree, truncated: t.truncated };
  } catch (e) {
    if (e instanceof Error && /too large/.test(e.message)) {
      throw new Error(`"${folder || 'the repository root'}" is too large to list in one request. Pass a more specific "path" (a sub-folder).`);
    }
    throw e;
  }
}

interface RepoHit { full_name: string; description?: string; stargazers_count: number; language?: string; pushed_at: string; html_url: string; topics?: string[]; archived?: boolean; }

/** Repositories matching `query`, most starred first (GitHub's own sort). Forks are left out. */
async function searchRepos(query: string, language: unknown, perPage: number, o: ResearchOpts): Promise<{ total: number; items: RepoHit[] }> {
  const q = encodeURIComponent(`${query} fork:false` + (language ? ` language:${String(language).replace(/\s+/g, '')}` : ''));
  const r = await gh<{ total_count: number; items: RepoHit[] }>(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=${perPage}`, o);
  return { total: r.total_count, items: r.items };
}

async function githubSearchRepos(a: Record<string, unknown>, o: ResearchOpts): Promise<string> {
  const query = String(a.query ?? '').trim();
  if (!query) throw new Error('"query" is required.');
  const limit = Math.max(1, Math.min(30, Number(a.limit ?? 3)));
  const r = await (async () => { const s = await searchRepos(query, a.language, limit, o); return { total_count: s.total, items: s.items }; })();
  githubSearchStats.searches++; githubSearchStats.lastCount = r.items.length;
  if (!r.items.length) return `No repositories found for "${query}". Try fewer or more general keywords.`;
  return `${r.total_count} repositories match "${query}"; top ${r.items.length} by stars:\n\n` + r.items.map((x, i) =>
    `${i + 1}. ${x.full_name}${x.archived ? ' (archived)' : ''} — ★${x.stargazers_count}` +
    `${x.language ? ' · ' + x.language : ''} · pushed ${x.pushed_at.slice(0, 10)}\n   ${x.description ?? '(no description)'}\n` +
    `${x.topics?.length ? '   topics: ' + x.topics.slice(0, 8).join(', ') + '\n' : ''}   ${x.html_url}`).join('\n\n');
}

/** Describes an extracted repository so the model knows where to look: folder, size, languages, top level, README. */
function describeLocalRepo(dir: string, rel: string, note: string, readmeChars = 3500): string {
  let files = 0, bytes = 0;
  const ext = new Map<string, number>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      files++; bytes += fs.statSync(p).size;
      const x = e.name.includes('.') ? e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase() : '(none)';
      ext.set(x, (ext.get(x) ?? 0) + 1);
    }
  };
  walk(dir);
  const top = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const readme = top.find(e => /^readme(\.|$)/i.test(e.name) && e.isFile());
  return [
    `${note}`,
    `Local folder: ${rel}`,
    `${files} source/text files, ${(bytes / 1024 / 1024).toFixed(1)} MB. Main types: ` +
      [...ext.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `.${k} ×${v}`).join(', '),
    `Top level: ${top.slice(0, 40).map(e => e.name + (e.isDirectory() ? '/' : '')).join('  ')}`,
    `Study it with list_directory / grep_search / get_file_outline / view_file using paths that start with "${rel}/".`,
    readme ? `\n## ${readme.name}\n` + trunc(fs.readFileSync(path.join(dir, readme.name), 'utf8'), readmeChars) : ''
  ].filter(Boolean).join('\n');
}

/** The whole "top repositories" flow in one call: search, keep the most starred, download + extract each one. */
async function githubFetchTop(a: Record<string, unknown>, o: ResearchOpts): Promise<string> {
  const query = String(a.query ?? '').trim();
  if (!query) throw new Error('"query" is required.');
  const count = Math.max(1, Math.min(20, Number(a.count ?? 3)));          // 3 is the default; the user decides how many
  const found = await searchRepos(query, a.language, Math.min(100, count + Math.max(3, Math.ceil(count / 2))), o);   // spares for failed downloads
  githubSearchStats.searches++; githubSearchStats.lastCount = found.items.length;
  if (!found.items.length) return `No repositories found for "${query}". Try fewer or more general keywords.`;

  // With many repositories the summaries stay short so the whole list fits in the model's context
  const readmeChars = count <= 3 ? 1200 : count <= 6 ? 500 : 0;
  const taken: Array<{ r: RepoHit; text: string }> = [], failed: string[] = [];
  let next = 0;
  const worker = async () => {                                            // up to 3 downloads at a time
    while (taken.length + 0 < count) {
      const r = found.items[next++];
      if (!r) return;
      try {
        const text = await githubDownload({ repo: r.full_name }, o, readmeChars);
        if (taken.length < count) taken.push({ r, text });
      } catch (e) {
        failed.push(`${r.full_name} (★${r.stargazers_count}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  taken.sort((x, y) => y.r.stargazers_count - x.r.stargazers_count);       // most starred first, whatever order they finished in
  const body = taken.map(({ r, text }, i) =>
    `### ${i + 1}. ${r.full_name} — ★${r.stargazers_count}${r.language ? ' · ' + r.language : ''}\n${r.description ?? '(no description)'}\n` +
    (readmeChars ? text : text.split('\n').filter(l => /^(Local folder|\d+ source|Top level)/.test(l)).join('\n'))).join('\n\n');
  return `${taken.length} most starred repositories for "${query}" (of ${found.total} matches), downloaded and extracted under .rag/references. ` +
    `Study them locally now with list_directory / grep_search / get_file_outline / view_file.\n\n${body}` +
    (failed.length ? `\n\nSkipped (download failed; next most starred used instead):\n- ${failed.join('\n- ')}` : '');
}

/** Where a git ref can live in an archive URL: commit, branch, tag, or a bare version number ("2.1.0" -> tag "v2.1.0"). */
function archiveUrls(owner: string, name: string, ref: string): string[] {
  const base = `https://github.com/${owner}/${name}/archive`;
  if (!ref) return [`${base}/HEAD.zip`];
  const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');
  return [
    ...(/^[0-9a-f]{7,40}$/i.test(ref) ? [`${base}/${ref}.zip`] : []),
    `${base}/refs/heads/${enc(ref)}.zip`,
    `${base}/refs/tags/${enc(ref)}.zip`,
    ...(/^\d/.test(ref) ? [`${base}/refs/tags/v${enc(ref)}.zip`] : []),
    ...(/^v\d/i.test(ref) ? [`${base}/refs/tags/${enc(ref.slice(1))}.zip`] : [])
  ];
}

/**
 * Downloads one version of a repository next to any others already stored: .rag/references/<owner>__<repo>[@<ref>].
 * A different `ref` (tag, release, branch or commit) is NEVER answered with the copy that is already on disk.
 */
async function githubDownload(a: Record<string, unknown>, o: ResearchOpts, readmeChars = 3500): Promise<string> {
  const { owner, name } = parseRepo(a.repo);
  if (!o.workspaceRoot) throw new Error('Open a folder first: repositories are downloaded into <workspace>/.rag/references.');
  const ref     = String(a.ref ?? a.branch ?? a.version ?? '').trim();
  const key     = `${owner}__${name}` + (ref ? '@' + ref.replace(/[^\w.-]+/g, '_') : '');
  const refsDir = path.join(o.workspaceRoot, '.rag', 'references');
  const dest    = path.join(refsDir, key);
  const rel     = `.rag/references/${key}`;
  const label   = `${owner}/${name}${ref ? '@' + ref : ' (default branch)'}`;

  if (!a.refresh && fs.existsSync(dest) && fs.readdirSync(dest).length) {
    return describeLocalRepo(dest, rel, `${label} is already downloaded.`, readmeChars);
  }

  let zip: BufResult | undefined;
  const tried: string[] = [];
  for (const url of archiveUrls(owner, name, ref)) {                       // github.com/…/archive redirects to codeload: no REST API quota
    tried.push(url.replace(/^.*\/archive\//, ''));
    let r: BufResult;
    try {
      r = await getBuffer(url, {}, 5, 150_000_000);
    } catch (e) {
      if (e instanceof Error && /too large/.test(e.message)) throw new Error(`${label} is larger than 150 MB; pick a smaller reference repository.`);
      throw e;
    }
    if (r.status === 200) { zip = r; break; }
    if (r.status !== 404) throw new Error(`Download failed (HTTP ${r.status}).`);
  }
  if (!zip) {
    throw new Error(ref
      ? `Version "${ref}" of ${owner}/${name} was not found as a branch, tag or commit (tried ${tried.join(', ')}). ` +
        `Call github_repository_versions to list the real tags, releases and branches.`
      : `Repository not found (or private): ${owner}/${name}`);
  }

  fs.mkdirSync(refsDir, { recursive: true });
  fs.writeFileSync(path.join(refsDir, key + '.zip'), zip.body);               // keep the zip, as requested
  fs.rmSync(dest, { recursive: true, force: true });
  const r = extractZip(zip.body, dest);
  const others = fs.existsSync(refsDir)
    ? fs.readdirSync(refsDir).filter(n => n !== key && n.startsWith(`${owner}__${name}`) && !n.endsWith('.zip'))
    : [];
  return describeLocalRepo(dest, rel,
    `Downloaded ${label} (${(zip.body.length / 1024 / 1024).toFixed(1)} MB zip saved as ${rel}.zip), ` +
    `extracted ${r.files} files` + (r.skipped ? ` (${r.skipped} binary, oversized or unsafe files skipped)` : '') + '.' +
    (others.length ? ` Other versions of this repository kept side by side: ${others.join(', ')}.` : ''), readmeChars);
}

/** Tags, releases and branches, so a version the user names can be matched to something that exists. */
async function githubVersions(a: Record<string, unknown>, o: ResearchOpts): Promise<string> {
  const { owner, name } = parseRepo(a.repo);
  const [meta, rels, tags, branches] = await Promise.allSettled([
    gh<RepoMeta>(`/repos/${owner}/${name}`, o),
    gh<Array<{ tag_name: string; name?: string; published_at?: string; prerelease?: boolean }>>(`/repos/${owner}/${name}/releases?per_page=12`, o),
    gh<Array<{ name: string }>>(`/repos/${owner}/${name}/tags?per_page=20`, o),
    gh<Array<{ name: string }>>(`/repos/${owner}/${name}/branches?per_page=20`, o)
  ]);
  const out: string[] = [`# Versions of ${owner}/${name}`];
  if (meta.status === 'fulfilled') out.push(`Default branch: ${meta.value.default_branch}`);
  if (rels.status === 'fulfilled' && rels.value.length) {
    out.push('\nReleases (newest first):\n' + rels.value.map(r =>
      `  ${r.tag_name}${r.name && r.name !== r.tag_name ? ' — ' + r.name : ''}${r.prerelease ? ' (pre-release)' : ''}${r.published_at ? ' · ' + r.published_at.slice(0, 10) : ''}`).join('\n'));
  }
  if (tags.status === 'fulfilled' && tags.value.length) out.push('\nTags: ' + tags.value.map(t => t.name).join(', '));
  if (branches.status === 'fulfilled' && branches.value.length) out.push('\nBranches: ' + branches.value.map(b => b.name).join(', '));
  if (out.length === 1) throw new Error(`Could not read the versions of ${owner}/${name} (not found, private or rate limited).`);
  out.push('\nDownload one with github_download_repository and ref set to a tag, branch or commit; each version is stored side by side.');
  return out.join('\n');
}

async function githubSummary(a: Record<string, unknown>, o: ResearchOpts): Promise<string> {
  const { owner, name } = parseRepo(a.repo);
  const meta   = await gh<RepoMeta>(`/repos/${owner}/${name}`, o);
  const branch = String(a.branch ?? meta.default_branch);
  const [langs, readme, root] = await Promise.allSettled([
    gh<Record<string, number>>(`/repos/${owner}/${name}/languages`, o),
    gh<{ content: string; encoding: string }>(`/repos/${owner}/${name}/readme?ref=${encodeURIComponent(branch)}`, o),
    gh<Array<{ name: string; type: string }>>(`/repos/${owner}/${name}/contents?ref=${encodeURIComponent(branch)}`, o)
  ]);
  const out: string[] = [
    `# ${owner}/${name}${meta.archived ? ' (archived)' : ''}`,
    meta.description ?? '(no description)',
    `Stars ${meta.stargazers_count} · Forks ${meta.forks_count} · License ${meta.license?.spdx_id ?? 'n/a'} · Branch ${branch} · Last push ${meta.pushed_at.slice(0, 10)}`,
    meta.topics?.length ? `Topics: ${meta.topics.join(', ')}` : '',
    meta.html_url
  ];
  if (langs.status === 'fulfilled') {
    const total = Object.values(langs.value).reduce((x, y) => x + y, 0) || 1;
    out.push('Languages: ' + Object.entries(langs.value).slice(0, 6).map(([k, v]) => `${k} ${Math.round(v / total * 100)}%`).join(', '));
  }
  if (root.status === 'fulfilled') {
    out.push('\n## Top-level files\n' + root.value.map(f => (f.type === 'dir' ? f.name + '/' : f.name)).join('  '));
  }
  if (readme.status === 'fulfilled' && readme.value.encoding === 'base64') {
    out.push('\n## README\n' + trunc(Buffer.from(readme.value.content, 'base64').toString('utf8'), 6000));
  }
  return out.filter(Boolean).join('\n');
}

async function githubStructure(a: Record<string, unknown>, o: ResearchOpts): Promise<string> {
  const { owner, name } = parseRepo(a.repo);
  const branch = await resolveBranch(owner, name, a.branch, o);
  const base   = String(a.path ?? '').replace(/^\/+|\/+$/g, '');
  const depth  = Math.max(1, Math.min(8, Number(a.depth ?? 3)));
  const { items, truncated } = await repoTree(owner, name, branch, o, base);   // paths come back relative to `base`

  const prefix = '';
  const inside = items.filter(i => i.path.length > 0);
  if (!inside.length) throw new Error(`Nothing found under "${base || '/'}" in ${owner}/${name}@${branch}.`);

  interface Node { name: string; dir: boolean; kids: Map<string, Node>; }
  const root: Node = { name: '', dir: true, kids: new Map() };
  for (const it of inside) {
    const parts = it.path.slice(prefix.length).split('/');
    if (parts.length > depth) continue;
    let cur = root;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      if (!cur.kids.has(p)) cur.kids.set(p, { name: p, dir: !last || it.type === 'tree', kids: new Map() });
      cur = cur.kids.get(p)!;
    });
  }
  const lines: string[] = [];
  const walk = (n: Node, pad: string) => {
    const kids = [...n.kids.values()].sort((x, y) => Number(y.dir) - Number(x.dir) || x.name.localeCompare(y.name));
    kids.forEach((k, i) => {
      if (lines.length >= 500) return;
      const last = i === kids.length - 1;
      lines.push(pad + (last ? '└── ' : '├── ') + k.name + (k.dir ? '/' : ''));
      walk(k, pad + (last ? '    ' : '│   '));
    });
  };
  walk(root, '');
  return `${owner}/${name}@${branch}${base ? '/' + base : ''}\n${lines.join('\n')}` +
    (lines.length >= 500 ? '\n… output capped at 500 lines; pass a deeper "path" to zoom in.' : '') +
    (truncated ? '\n(GitHub truncated the tree of this very large repository.)' : '');
}

async function githubFile(a: Record<string, unknown>, o: ResearchOpts): Promise<string> {
  const { owner, name } = parseRepo(a.repo);
  const branch = await resolveBranch(owner, name, a.branch, o);
  const path   = String(a.path ?? '').replace(/^\/+/, '');
  if (!path) throw new Error('"path" is required.');
  const r = await get(`https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`,
    o.githubToken ? { Authorization: `Bearer ${o.githubToken}` } : {});
  if (r.status === 404) throw new Error(`File not found: ${owner}/${name}@${branch}/${path}`);
  if (r.status >= 400) throw new Error(`Could not read the file (HTTP ${r.status}).`);
  if (r.body.includes('\u0000')) return `${path} looks like a binary file (${r.body.length} bytes).`;
  const all   = r.body.split('\n');
  const start = Math.max(1, Number(a.start_line ?? 1));
  const end   = Math.min(all.length, Number(a.end_line ?? all.length));
  const text  = all.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
  return `${owner}/${name}@${branch}/${path} (lines ${start}-${end} of ${all.length})\n${trunc(text, 14000)}`;
}

async function githubSearch(a: Record<string, unknown>, o: ResearchOpts): Promise<string> {
  const { owner, name } = parseRepo(a.repo);
  const branch = await resolveBranch(owner, name, a.branch, o);
  const q = String(a.query ?? '').toLowerCase();
  if (!q) throw new Error('"query" is required.');
  const folder = String(a.path ?? '').replace(/^\/+|\/+$/g, '');
  const { items } = await repoTree(owner, name, branch, o, folder);
  const hits = items.filter(i => i.type === 'blob' && i.path.toLowerCase().includes(q)).slice(0, 60);
  const where = `${owner}/${name}@${branch}${folder ? '/' + folder : ''}`;
  return hits.length
    ? `${hits.length} file(s) in ${where} matching "${a.query}" (paths relative to ${folder || 'the root'}):\n` + hits.map(h => h.path + (h.size ? `  (${h.size} B)` : '')).join('\n')
    : `No file path in ${where} contains "${a.query}".`;
}

// ── Stack Overflow (api.stackexchange.com, no key needed; answers are gzip compressed) ─────────────────
interface SoQuestion { question_id: number; title: string; link: string; score: number; is_answered: boolean; accepted_answer_id?: number; tags: string[]; answer_count: number; }
interface SoAnswer   { answer_id: number; question_id: number; score: number; is_accepted: boolean; body: string; }

async function soGet<T>(pathAndQuery: string): Promise<T> {
  const r = await getBuffer('https://api.stackexchange.com/2.3' + pathAndQuery, { 'Accept-Encoding': 'gzip' }, 3, 2_000_000);
  const raw = r.body.length > 2 && r.body[0] === 0x1f && r.body[1] === 0x8b ? zlib.gunzipSync(r.body) : r.body;
  const j = JSON.parse(raw.toString('utf8')) as T & { error_message?: string; error_id?: number };
  if (r.status >= 400 || j.error_id) throw new Error(`Stack Overflow API: ${j.error_message ?? 'HTTP ' + r.status}`);
  return j;
}

/** Stack Overflow answers are HTML: keep the code blocks as fenced code and drop the rest of the markup. */
function soText(html: string): string {
  return html
    .replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, c: string) => '\n```\n' + c.replace(/<[^>]+>/g, '') + '\n```\n')
    .replace(/<\/(p|li|h\d|blockquote)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(+d))
    .replace(/\n{3,}/g, '\n\n').trim();
}

async function stackSearch(a: Record<string, unknown>): Promise<string> {
  const query = String(a.query ?? '').replace(/[A-Za-z]:[\\/][^\s:"']*/g, '').replace(/\s+/g, ' ').trim().slice(0, 280);   // file paths never match anything
  if (!query) throw new Error('"query" is required.');
  const limit = Math.max(1, Math.min(5, Number(a.limit ?? 3)));
  const tags  = String(a.tags ?? '').split(/[,;\s]+/).filter(Boolean).slice(0, 5).join(';');
  const found = await soGet<{ items: SoQuestion[]; quota_remaining?: number }>(
    `/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&answers=1&site=stackoverflow&pagesize=${limit + 3}` + (tags ? `&tagged=${encodeURIComponent(tags)}` : ''));
  const qs = found.items.slice(0, limit);
  if (!qs.length) return `No Stack Overflow question with an answer matches "${query}". Try the core of the error message only, fewer words, or google_search with "site:stackoverflow.com …".`;
  const answers = await soGet<{ items: SoAnswer[] }>(
    `/questions/${qs.map(q => q.question_id).join(';')}/answers?order=desc&sort=votes&site=stackoverflow&filter=withbody&pagesize=100`);
  const out = qs.map((q, i) => {
    const mine = answers.items.filter(x => x.question_id === q.question_id);
    const best = mine.find(x => x.answer_id === q.accepted_answer_id) ?? mine[0];
    return `### ${i + 1}. ${decode(q.title)}  (score ${q.score}${q.accepted_answer_id ? ', accepted answer' : ''}, ${q.tags.slice(0, 5).join(', ')})\n${q.link}\n` +
      (best ? `${best.is_accepted ? 'Accepted answer' : 'Top answer'} (score ${best.score}):\n${trunc(soText(best.body), 1800)}` : '(no answer text returned)');
  });
  return `${qs.length} Stack Overflow result(s) for "${query}":\n\n${out.join('\n\n')}`;
}

// ── open scholarly indexes (fallback when Google Scholar blocks scripted requests) ─────────────────────
export interface Paper { title: string; authors: string; year?: number | string; venue?: string; cited?: number; abstract?: string; url?: string; arxiv?: string; pdf?: string; source: string; }

export const decodeXml = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const getJson = async <T>(url: string): Promise<T> => {
  const r = await getBuffer(url, { Accept: 'application/json' }, 4, 4_000_000);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(r.body.toString('utf8')) as T;
};

async function openAlex(query: string, n: number, yearFrom?: number, yearTo?: number): Promise<Paper[]> {
  const filters: string[] = [];
  if (yearFrom) filters.push(`from_publication_date:${yearFrom}-01-01`);
  if (yearTo)   filters.push(`to_publication_date:${yearTo}-12-31`);
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${n}` +
    `&select=title,publication_year,doi,cited_by_count,authorships,primary_location,open_access,abstract_inverted_index,ids` + (filters.length ? `&filter=${filters.join(',')}` : '');
  const j = await getJson<{ results?: Array<Record<string, any>> }>(url);
  return (j.results ?? []).map(w => {
    const inv = w.abstract_inverted_index as Record<string, number[]> | null;
    let abstract = '';
    if (inv) {
      const words: string[] = [];
      for (const [word, pos] of Object.entries(inv)) for (const p of pos) words[p] = word;
      abstract = words.filter(Boolean).join(' ');
    }
    const loc = w.primary_location ?? {};
    const landing: string | undefined = loc.landing_page_url ?? undefined;
    const arx = /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:v\d+)?(?:\.pdf)?$/i.exec(landing ?? '')?.[1];
    return {
      title: String(w.title ?? '(untitled)'), year: w.publication_year, cited: w.cited_by_count,
      authors: (w.authorships ?? []).slice(0, 4).map((a: any) => a.author?.display_name).filter(Boolean).join(', ') + ((w.authorships ?? []).length > 4 ? ' et al.' : ''),
      venue: loc.source?.display_name, abstract, url: landing ?? (w.doi as string | undefined), arxiv: arx, pdf: w.open_access?.oa_url as string | undefined, source: 'OpenAlex'
    } as Paper;
  });
}

export async function arxivSearch(query: string, n: number): Promise<Paper[]> {
  const terms = query.replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(w => w.length > 2).slice(0, 8).map(w => `all:${w}`).join('+AND+');
  if (!terms) return [];
  const r = await getBuffer(`https://export.arxiv.org/api/query?search_query=${terms}&max_results=${n}&sortBy=relevance`, {}, 4, 2_000_000);
  if (r.status !== 200) return [];
  const xml = r.body.toString('utf8');
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => {
    const e = m[1];
    const id = /<id>https?:\/\/arxiv\.org\/abs\/([^<]+?)(?:v\d+)?<\/id>/.exec(e)?.[1];
    return {
      title: decodeXml(/<title>([\s\S]*?)<\/title>/.exec(e)?.[1] ?? ''),
      authors: [...e.matchAll(/<name>([^<]+)<\/name>/g)].slice(0, 4).map(a => a[1]).join(', '),
      year: /<published>(\d{4})/.exec(e)?.[1], abstract: decodeXml(/<summary>([\s\S]*?)<\/summary>/.exec(e)?.[1] ?? ''),
      url: id ? `https://arxiv.org/abs/${id}` : undefined, arxiv: id, source: 'arXiv'
    } as Paper;
  }).filter(p => p.title);
}

export async function openPapers(query: string, n: number, yearFrom?: number, yearTo?: number): Promise<Paper[]> {
  const [a, b] = await Promise.allSettled([openAlex(query, n, yearFrom, yearTo), arxivSearch(query, Math.max(3, Math.ceil(n / 2)))]);
  const out: Paper[] = a.status === 'fulfilled' ? a.value : [];
  const seen = new Set(out.map(p => p.title.toLowerCase().replace(/\W+/g, '')));
  if (b.status === 'fulfilled') for (const p of b.value) {
    if (yearFrom && p.year && +p.year < yearFrom) continue;
    if (yearTo && p.year && +p.year > yearTo) continue;
    const k = p.title.toLowerCase().replace(/\W+/g, '');
    if (!seen.has(k)) { seen.add(k); out.push(p); } else {                  // same paper: remember its arXiv id
      const dup = out.find(x => x.title.toLowerCase().replace(/\W+/g, '') === k); if (dup && !dup.arxiv) dup.arxiv = p.arxiv;
    }
  }
  return out.slice(0, n + 2);
}

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + '…' : s);
export function formatPapers(ps: Paper[]): string {
  return ps.map((p, i) =>
    `${i + 1}. ${p.title}\n   ${[p.authors, p.venue, p.year, p.cited !== undefined ? `cited by ${p.cited}` : ''].filter(Boolean).join(' · ')}  [${p.source}]\n` +
    (p.abstract ? `   ${clip(p.abstract, 420)}\n` : '') +
    `   ${p.arxiv ? `arXiv:${p.arxiv} (readable with paper_read) · ` : ''}${p.url ?? ''}${p.pdf && p.pdf !== p.url ? ` · pdf: ${p.pdf}` : ''}`).join('\n\n');
}


// ── Web search ───────────────────────────────────────────────────
const decode = (s: string) => s
  .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(+d))
  .replace(/\s+/g, ' ').trim();

async function webSearch(a: Record<string, unknown>, o: ResearchOpts): Promise<string> {
  const query = String(a.query ?? '').trim();
  if (!query) throw new Error('"query" is required.');
  const limit = Math.max(1, Math.min(10, Number(a.limit ?? 8)));

  // Real Google results through Bright Data's SERP API (github.com/luminati-io/google-search-api)
  if (o.brightKey && o.brightZone) {
    const body = JSON.stringify({
      zone: o.brightZone, format: 'raw',
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${limit}&brd_json=1`
    });
    const r = await post('https://api.brightdata.com/request', body, { Authorization: `Bearer ${o.brightKey}`, 'Content-Type': 'application/json' });
    if (r.status === 401 || r.status === 403) throw new Error('Bright Data rejected the API key or zone. Check "RAG: Set Bright Data API Key" and ragAssistant.brightDataZone.');
    if (r.status >= 400) throw new Error(`Bright Data SERP API error ${r.status}: ${r.body.slice(0, 200)}`);
    let data = JSON.parse(r.body) as { organic?: Array<{ title?: string; link?: string; description?: string; snippet?: string }>; body?: string };
    if (!data.organic && typeof data.body === 'string') data = JSON.parse(data.body) as typeof data;   // "json" wrapper format
    const items = (data.organic ?? []).slice(0, limit);
    return items.length
      ? `Google results for "${query}":\n\n` + items.map((x, i) => `${i + 1}. ${x.title ?? ''}\n   ${x.link ?? ''}\n   ${x.description ?? x.snippet ?? ''}`).join('\n\n')
      : `No Google results for "${query}".`;
  }

  return freeWebSearch(query, limit, o);
}

// ── Free web search (no key): DuckDuckGo, then Bing ──────────────
interface SearchHit { title: string; url: string; snippet: string; }
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const searchCache = new Map<string, { at: number; text: string }>();
let lastSearchAt = 0;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** An engine that served a captcha / 403: leave it alone for a while instead of making the block worse. */
class BlockedError extends Error {}
const blockedUntil = new Map<string, number>();
const COOLDOWN_MS = 4 * 60_000;

async function ddgSearch(query: string, limit: number): Promise<SearchHit[]> {
  const r = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { 'User-Agent': BROWSER_UA });
  // A bot challenge is served as HTTP 202; it is NOT "no results"
  if (r.status === 202 || /bots use DuckDuckGo|Select all squares/i.test(r.body)) throw new BlockedError('showed a bot challenge (too many automated queries from this IP)');
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  const hits: SearchHit[] = [];
  for (const b of r.body.split(/class="result__body"|class="result results_links/).slice(1)) {
    const link = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!link) continue;
    let url = link[1].replace(/&amp;/g, '&');
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    const snip = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    hits.push({ title: decode(link[2]), url, snippet: snip ? decode(snip[1]) : '' });
    if (hits.length >= limit) break;
  }
  return hits;
}

async function bingSearch(query: string, limit: number): Promise<SearchHit[]> {
  const r = await get(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(limit + 2, 15)}&setlang=en`,
    { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  if (/captcha|unusual traffic/i.test(r.body)) throw new Error('showed a captcha');
  const hits: SearchHit[] = [];
  for (const b of r.body.split('<li class="b_algo').slice(1)) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    let url = a[1].replace(/&amp;/g, '&');
    try {                                                   // Bing wraps links: u=a1<base64url(real url)>
      const u = new URL(url).searchParams.get('u');
      if (u && u.startsWith('a1')) url = Buffer.from(u.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch { /* keep the link as is */ }
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(b);
    hits.push({ title: decode(a[2]), url, snippet: p ? decode(p[1]) : '' });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * Google itself, scraped the way github.com/tkattkat/google-search-scraper does, minus its dependencies (axios, cheerio).
 * Its Lynx user agent no longer works ("Update your browser"), but Google still serves server-rendered result HTML to an
 * Opera Mini client, and every other client now gets a JavaScript-only page.
 */
async function googleSearch(query: string, limit: number): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query, num: String(Math.min(limit + 2, 20)), hl: 'en' });
  const r = await get(`https://www.google.com/search?${params}`, {
    'User-Agent': 'Opera/9.80 (Android; Opera Mini/36.2.2254/119.132; U; id) Presto/2.12.423 Version/12.16',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: 'CONSENT=PENDING+987; SOCS=CAESHAgBEhIaAB'
  });
  if (r.status === 429 || r.status === 403 || /sorry\/index|unusual traffic/i.test(r.body)) throw new BlockedError(`blocked this IP (HTTP ${r.status}; too many automated queries)`);
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  if (/Update your browser|enablejs|httpservice\/retry/i.test(r.body) && !r.body.includes('<h3')) throw new Error('now requires JavaScript for results');

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const part of r.body.split('<a href="/url?').slice(1)) {                 // every organic result is a /url?q=<target> link
    const href = part.slice(0, part.indexOf('"')).replace(/&amp;/g, '&');
    const target = new URLSearchParams(href.startsWith('?') ? href : '?' + href).get('q');
    if (!target || !/^https?:\/\//i.test(target) || /^https?:\/\/([\w-]+\.)*google(usercontent)?\.[a-z.]+\//i.test(target) || seen.has(target)) continue;   // maps, cache, support pages
    const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(part);
    if (!h3) continue;                                                           // "Cached", "Similar" and other helper links
    seen.add(target);
    const after = part.slice(part.indexOf('</a>') + 4);
    hits.push({ title: decode(h3[1]), url: target, snippet: decode(after).slice(0, 320) });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Wikipedia's own search API: needs no key, is never blocked like a scraped engine, and answers "what is X" questions. */
async function wikipediaSearch(query: string, limit: number): Promise<SearchHit[]> {
  const j = await getJson<{ query?: { search?: Array<{ title: string; snippet: string }> } }>(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&utf8=1`);
  return (j.query?.search ?? []).map(h => ({ title: h.title, url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(h.title.replace(/ /g, '_')), snippet: decode(h.snippet) }));
}

/** What still works when every general engine is blocked: scholarly indexes for papers, Stack Overflow for programming problems. */
async function searchFallback(query: string, limit: number, why: string): Promise<string | undefined> {
  const academic = /\b(journal|journals|jurnal|paper|papers|arxiv|scholar|doi|citation|proceedings|conference|ieee|acm|survey|literature|publication)\b/i.test(query);
  const coding = /site:stackoverflow\.com|stack ?overflow|\b(error|exception|traceback|typeerror|referenceerror|syntaxerror|segfault|undefined reference|cannot find|failed to|modulenotfound|unresolved)\b/i.test(query);
  try {
    if (academic) {
      const papers = await openPapers(query.replace(/\b(journal|journals|jurnal|paper|papers)\b/gi, ' ').replace(/\s+/g, ' ').trim() || query, Math.min(8, limit));
      if (papers.length) return `${why}. Papers for "${query}" from OpenAlex and arXiv instead:\n\n${formatPapers(papers)}`;
    }
    if (coding) {
      const t = await stackSearch({ query: query.replace(/site:\S+/gi, ' ').replace(/stack ?overflow/gi, ' '), limit: Math.min(3, limit) });
      if (!/^No Stack Overflow question/.test(t)) return `${why}. Stack Overflow results instead:\n\n${t}`;
    }
    const wiki = await wikipediaSearch(query.replace(/site:\S+/gi, ' ').trim(), Math.min(5, limit));
    if (wiki.length) return `${why}. Wikipedia results for "${query}" instead (general knowledge only, not a replacement for documentation):\n\n` +
      wiki.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n\n');
  } catch { /* the fallback is a bonus */ }
  return undefined;
}

async function freeWebSearch(query: string, limit: number, o: ResearchOpts = {}): Promise<string> {
  const key = `${limit}|${query.toLowerCase()}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.text;

  const wait = 1200 - (Date.now() - lastSearchAt);          // free engines throttle bursts of automated queries
  if (wait > 0) await sleep(wait);
  lastSearchAt = Date.now();

  const problems: string[] = [];
  // Bing is deliberately NOT used: it returns plausible but unrelated pages to automated queries (checked again), which is worse than failing
  for (const [engine, fn] of [['Google', googleSearch], ['DuckDuckGo', ddgSearch]] as const) {
    const until = blockedUntil.get(engine) ?? 0;
    if (Date.now() < until) { problems.push(`${engine} is cooling down after a block (about ${Math.ceil((until - Date.now()) / 60000)} min left)`); continue; }
    try {
      const hits = await fn(query, limit);
      if (!hits.length) { problems.push(`${engine}: no results`); continue; }
      const text = `${engine} results for "${query}":\n\n` +
        hits.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n\n');
      if (searchCache.size > 100) searchCache.clear();
      searchCache.set(key, { at: Date.now(), text });
      return text;
    } catch (e) {
      if (e instanceof BlockedError) blockedUntil.set(engine, Date.now() + COOLDOWN_MS);
      problems.push(`${engine} ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Both plain engines are blocked: a real Chrome driven by Botasaurus is not (it gets normal result pages)
  if (o.stealthSearch) {
    try {
      const r = await o.stealthSearch(query, limit);
      if (r.hits.length) {
        const text = `${r.engine} results for "${query}" (fetched through a stealth browser, because Google and DuckDuckGo block plain requests):\n\n` +
          r.hits.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n\n');
        if (searchCache.size > 100) searchCache.clear();
        searchCache.set(key, { at: Date.now(), text });
        return text;
      }
      problems.push('stealth browser: no results');
    } catch (e) { problems.push('stealth browser ' + (e instanceof Error ? e.message.split('\n')[0].slice(0, 160) : String(e))); }
  }
  const fallback = await searchFallback(query, limit, 'The web search engines are unavailable (' + problems.join('; ') + ')');
  if (fallback) return fallback;
  throw new Error(`Web search failed: ${problems.join('; ')}. Do not keep retrying web search: the engines throttle bursts of automated queries. ` +
    `Use what still works: stackoverflow_search (programming errors and how-tos), package_info (library docs and versions), the github_* tools (code), ` +
    `web_fetch on a page whose URL you already know (official documentation, arxiv.org), or the paper tools when they are unlocked. ` +
    `Or tell the user to set a Bright Data key ("Autopilot: Set Bright Data API Key") for reliable Google results.`);
}

// ── Package registries ───────────────────────────────────────────
async function packageInfo(a: Record<string, unknown>, o: ResearchOpts): Promise<string> {
  const name = String(a.name ?? '').trim();
  const eco  = String(a.ecosystem ?? '');
  if (!/^[@\w./-]+$/.test(name)) throw new Error(`"${name}" is not a valid package name.`);
  const enc = encodeURIComponent(name).replace('%40', '@');

  if (eco === 'npm') {
    const r = await get(`https://registry.npmjs.org/${enc}/latest`);
    if (r.status === 404) throw new Error(`npm package not found: ${name}`);
    const j = JSON.parse(r.body) as { version: string; description?: string; homepage?: string; license?: string; repository?: { url?: string } | string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    const repoUrl = typeof j.repository === 'string' ? j.repository : j.repository?.url ?? '';
    const out = [`npm ${name}@${j.version}`, j.description ?? '', `License: ${j.license ?? 'n/a'}`, `Homepage: ${j.homepage ?? 'n/a'}`,
      `Repository: ${repoUrl || 'n/a'}`, `Docs: https://www.npmjs.com/package/${name}`,
      j.dependencies ? 'Dependencies: ' + Object.keys(j.dependencies).join(', ') : '',
      j.peerDependencies ? 'Peer dependencies: ' + Object.keys(j.peerDependencies).join(', ') : ''];
    const gm = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(repoUrl.replace(/^git\+/, ''));
    if (gm) {
      try {
        const rd = await gh<{ content: string }>(`/repos/${gm[1]}/${gm[2]}/readme`, o);
        out.push('\n## README\n' + trunc(Buffer.from(rd.content, 'base64').toString('utf8'), 5000));
      } catch { /* README is optional */ }
    }
    return out.filter(Boolean).join('\n');
  }

  if (eco === 'pypi') {
    const r = await get(`https://pypi.org/pypi/${enc}/json`);
    if (r.status === 404) throw new Error(`PyPI package not found: ${name}`);
    const i = (JSON.parse(r.body) as { info: { version: string; summary?: string; home_page?: string; license?: string; project_urls?: Record<string, string>; description?: string; requires_dist?: string[] } }).info;
    return [`PyPI ${name}==${i.version}`, i.summary ?? '', `License: ${i.license || 'n/a'}`, `Homepage: ${i.home_page || 'n/a'}`,
      i.project_urls ? 'Links:\n' + Object.entries(i.project_urls).map(([k, v]) => `  ${k}: ${v}`).join('\n') : '',
      i.requires_dist ? 'Requires: ' + i.requires_dist.slice(0, 20).join(', ') : '',
      '\n## Description\n' + trunc(i.description ?? '', 5000)].filter(Boolean).join('\n');
  }

  if (eco === 'pub') {
    const r = await get(`https://pub.dev/api/packages/${enc}`);
    if (r.status === 404) throw new Error(`pub.dev package not found: ${name}`);
    const l = (JSON.parse(r.body) as { latest: { version: string; pubspec: { description?: string; homepage?: string; repository?: string; dependencies?: Record<string, unknown> } } }).latest;
    return [`pub.dev ${name} ${l.version}`, l.pubspec.description ?? '', `Homepage: ${l.pubspec.homepage ?? 'n/a'}`,
      `Repository: ${l.pubspec.repository ?? 'n/a'}`, `API docs: https://pub.dev/documentation/${name}/latest/`,
      `Package page: https://pub.dev/packages/${name}`,
      l.pubspec.dependencies ? 'Dependencies: ' + Object.keys(l.pubspec.dependencies).join(', ') : ''].filter(Boolean).join('\n');
  }

  if (eco === 'crates') {
    const r = await get(`https://crates.io/api/v1/crates/${enc}`);
    if (r.status === 404) throw new Error(`crates.io package not found: ${name}`);
    const c = (JSON.parse(r.body) as { crate: { max_version: string; description?: string; homepage?: string; documentation?: string; repository?: string } }).crate;
    return [`crates.io ${name} ${c.max_version}`, c.description ?? '', `Homepage: ${c.homepage ?? 'n/a'}`,
      `Documentation: ${c.documentation ?? `https://docs.rs/${name}`}`, `Repository: ${c.repository ?? 'n/a'}`].filter(Boolean).join('\n');
  }

  throw new Error(`Unknown ecosystem "${eco}". Use npm, pypi, pub or crates.`);
}

// ── Dispatcher ───────────────────────────────────────────────────
export async function runResearchTool(name: string, args: Record<string, unknown>, o: ResearchOpts): Promise<string> {
  switch (name) {
    case 'github_search_repositories':  return githubSearchRepos(args, o);
    case 'github_download_repository':  return githubDownload(args, o);
    case 'github_repository_versions':    return githubVersions(args, o);
    case 'github_fetch_top_repositories': return githubFetchTop(args, o);
    case 'github_repository_summary':   return githubSummary(args, o);
    case 'github_repository_structure': return githubStructure(args, o);
    case 'github_file_content':         return githubFile(args, o);
    case 'github_search_files':         return githubSearch(args, o);
    case 'google_search':               return webSearch(args, o);
    case 'package_info':                return packageInfo(args, o);
    case 'stackoverflow_search':        return stackSearch(args);
    default: throw new Error(`Unknown research tool: ${name}`);
  }
}

// exposed for tests only
export const __engines = { googleSearch, ddgSearch, bingSearch };
