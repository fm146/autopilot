import * as fs   from 'fs';
import * as path from 'path';
import * as cp   from 'child_process';
import { ScholarMcp, Progress } from './ScholarMcp';
import { githubSearchStats, httpGetBuffer, openPapers, formatPapers, arxivSearch, decodeXml, clip } from './ResearchTools';
import { RUN_SHELL } from './ToolRunner';

/**
 * Research mode, second route: when no implementation can be found on GitHub, learn the method from a paper.
 *
 *   GitHub searched, nothing usable  ->  scholar_unlock / automatic
 *   scholar_search (Google Scholar MCP, open indexes as fallback)  ->  paper_read  ->  prototype_write  ->  prototype_run
 *   prototype fails  ->  stackoverflow_search (and google_search) for the error  ->  fix  ->  prototype_run again
 *
 * The paper tools stay locked until GitHub has been searched at least twice without finding a reference.
 */
const str = (d: string) => ({ type: 'string', description: d });

export const PAPER_TOOL_DEFS = [
  { type: 'function' as const, function: { name: 'scholar_unlock',
    description: 'Unlock the paper tools. Allowed ONLY after you searched GitHub at least twice (github_search_repositories / github_fetch_top_repositories) and found no repository ' +
      'that implements the requirement. State why the GitHub results do not fit. Paper research is not used when a GitHub reference exists.',
    parameters: { type: 'object', properties: { reason: str('Why no GitHub repository implements this requirement') }, required: ['reason'] } } },
  { type: 'function' as const, function: { name: 'scholar_search',
    description: 'Search for papers (journals, conferences, preprints) about a method. Uses the Google Scholar MCP server; when Google Scholar blocks the request or returns nothing, ' +
      'OpenAlex and arXiv are used instead and the answer says so. Locked until paper research is unlocked.',
    parameters: { type: 'object', properties: {
      query:       str('Keywords describing the method or problem, e.g. "hierarchical task scheduling heterogeneous multi-GPU"'),
      author:      str('Optional author name'),
      year_from:   { type: 'number', description: 'Optional first publication year' },
      year_to:     { type: 'number', description: 'Optional last publication year' },
      num_results: { type: 'number', description: 'Results to return (default 5, max 10)' },
      source:      str('"scholar" (default) or "open" to search OpenAlex and arXiv directly, which finds readable open-access versions')
    }, required: ['query'] } } },
  { type: 'function' as const, function: { name: 'scholar_author_info',
    description: 'Google Scholar profile of an author: affiliation, interests, citation count and top publications. Locked until paper research is unlocked.',
    parameters: { type: 'object', properties: { author_name: str('Author name') }, required: ['author_name'] } } },
  { type: 'function' as const, function: { name: 'paper_read',
    description: 'Read the text of a paper so you can study its method. Works for arXiv (pass the arXiv id or any arxiv.org link) and for HTML pages; PDFs are not readable, ' +
      'so look for the arXiv or HTML version with scholar_search source="open". Long papers are read in pieces: pass offset to continue. Locked until paper research is unlocked.',
    parameters: { type: 'object', properties: {
      url:       str('arXiv id (e.g. 1706.03762), arxiv.org link, or the URL of an HTML page'),
      offset:    { type: 'number', description: 'Character offset to continue reading from (default 0)' },
      max_chars: { type: 'number', description: 'Characters to return (default 12000, max 20000)' }
    }, required: ['url'] } } },
  { type: 'function' as const, function: { name: 'prototype_write',
    description: 'Write a file of your reimplementation into the prototype folder (.rag/prototype/<session>/). Only this folder is writable in Research mode; use it to rebuild the method from the paper and to write a test for it.',
    parameters: { type: 'object', properties: { path: str('File path inside the prototype folder, e.g. "scheduler.py"'), content: str('Full file content') }, required: ['path', 'content'] } } },
  { type: 'function' as const, function: { name: 'prototype_run',
    description: 'Run a command in the prototype folder to test the reimplementation (for example "python test_scheduler.py" or "node test.js"). Returns the output and the exit code; ' +
      'exit code 0 means it works. The user is asked once to allow running commands there.',
    parameters: { type: 'object', properties: { command: str('The command to run'), timeout_sec: { type: 'number', description: 'Timeout in seconds (default 120, max 600)' } }, required: ['command'] } } }
];
export const PAPER_TOOL_NAMES = new Set(PAPER_TOOL_DEFS.map(d => d.function.name));
const LOCKED = new Set(['scholar_search', 'scholar_author_info', 'paper_read']);

