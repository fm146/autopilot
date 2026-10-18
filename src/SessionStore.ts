import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';
import { ChatMessage } from './LLMClient';

export interface Session {
  id:         string;
  title:      string;
  created:    string;
  updated:    string;
  bookmarked: boolean;
  messages:   ChatMessage[];
  snaps?:     Record<string, string>;   // user message id -> shadow-git restore point taken before it
}

export interface SessionMeta {
  id:         string;
  title:      string;
  updated:    string;
  bookmarked: boolean;
  count:      number;
}

interface Data { currentId: string; sessions: Record<string, Session>; }

const MAX_SESSIONS = 100;

export class SessionStore {
  private file: string;
  private data: Data;

  constructor(ctx: vscode.ExtensionContext, initialMessages: ChatMessage[]) {
    const ws  = (vscode.workspace.workspaceFolders?.[0]?.name ?? 'default').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
    this.file = path.join(ctx.globalStorageUri.fsPath, `sessions_${ws}.json`);
    this.data = this.load(initialMessages);
  }

  private load(initial: ChatMessage[]): Data {
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Data;
        if (d.sessions && d.sessions[d.currentId]) return d;
      }
    } catch { /* corrupted: start fresh */ }
    const s = this.blank();
    s.messages = [...initial];
    s.title    = deriveTitle(s.messages);
    return { currentId: s.id, sessions: { [s.id]: s } };
  }

  private blank(): Session {
    const now = new Date().toISOString();
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      title: '', created: now, updated: now, bookmarked: false, messages: []
    };
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8');
    } catch (e) { console.error('SessionStore persist error:', e); }
  }

  current(): Session { return this.data.sessions[this.data.currentId]; }

  /** Sync the live chat into the current session. */
  saveCurrent(messages: ChatMessage[]): void {
    const s = this.current();
    s.messages = messages.map(m => ({ ...m, images: undefined })); // base64 images would bloat the store
    s.updated  = new Date().toISOString();
    if (!s.title) s.title = deriveTitle(messages);
    this.persist();
  }

  addSnap(messageId: string, sha: string): void {
    const s = this.current();
    (s.snaps ??= {})[messageId] = sha;
    this.persist();
  }

  snapFor(messageId: string): string | undefined { return this.current().snaps?.[messageId]; }

  /** Start a fresh session. An empty current session is reused instead of piling up blanks. */
  newSession(): Session {
    const cur = this.current();
    if (!cur.messages.length) return cur;
    const s = this.blank();
    this.data.sessions[s.id] = s;
    this.data.currentId = s.id;
    this.prune();
    this.persist();
    return s;
  }

  switchTo(id: string): Session | undefined {
    const s = this.data.sessions[id];
    if (!s) return undefined;
    this.data.currentId = id;
    this.persist();
    return s;
  }

  toggleBookmark(id: string = this.data.currentId): boolean {
    const s = this.data.sessions[id];
    if (!s) return false;
    s.bookmarked = !s.bookmarked;
    this.persist();
    return s.bookmarked;
  }

  remove(id: string): boolean {
    if (!this.data.sessions[id] || id === this.data.currentId) return false;
    delete this.data.sessions[id];
    this.persist();
    return true;
  }

  list(): SessionMeta[] {
    return Object.values(this.data.sessions)
      .filter(s => s.messages.length || s.id === this.data.currentId)
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .map(s => ({
        id: s.id, title: s.title || 'New chat', updated: s.updated,
        bookmarked: s.bookmarked, count: s.messages.length
      }));
  }

  private prune(): void {
    const all = Object.values(this.data.sessions)
      .filter(s => !s.bookmarked && s.id !== this.data.currentId)
      .sort((a, b) => b.updated.localeCompare(a.updated));
    for (const s of all.slice(MAX_SESSIONS)) delete this.data.sessions[s.id];
  }
}

function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find(m => m.role === 'user');
  if (!first) return '';
  const line = first.content.split('\n[Attached image analysis')[0].replace(/\s+/g, ' ').trim();
  return line.length > 60 ? line.slice(0, 57) + '…' : line;
}
