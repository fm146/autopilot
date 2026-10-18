import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';

interface Bucket {
  requests: number; prompt: number; completion: number;
  activeMs: number; runs: number; messages: number; tools: number;
}
interface ModelStat { requests: number; prompt: number; completion: number; }
interface Store {
  since:    number;
  days:     Record<string, Bucket>;         // YYYY-MM-DD → totals
  models:   Record<string, ModelStat>;
  tools:    Record<string, number>;
  outcomes: Record<string, number>;         // done | stopped | error
  modes:    Record<string, number>;         // runs per mode
}

/** Gaps between activity longer than this are idle time, not active time. */
const IDLE_GAP_MS = 5 * 60_000;

const emptyBucket = (): Bucket => ({ requests: 0, prompt: 0, completion: 0, activeMs: 0, runs: 0, messages: 0, tools: 0 });
const dayKey = (t = Date.now()): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const fmtN = (n: number): string => n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
function fmtDur(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length);
const padL = (s: string, n: number): string => s.length >= n ? s : ' '.repeat(n - s.length) + s;

export interface SessionSnapshot {
  title: string; messages: number; contextTokens: number; contextWindow: number;
  model: string; mode: string; role: string;
}

/** Usage statistics shown by the /analytics command. Persisted in the extension's global storage. */
export class Analytics {
  private data: Store;
  private file: string;
  private lastTouch = 0;
  private saveTimer?: NodeJS.Timeout;
  private sessionStart = Date.now();
  private sessionActiveMs = 0;
  private sessionTokens = { prompt: 0, completion: 0, requests: 0 };