export interface PaperHost {
  workspaceRoot?: string;
  sessionId: string;
  vet:      (command: string) => Promise<void>;           // throws when the command is not allowed
  allowRun: (command: string) => Promise<boolean>;        // asks the user once per research run
  progress: Progress;
}
export interface PaperResult { ok: boolean; output: string; }

// ── reading a paper ─────────────────────────────────────────────────────────────────────────────────
/** HTML of a paper as plain text; LaTeX of formulas is kept from the MathML alt text. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<(script|style|nav|header|footer|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<math[^>]*alttext="([^"]*)"[^>]*>[\s\S]*?<\/math>/gi, (_, t: string) => ' ' + t + ' ')
    .replace(/<h([1-6])[^>]*>/gi, (_, n: string) => '\n\n' + '#'.repeat(+n) + ' ')
    .replace(/<\/(p|div|li|tr|section|figure|table|h\d)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(+d))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

async function fetchPaperText(input: string): Promise<{ text: string; from: string }> {
  const arx = /(?:arxiv\.org\/(?:abs|pdf|html)\/|arxiv:\s*|^)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?(?:[?#].*)?$/i.exec(input.trim())?.[1];
  const tryUrls = arx ? [`https://arxiv.org/html/${arx}`, `https://ar5iv.labs.arxiv.org/html/${arx}`] : [input.trim()];
  let last = '';
  for (const u of tryUrls) {
    try {
      const r = await httpGetBuffer(u, { Accept: 'text/html,*/*' }, 5, 8_000_000);
      if (r.status !== 200) { last = `HTTP ${r.status} from ${u}`; continue; }
      if (r.body.subarray(0, 5).toString('latin1') === '%PDF-') { last = `${u} is a PDF`; continue; }
      const text = htmlToPlain(r.body.toString('utf8'));
      if (text.length > 800) return { text, from: u };
      last = `${u} has no readable text`;
    } catch (e) { last = `${u}: ${e instanceof Error ? e.message : e}`; }
  }
  if (arx) {                                                   // PDF-only preprint: at least the abstract
    try {
      const ps = await arxivSearch(`id_list=${arx}`, 1).catch(() => []);
      void ps;
      const r = await httpGetBuffer(`https://export.arxiv.org/api/query?id_list=${arx}`, {}, 4, 1_000_000);
      const e = r.body.toString('utf8');
      const title = decodeXml(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/.exec(e)?.[1] ?? '');
      const sum = decodeXml(/<summary>([\s\S]*?)<\/summary>/.exec(e)?.[1] ?? '');
      if (title) return { text: `# ${title}\n\n(Only the abstract is available: this preprint has no HTML version.)\n\n${sum}`, from: `arXiv abstract ${arx}` };
    } catch { /* fall through */ }
  }
  throw new Error(`Could not read a paper from "${input}" (${last || 'no source'}). PDFs cannot be read: search for an arXiv or HTML version with scholar_search source="open".`);
}

// ── the research run's paper state ──────────────────────────────────────────────────────────────────
export class PaperResearch {
  unlocked = false;
  private emptySearches = 0;
  prototypeRuns: Array<{ command: string; ok: boolean }> = [];
  papersFound = 0;
  private allowed: boolean | undefined;
  private scholar = new ScholarMcp();

  constructor(private host: PaperHost) {}

  /** The user asked for journals / papers themselves: nothing to look up on GitHub first. */
  static wantsPapers(task: string): boolean {
    return /\b(jurnal|journal|journals|paper|papers|makalah|publikasi|publication|publications|scholar|arxiv|literature|literatur|kajian pustaka|state of the art|penelitian terkait|survey paper)\b/i.test(task);
  }

  get prototypeDir(): string { return path.join(this.host.workspaceRoot ?? process.cwd(), '.rag', 'prototype', this.host.sessionId); }
  get githubSearches(): number { return githubSearchStats.searches; }

