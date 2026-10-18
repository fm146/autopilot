import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';

export interface KnowledgeItem {
  id:        string;
  title:     string;
  content:   string;
  tags:      string[];
  created:   string;  // ISO date
  updated?:  string;  // ISO date — set on consolidate
  accessCount?: number;
  lastAccessed?: string;
}

export class KnowledgeBase {
  private storePath: string;
  private items: KnowledgeItem[] = [];

  constructor(ctx: vscode.ExtensionContext) {
    this.storePath = path.join(ctx.globalStorageUri.fsPath, 'knowledge.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        this.items = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as KnowledgeItem[];
      }
    } catch { this.items = []; }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.items, null, 2), 'utf8');
    } catch (e) {
      console.error('KnowledgeBase save error:', e);
    }
  }

  add(title: string, content: string, tags: string[] = []): KnowledgeItem {
    const item: KnowledgeItem = {
      id:      Date.now().toString(36),
      title, content, tags,
      created: new Date().toISOString()
    };
    this.items.push(item);
    this.save();
    return item;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter(i => i.id !== id);
    if (this.items.length < before) { this.save(); return true; }
    return false;
  }

  list(): KnowledgeItem[] { return [...this.items]; }

  get(id: string): KnowledgeItem | undefined { return this.items.find(i => i.id === id); }

  // BM25-like search
  search(query: string, topK = 3): KnowledgeItem[] {
    if (!this.items.length) return [];
    const terms = tokenize(query);
    if (!terms.length) return this.items.slice(0, topK);

    const scored = this.items.map(item => {
      const text   = `${item.title} ${item.content} ${item.tags.join(' ')}`.toLowerCase();
      let score    = 0;
      for (const t of terms) {
        const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        score += (text.match(re) ?? []).length;
      }
      return { item, score };
    }).filter(x => x.score > 0);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(x => x.item);
  }

  // Update an existing item (merge content)
  update(id: string, patch: Partial<Pick<KnowledgeItem, 'title' | 'content' | 'tags'>>): boolean {
    const item = this.items.find(i => i.id === id);
    if (!item) return false;
    if (patch.title)   item.title   = patch.title;
    if (patch.content) item.content = patch.content;
    if (patch.tags)    item.tags    = patch.tags;
    item.updated = new Date().toISOString();
    this.save();
    return true;
  }

  // Auto-create KIs from a conversation summary (§22)
  // Returns new items created / existing items updated
  autoCreate(summaryText: string): KnowledgeItem[] {
    // Parse LLM-generated summary lines starting with "KI:" or "KNOWLEDGE:"
    const created: KnowledgeItem[] = [];
    const lines = summaryText.split('\n');
    for (const line of lines) {
      const m = line.match(/^(?:KI|KNOWLEDGE|LEARN|FACT):\s*\[?([^\]|]+)\]?\s*[|:]\s*(.+)/i);
      if (!m) continue;
      const title   = m[1].trim();
      const content = m[2].trim();
      if (!title || !content) continue;
      // Deduplicate: find by similar title (Jaccard ≥ 0.5)
      const existing = this.items.find(i => jaccardSim(i.title, title) >= 0.5);
      if (existing) {
        existing.content  = `${existing.content}\n\n[Update ${new Date().toISOString().slice(0, 10)}]\n${content}`;
        existing.updated  = new Date().toISOString();
        created.push(existing);
      } else {
        created.push(this.add(title, content, extractTags(title + ' ' + content)));
      }
    }
    if (created.length) this.save();
    return created;
  }

  // Consolidate: merge duplicate items (title Jaccard ≥ 0.6)
  consolidate(): number {
    let merged = 0;
    const used = new Set<string>();
    const result: KnowledgeItem[] = [];
    for (const item of this.items) {
      if (used.has(item.id)) continue;
      const dupes = this.items.filter(
        o => o.id !== item.id && !used.has(o.id) && jaccardSim(item.title, o.title) >= 0.6
      );
      if (dupes.length) {
        item.content = [item.content, ...dupes.map(d => d.content)].join('\n\n---\n\n');
        item.tags    = [...new Set([...item.tags, ...dupes.flatMap(d => d.tags)])];
        item.updated = new Date().toISOString();
        dupes.forEach(d => used.add(d.id));
        merged += dupes.length;
      }
      used.add(item.id);
      result.push(item);
    }
    this.items = result;
    if (merged > 0) this.save();
    return merged;
  }

  // Prune: remove stale items (not accessed in 30 days, or content < 20 chars)
  prune(staleDays = 30): number {
    const cutoff = Date.now() - staleDays * 86400_000;
    const before = this.items.length;
    this.items = this.items.filter(i => {
      if (i.content.trim().length < 20) return false;
      const ts = i.lastAccessed ?? i.updated ?? i.created;
      return new Date(ts).getTime() > cutoff;
    });
    const removed = before - this.items.length;
    if (removed > 0) this.save();
    return removed;
  }

  // Ephemeral name+desc list for progressive disclosure (§3)
  listNames(): Array<{ id: string; title: string; summary: string }> {
    return this.items.map(i => ({
      id:      i.id,
      title:   i.title,
      summary: i.content.slice(0, 120).replace(/\n/g, ' ') + (i.content.length > 120 ? '…' : '')
    }));
  }

  formatContext(query: string): string {
    const results = this.search(query);
    if (!results.length) return '';
    // track access
    for (const r of results) {
      r.accessCount  = (r.accessCount ?? 0) + 1;
      r.lastAccessed = new Date().toISOString();
    }
    const parts = results.map(i =>
      `[Knowledge: ${i.title}]\n${i.content}`
    );
    return `<knowledge_base>\n${parts.join('\n\n')}\n</knowledge_base>`;
  }
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

function jaccardSim(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size && !sb.size) return 1;
  let inter = 0;
  sa.forEach(t => { if (sb.has(t)) inter++; });
  return inter / (sa.size + sb.size - inter);
}

function extractTags(text: string): string[] {
  return tokenize(text)
    .filter(t => t.length >= 4)
    .slice(0, 5);
}