  constructor(ctx: vscode.ExtensionContext) {
    const dir = ctx.globalStorageUri.fsPath;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* read-only storage: stats stay in memory */ }
    this.file = path.join(dir, 'analytics.json');
    this.data = this.load();
  }

  private load(): Store {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Store;
      if (d && d.days) return { since: d.since ?? Date.now(), days: d.days, models: d.models ?? {}, tools: d.tools ?? {}, outcomes: d.outcomes ?? {}, modes: d.modes ?? {} };
    } catch { /* first run or corrupt file */ }
    return { since: Date.now(), days: {}, models: {}, tools: {}, outcomes: {}, modes: {} };
  }

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch { /* ignore */ }
    }, 1500);
  }

  private today(): Bucket { return (this.data.days[dayKey()] ??= emptyBucket()); }

  /** Call on every user action / model response. Time between touches counts as active unless the gap is an idle one. */
  touch(): void {
    const now = Date.now();
    if (this.lastTouch && now - this.lastTouch <= IDLE_GAP_MS) {
      const gap = now - this.lastTouch;
      this.today().activeMs += gap;
      this.sessionActiveMs += gap;
    }
    this.lastTouch = now;
    this.save();
  }

  message(): void { this.touch(); this.today().messages++; }

  usage(model: string, prompt: number, completion: number): void {
    this.touch();
    const b = this.today();
    b.requests++; b.prompt += prompt; b.completion += completion;
    const m = (this.data.models[model] ??= { requests: 0, prompt: 0, completion: 0 });
    m.requests++; m.prompt += prompt; m.completion += completion;
    this.sessionTokens.prompt += prompt; this.sessionTokens.completion += completion; this.sessionTokens.requests++;
  }

  tool(name: string): void {
    this.today().tools++;
    this.data.tools[name] = (this.data.tools[name] ?? 0) + 1;
    this.save();
  }

  run(mode: string, outcome: string): void {
    this.touch();
    this.today().runs++;
    this.data.outcomes[outcome] = (this.data.outcomes[outcome] ?? 0) + 1;
    this.data.modes[mode] = (this.data.modes[mode] ?? 0) + 1;
  }

  reset(): void {
    this.data = { since: Date.now(), days: {}, models: {}, tools: {}, outcomes: {}, modes: {} };
    this.sessionActiveMs = 0;
    this.sessionTokens = { prompt: 0, completion: 0, requests: 0 };
    this.save();
  }

  private sum(days: number | null): Bucket {
    const total = emptyBucket();
    const from = days === null ? 0 : Date.now() - (days - 1) * 86_400_000;
    const fromKey = days === null ? '' : dayKey(from);
    for (const [k, b] of Object.entries(this.data.days)) {
      if (k < fromKey) continue;
      for (const f of Object.keys(total) as Array<keyof Bucket>) total[f] += b[f];
    }
    return total;
  }

  /** Markdown for the chat. Fenced blocks keep the columns aligned (the chat renderer has no tables). */
  report(s: SessionSnapshot): string {
    const out: string[] = ['**Analytics**', ''];

    const pct = s.contextWindow ? Math.min(100, Math.round(s.contextTokens / s.contextWindow * 100)) : 0;
    const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
    out.push('**This session**', '```',
      `Title          ${s.title}`,
      `Model          ${s.model}`,
      `Mode / agent   ${s.mode} / ${s.role}`,
      `Messages       ${s.messages}`,
      `Active time    ${fmtDur(this.sessionActiveMs)}  (open for ${fmtDur(Date.now() - this.sessionStart)})`,
      `Tokens used    ${fmtN(this.sessionTokens.prompt + this.sessionTokens.completion)}  (in ${fmtN(this.sessionTokens.prompt)} · out ${fmtN(this.sessionTokens.completion)} · ${this.sessionTokens.requests} requests)`,
      `Context        ${bar} ${pct}%  ${fmtN(s.contextTokens)} / ${fmtN(s.contextWindow)}`,
      '```', '');

    const rows: Array<[string, Bucket]> = [['Today', this.sum(1)], ['7 days', this.sum(7)], ['30 days', this.sum(30)], ['All time', this.sum(null)]];
    out.push('**Usage**', '```',
      pad('', 9) + padL('tokens', 9) + padL('in', 9) + padL('out', 9) + padL('requests', 10) + padL('active', 10) + padL('runs', 6),
      ...rows.map(([n, b]) =>
        pad(n, 9) + padL(fmtN(b.prompt + b.completion), 9) + padL(fmtN(b.prompt), 9) + padL(fmtN(b.completion), 9) +
        padL(String(b.requests), 10) + padL(fmtDur(b.activeMs), 10) + padL(String(b.runs), 6)),
      '```', '');

    const models = Object.entries(this.data.models).sort((a, b) => (b[1].prompt + b[1].completion) - (a[1].prompt + a[1].completion));
    if (models.length) {
      const w = Math.min(34, Math.max(...models.map(([n]) => n.length)));
      out.push('**Models used**', '```',
        ...models.slice(0, 8).map(([n, m]) => pad(n.slice(0, w), w + 2) + padL(fmtN(m.prompt + m.completion), 9) + ' tok' + padL(String(m.requests), 8) + ' req'),
        '```', '');
    }

    const tools = Object.entries(this.data.tools).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (tools.length) {
      const w = Math.max(...tools.map(([n]) => n.length));
      out.push('**Top tools**', '```', ...tools.map(([n, c]) => pad(n, w + 2) + padL(String(c), 6)), '```', '');
    }

    const oc = this.data.outcomes, md = this.data.modes;
    const runs = (oc.done ?? 0) + (oc.stopped ?? 0) + (oc.error ?? 0);
    if (runs) {
      out.push('**Runs**', '```',
        `Done ${oc.done ?? 0} · Stopped ${oc.stopped ?? 0} · Error ${oc.error ?? 0}`,
        Object.entries(md).map(([k, v]) => `${k} ${v}`).join(' · '),
        '```', '');
    }

    out.push(`_Tracking since ${new Date(this.data.since).toLocaleDateString()}. Tokens come from the provider when it reports them, otherwise they are estimated (≈4 characters per token). \`/analytics reset\` clears the history._`);
    return out.join('\n');
  }

  dispose(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch { /* ignore */ }
  }
}