  /** Call after every GitHub reference search: unlocks the paper tools when GitHub keeps coming back empty. Returns text to append to the tool's output. */
  noteGithubSearch(): string {
    if (githubSearchStats.lastCount === 0) this.emptySearches++;
    if (!this.unlocked && this.emptySearches >= 2) {
      this.unlocked = true;
      return '\n\n[PAPER RESEARCH UNLOCKED] GitHub returned no repository for two searches. Look for a paper that describes the method: scholar_search, then paper_read, then rebuild it with prototype_write and test it with prototype_run.';
    }
    if (githubSearchStats.lastCount === 0 && !this.unlocked) return '\n\n[NO REPOSITORY FOUND] Try one more keyword variant on GitHub before concluding there is no reference.';
    return '';
  }

  async run(name: string, a: Record<string, unknown>): Promise<PaperResult> {
    try {
      if (LOCKED.has(name) && !this.unlocked) {
        return { ok: false, output: `"${name}" is locked. Paper research is only used when GitHub has no implementation: search GitHub first (github_fetch_top_repositories, at least two keyword variants). ` +
          (this.githubSearches >= 2 ? 'If the repositories you found really do not implement the requirement, call scholar_unlock with the reason.' : `GitHub has been searched ${this.githubSearches} time(s) so far.`) };
      }
      switch (name) {
        case 'scholar_unlock': return this.unlock(String(a.reason ?? ''));
        case 'scholar_search': return { ok: true, output: await this.search(a) };
        case 'scholar_author_info': return { ok: true, output: await this.author(String(a.author_name ?? '')) };
        case 'paper_read': return { ok: true, output: await this.read(a) };
        case 'prototype_write': return { ok: true, output: this.write(String(a.path ?? ''), String(a.content ?? '')) };
        case 'prototype_run': return await this.runPrototype(String(a.command ?? ''), Number(a.timeout_sec ?? 120));
        default: return { ok: false, output: `Unknown paper tool: ${name}` };
      }
    } catch (e) {
      return { ok: false, output: `Error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private unlock(reason: string): PaperResult {
    if (!reason.trim()) return { ok: false, output: 'Give the reason why no GitHub repository fits.' };
    if (this.githubSearches < 2) return { ok: false, output: `GitHub has been searched only ${this.githubSearches} time(s). Search with at least two different keyword variants first; paper research is only for when there is no implementation on GitHub.` };
    this.unlocked = true;
    return { ok: true, output: 'Paper research unlocked. Next: scholar_search for the method, paper_read to study it, prototype_write + prototype_run to rebuild and test it.' };
  }

  private async search(a: Record<string, unknown>): Promise<string> {
    const query = String(a.query ?? '').trim();
    if (!query) throw new Error('"query" is required.');
    const n = Math.max(1, Math.min(10, Number(a.num_results ?? 5)));
    const from = a.year_from ? Number(a.year_from) : undefined, to = a.year_to ? Number(a.year_to) : undefined;
    const author = String(a.author ?? '').trim();
    let note = '';
    if (String(a.source ?? 'scholar') !== 'open') {
      try {
        const tool = author || from || to ? 'search_google_scholar_advanced' : 'search_google_scholar_key_words';
        const args: Record<string, unknown> = { query, num_results: n };
        if (author) args.author = author;
        if (from || to) args.year_range = [from ?? 1900, to ?? new Date().getFullYear()];
        const text = await this.scholar.call(tool, args, this.host.progress);
        const items = parseScholar(text);
        if (items.length) {
          this.papersFound += items.length;
          return `Google Scholar results for "${query}":\n\n` + items.map((p, i) =>
            `${i + 1}. ${p.title}\n   ${p.authors}\n   ${clip(p.abstract, 420)}\n   ${p.url}`).join('\n\n') +
            `\n\nTo read a paper use paper_read with an arXiv id or an HTML link. For one without an open link, search its title with source="open".`;
        }
        note = 'Google Scholar returned no results for this request (it blocks scripted clients with a bot check); showing OpenAlex and arXiv instead.\n\n';
      } catch (e) {
        note = `Google Scholar MCP is not available (${e instanceof Error ? e.message : e}); showing OpenAlex and arXiv instead.\n\n`;
      }
    }
    const papers = await openPapers(author ? `${query} ${author}` : query, n, from, to);
    if (!papers.length) return note + `No papers found for "${query}". Try different keywords (the method's own name, synonyms).`;
    this.papersFound += papers.length;
    return note + `Papers for "${query}":\n\n${formatPapers(papers)}`;
  }

  private async author(name: string): Promise<string> {
    if (!name.trim()) throw new Error('"author_name" is required.');
    const text = await this.scholar.call('get_author_info', { author_name: name }, this.host.progress);
    // the server reports its own failures as {"error": …}; Google Scholar blocking scripted clients is the usual cause
    if (/"error"\s*:/.test(text)) {
      throw new Error(`Google Scholar could not return the profile of "${name}" (${text.replace(/\s+/g, ' ').slice(0, 200)}). ` +
        'It often blocks scripted requests: use scholar_search with source="open" and the author\'s name instead.');
    }
    return text;
  }

  private async read(a: Record<string, unknown>): Promise<string> {
    const url = String(a.url ?? '').trim();
    if (!url) throw new Error('"url" is required.');
    const max = Math.max(2000, Math.min(20000, Number(a.max_chars ?? 12000)));
    const off = Math.max(0, Number(a.offset ?? 0));
    const { text, from } = await fetchPaperText(url);
    const piece = text.slice(off, off + max);
    if (!piece) return `Offset ${off} is past the end of the paper (${text.length} characters).`;
    const end = off + piece.length;
    return `[${from} · characters ${off}-${end} of ${text.length}]\n\n${piece}` + (end < text.length ? `\n\n[… continue with paper_read offset=${end}]` : '\n\n[end of paper]');
  }

  // ── prototype folder ─────────────────────────────────────────────
  private resolveInside(rel: string): string {
    const root = this.prototypeDir;
    const full = path.resolve(root, rel.replace(/^[/\\]+/, ''));
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('The path must stay inside the prototype folder.');
    return full;
  }

  private write(rel: string, content: string): string {
    if (!rel.trim()) throw new Error('"path" is required.');
    if (content.length > 300_000) throw new Error('File too large (300 KB max).');
    const full = this.resolveInside(rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return `Wrote ${Buffer.byteLength(content)} bytes to .rag/prototype/${this.host.sessionId}/${path.relative(this.prototypeDir, full).replace(/\\/g, '/')}`;
  }

  private async runPrototype(command: string, timeoutSec: number): Promise<PaperResult> {
    if (!command.trim()) throw new Error('"command" is required.');
    await this.host.vet(command);
    if (this.allowed === undefined) this.allowed = await this.host.allowRun(command);
    if (!this.allowed) return { ok: false, output: 'The user did not allow running commands in the prototype folder. Describe the reimplementation and the test you would run instead.' };
    fs.mkdirSync(this.prototypeDir, { recursive: true });
    const timeout = Math.min(600, Math.max(5, timeoutSec || 120)) * 1000;
    const result = await new Promise<PaperResult>(resolve => {
      const done = (err: (Error & { code?: number | string | null; killed?: boolean; signal?: string | null }) | null, stdout: string, stderr: string) => {
        let out = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (out.length > 8000) out = '[…output cut…]\n' + out.slice(-8000);
        if (!err) resolve({ ok: true, output: (out || '(no output)') + '\n[exit code 0]' });
        else resolve({ ok: false, output: `${out || '(no output)'}\n` + (err.killed ? `[timed out after ${timeout / 1000}s and was killed]` : `[exit code ${typeof err.code === 'number' ? err.code : (err.signal ?? err.code ?? '?')}]`) });
      };
      const opts = { cwd: this.prototypeDir, timeout, encoding: 'utf8' as const, windowsHide: true, maxBuffer: 10 * 1024 * 1024 };
      if (RUN_SHELL) cp.execFile(RUN_SHELL.file, RUN_SHELL.args(command), opts, done);
      else cp.exec(command, opts, done);
    });
    this.prototypeRuns.push({ command, ok: result.ok });
    return result;
  }

  dispose(): void { this.scholar.dispose(); }
}

/** The server returns the list as one JSON object per line (or one JSON array). */
function parseScholar(text: string): Array<{ title: string; authors: string; abstract: string; url: string }> {
  const items: Array<Record<string, unknown>> = [];
  const t = text.trim();
  if (!t) return [];
  try { const j = JSON.parse(t); if (Array.isArray(j)) items.push(...j); else items.push(j); }
  catch { for (const line of t.split('\n')) { try { items.push(JSON.parse(line)); } catch { /* not JSON */ } } }
  return items.filter(x => x && !x.error && (x.Title || x.title)).map(x => ({
    title: String(x.Title ?? x.title), authors: String(x.Authors ?? x.authors ?? ''), abstract: String(x.Abstract ?? x.abstract ?? ''), url: String(x.URL ?? x.url ?? '')
  }));
}
