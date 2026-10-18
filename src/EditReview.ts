import * as vscode from 'vscode';
import * as fs     from 'fs';

/** A changed block: lines [oldStart, oldEnd) of the baseline became lines [newStart, newEnd) of the file. */
export interface Hunk { oldStart: number; oldEnd: number; newStart: number; newEnd: number; }

/** Line diff: common prefix/suffix are trimmed, the middle is solved with an LCS table. */
export function diffLines(a: string[], b: string[]): Hunk[] {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - s, m = eb - s;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > 4_000_000) return [{ oldStart: s, oldEnd: ea, newStart: s, newEnd: eb }];

  const w = m + 1, t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[s + i] === b[s + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null, i = 0, j = 0;
  const open = (): Hunk => (cur ??= { oldStart: s + i, oldEnd: s + i, newStart: s + j, newEnd: s + j });
  while (i < n && j < m) {
    if (a[s + i] === b[s + j]) { if (cur) { hunks.push(cur); cur = null; } i++; j++; }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) { open().oldEnd = s + i + 1; i++; }
    else { open().newEnd = s + j + 1; j++; }
  }
  while (i < n) { open().oldEnd = s + i + 1; i++; }
  while (j < m) { open().newEnd = s + j + 1; j++; }
  if (cur) hunks.push(cur);
  return hunks;
}

interface Review { baseline: string[]; since: number; created: boolean; eol: string; }

/** Sent to the chat: what changed in a file and whether it is still waiting for the user's decision. */
export interface ReviewUpdate { fsPath: string; state: 'pending' | 'accepted' | 'reverted'; added: number; removed: number; hunks: number; created: boolean; }

const key = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
const split = (t: string): string[] => t.split(/\r?\n/);

/**
 * Spec §7 "Diff View — user review": what the agent changed in a file the user has open is marked in the editor
 * (green = new / changed lines, red = what was there before) and every hunk can be accepted or rejected.
 *   Alt+J / Alt+K  next / previous hunk      Alt+Enter  accept      Alt+Shift+Backspace  reject
 * The review state is only the file as it was before the agent touched it: the hunks are always diff(baseline, file),
 * so edits the user makes by hand keep the markers correct.
 */
export class EditReview implements vscode.CodeLensProvider, vscode.Disposable {
  private reviews = new Map<string, Review>();
  private timers  = new Map<string, NodeJS.Timeout>();
  private subs:   vscode.Disposable[] = [];
  private lensEvents = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEvents.event;
  private updates = new vscode.EventEmitter<ReviewUpdate>();
  readonly onDidUpdate = this.updates.event;

  private addedType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(46,160,67,0.18)', isWholeLine: true,
    overviewRulerColor: '#3fb950', overviewRulerLane: vscode.OverviewRulerLane.Left
  });
  private noteType = vscode.window.createTextEditorDecorationType({});
  private deletedType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(248,81,73,0.16)', isWholeLine: true,
    overviewRulerColor: '#f85149', overviewRulerLane: vscode.OverviewRulerLane.Left
  });

  constructor() {
    const reg = (id: string, fn: (...a: any[]) => unknown) => this.subs.push(vscode.commands.registerCommand(id, fn));
    this.subs.push(
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      vscode.workspace.onDidChangeTextDocument(e => { if (this.reviews.has(key(e.document.uri.fsPath))) this.refreshSoon(e.document.uri.fsPath); }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext())
    );
    reg('ragAssistant.review.accept',    (uri: vscode.Uri, i: number) => this.accept(uri, i));
    reg('ragAssistant.review.revert',    (uri: vscode.Uri, i: number) => this.revert(uri, i));
    reg('ragAssistant.review.acceptAll', (uri?: vscode.Uri) => this.acceptAll(uri ?? vscode.window.activeTextEditor?.document.uri));
    reg('ragAssistant.review.revertAll', (uri?: vscode.Uri) => this.revertAll(uri ?? vscode.window.activeTextEditor?.document.uri));
    reg('ragAssistant.review.nextHunk',  () => this.step(1));
    reg('ragAssistant.review.prevHunk',  () => this.step(-1));
    reg('ragAssistant.review.acceptHere', () => this.here(h => this.accept(vscode.window.activeTextEditor!.document.uri, h)));
    reg('ragAssistant.review.revertHere', () => this.here(h => this.revert(vscode.window.activeTextEditor!.document.uri, h)));
  }

  dispose(): void {
    this.subs.forEach(d => d.dispose());
    for (const t of this.timers.values()) clearTimeout(t);
    this.addedType.dispose(); this.noteType.dispose(); this.deletedType.dispose();
  }

  // ── Entry point: the agent just changed a file ───────────────────────────────
  /** `before` is the file's text before the edit, or undefined when the agent created it. Markers show when the file is open in an editor. */
  track(fsPath: string, before: string | undefined): void {
    const k = key(fsPath);
    if (!this.reviews.has(k)) {
      this.reviews.set(k, { baseline: split(before ?? ''), since: Date.now(), created: before === undefined, eol: (before ?? '').includes('\r\n') ? '\r\n' : '\n' });
    } else {
      this.reviews.get(k)!.since = Date.now();       // another edit to a file that is already under review
    }
    this.refreshSoon(fsPath);
    this.emit(fsPath, 'pending');
  }

  // ── What the chat shows ──────────────────────────────────────────────────────
  private textOf(fsPath: string): string {
    const doc = vscode.workspace.textDocuments.find(d => key(d.uri.fsPath) === key(fsPath));
    if (doc) return doc.getText();
    try { return fs.readFileSync(fsPath, 'utf8'); } catch { return ''; }
  }

  private statsOf(fsPath: string): { added: number; removed: number; hunks: number } {
    const r = this.reviews.get(key(fsPath));
    if (!r) return { added: 0, removed: 0, hunks: 0 };
    const hunks = diffLines(r.baseline, split(this.textOf(fsPath)));
    return { added: hunks.reduce((n, h) => n + h.newEnd - h.newStart, 0), removed: hunks.reduce((n, h) => n + h.oldEnd - h.oldStart, 0), hunks: hunks.length };
  }

  private emit(fsPath: string, state: ReviewUpdate['state'], last?: { added: number; removed: number; hunks: number }): void {
    const st = last ?? this.statsOf(fsPath);
    this.updates.fire({ fsPath, state, ...st, created: !!this.reviews.get(key(fsPath))?.created });
  }

  /** From the chat: the same actions as the buttons above the code. Work for files that are not open too. */
  acceptFile(fsPath: string): void { this.acceptAll(vscode.Uri.file(fsPath)); }
  async revertFile(fsPath: string): Promise<void> { await this.revertAll(vscode.Uri.file(fsPath)); }
  async openFile(fsPath: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    const hunks = this.hunksOf(doc);
    if (hunks.length) { const p = new vscode.Position(Math.min(hunks[0].newStart, doc.lineCount - 1), 0); ed.selection = new vscode.Selection(p, p); ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenter); }
    this.refreshAll();
  }

  // ── Hunks and decorations ────────────────────────────────────────────────────
  private current(doc: vscode.TextDocument): string[] { return split(doc.getText()); }

  private hunksOf(doc: vscode.TextDocument): Hunk[] {
    const r = this.reviews.get(key(doc.uri.fsPath));
    return r ? diffLines(r.baseline, this.current(doc)) : [];
  }

  private refreshSoon(fsPath: string): void {
    const k = key(fsPath);
    clearTimeout(this.timers.get(k));
    this.timers.set(k, setTimeout(() => {
      this.timers.delete(k);
      for (const ed of vscode.window.visibleTextEditors) if (key(ed.document.uri.fsPath) === k) this.render(ed);
      this.finishIfClean(k, fsPath);
      this.lensEvents.fire();
      this.updateContext();
    }, 150));
  }

  private refreshAll(): void {
    for (const ed of vscode.window.visibleTextEditors) if (this.reviews.has(key(ed.document.uri.fsPath))) this.render(ed);
    this.lensEvents.fire();
    this.updateContext();
  }

  /** A review with no differences left is over. (Right after an edit the editor may not have reloaded the file yet, so wait a little.) */
  private finishIfClean(k: string, fsPath: string): void {
    const r = this.reviews.get(k);
    if (!r || Date.now() - r.since < 6000) return;
    const doc = vscode.workspace.textDocuments.find(d => key(d.uri.fsPath) === k);
    if (doc && diffLines(r.baseline, this.current(doc)).length === 0) { this.emit(fsPath, 'accepted', { added: 0, removed: 0, hunks: 0 }); this.reviews.delete(k); this.clear(fsPath); }
  }

  private clear(fsPath: string): void {
    const k = key(fsPath);
    for (const ed of vscode.window.visibleTextEditors) {
      if (key(ed.document.uri.fsPath) !== k) continue;
      ed.setDecorations(this.addedType, []); ed.setDecorations(this.noteType, []); ed.setDecorations(this.deletedType, []);
    }
  }

  private render(ed: vscode.TextEditor): void {
    const r = this.reviews.get(key(ed.document.uri.fsPath));
    if (!r) return;
    const cur = this.current(ed.document);
    const hunks = diffLines(r.baseline, cur).slice(0, 300);
    const added: vscode.DecorationOptions[] = [], notes: vscode.DecorationOptions[] = [], deleted: vscode.DecorationOptions[] = [];
    const lastLine = Math.max(0, ed.document.lineCount - 1);

    hunks.forEach((h, idx) => {
      const oldLines = r.baseline.slice(h.oldStart, h.oldEnd), newLines = cur.slice(h.newStart, h.newEnd);
      const hover = new vscode.MarkdownString(undefined, true);
      hover.isTrusted = true;
      hover.appendMarkdown(`**Autopilot change ${idx + 1}/${hunks.length}**\n\n`);
      hover.appendCodeblock([...oldLines.slice(0, 40).map(l => '- ' + l), ...newLines.slice(0, 40).map(l => '+ ' + l)].join('\n') || '(empty)', 'diff');
      const uri = encodeURIComponent(JSON.stringify([ed.document.uri.toJSON(), idx]));
      hover.appendMarkdown(`[✓ Accept](command:ragAssistant.review.accept?${uri})  ·  [✕ Revert](command:ragAssistant.review.revert?${uri})`);

      if (newLines.length) {
        added.push({ range: new vscode.Range(h.newStart, 0, h.newEnd - 1, 0), hoverMessage: hover });
        if (oldLines.length) {
          const first = oldLines[0].trim().slice(0, 70);
          notes.push({
            range: new vscode.Range(h.newStart, 0, h.newStart, 0),
            renderOptions: { after: { contentText: `   − ${first}${oldLines.length > 1 ? `  (+${oldLines.length - 1} more removed)` : ''}`, color: '#f85149', fontStyle: 'italic' } }
          });
        }
      } else {
        const line = Math.min(h.newStart, lastLine);
        const first = oldLines[0]?.trim().slice(0, 70) ?? '';
        deleted.push({
          range: new vscode.Range(line, 0, line, 0), hoverMessage: hover,
          renderOptions: { after: { contentText: `   − ${oldLines.length} line${oldLines.length > 1 ? 's' : ''} removed here: ${first}`, color: '#f85149', fontStyle: 'italic' } }
        });
      }
    });
    ed.setDecorations(this.addedType, added);
    ed.setDecorations(this.noteType, notes);
    ed.setDecorations(this.deletedType, deleted);
  }

  private updateContext(): void {
    const doc = vscode.window.activeTextEditor?.document;
    void vscode.commands.executeCommand('setContext', 'ragAssistant.hasReview', !!doc && this.reviews.has(key(doc.uri.fsPath)) && this.hunksOf(doc).length > 0);
  }

  // ── CodeLens: Accept / Revert above every hunk ───────────────────────────────
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.reviews.has(key(doc.uri.fsPath))) return [];
    const r = this.reviews.get(key(doc.uri.fsPath))!;
    const cur = this.current(doc);
    const hunks = diffLines(r.baseline, cur);
    if (!hunks.length) return [];
    const lenses: vscode.CodeLens[] = [];
    const top = new vscode.Range(0, 0, 0, 0);
    const added = hunks.reduce((n, h) => n + (h.newEnd - h.newStart), 0), removed = hunks.reduce((n, h) => n + (h.oldEnd - h.oldStart), 0);
    lenses.push(
      new vscode.CodeLens(top, { title: `Autopilot: ${hunks.length} change${hunks.length > 1 ? 's' : ''}  +${added} −${removed}`, command: 'ragAssistant.review.nextHunk' }),
      new vscode.CodeLens(top, { title: '✓ Accept all', command: 'ragAssistant.review.acceptAll', arguments: [doc.uri] }),
      new vscode.CodeLens(top, { title: r.created ? '✕ Delete file' : '✕ Revert all', command: 'ragAssistant.review.revertAll', arguments: [doc.uri] })
    );
    hunks.slice(0, 300).forEach((h, i) => {
      const line = Math.min(h.newStart, Math.max(0, doc.lineCount - 1));
      const at = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(at, { title: `✓ Accept  +${h.newEnd - h.newStart} −${h.oldEnd - h.oldStart}`, command: 'ragAssistant.review.accept', arguments: [doc.uri, i] }),
        new vscode.CodeLens(at, { title: '✕ Revert', command: 'ragAssistant.review.revert', arguments: [doc.uri, i] })
      );
    });
    return lenses;
  }

  // ── Actions ──────────────────────────────────────────────────────────────────
  private docOf(uri: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(d => key(d.uri.fsPath) === key(uri.fsPath));
  }

  private accept(uri: vscode.Uri, i: number): void {
    const doc = this.docOf(vscode.Uri.from(uri)), r = doc && this.reviews.get(key(doc.uri.fsPath));
    if (!doc || !r) return;
    const cur = this.current(doc), h = diffLines(r.baseline, cur)[i];
    if (!h) return;
    const before = this.statsOf(doc.uri.fsPath);
    r.baseline.splice(h.oldStart, h.oldEnd - h.oldStart, ...cur.slice(h.newStart, h.newEnd));   // this hunk is now the baseline
    const done = diffLines(r.baseline, cur).length === 0;
    this.emit(doc.uri.fsPath, done ? 'accepted' : 'pending', done ? before : undefined);
    if (done) this.reviews.delete(key(doc.uri.fsPath));
    this.refreshSoon(doc.uri.fsPath);
    if (done) this.clear(doc.uri.fsPath);
  }

  private async revert(uri: vscode.Uri, i: number): Promise<void> {
    const doc = this.docOf(vscode.Uri.from(uri)), r = doc && this.reviews.get(key(doc.uri.fsPath));
    if (!doc || !r) return;
    const cur = this.current(doc), h = diffLines(r.baseline, cur)[i];
    if (!h) return;
    cur.splice(h.newStart, h.newEnd - h.newStart, ...r.baseline.slice(h.oldStart, h.oldEnd));
    const before = this.statsOf(doc.uri.fsPath);
    await this.writeDoc(doc, cur.join(doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'));
    const done = diffLines(r.baseline, cur).length === 0;
    this.emit(doc.uri.fsPath, done ? 'reverted' : 'pending', done ? before : undefined);
    if (done) { this.reviews.delete(key(doc.uri.fsPath)); this.clear(doc.uri.fsPath); }
    this.refreshSoon(doc.uri.fsPath);
  }

  private acceptAll(uri?: vscode.Uri): void {
    if (!uri) return;
    const u = vscode.Uri.from(uri);
    if (!this.reviews.has(key(u.fsPath))) return;
    this.emit(u.fsPath, 'accepted');
    this.reviews.delete(key(u.fsPath));
    this.clear(u.fsPath);
    this.lensEvents.fire();
    this.updateContext();
  }

  private async revertAll(uri?: vscode.Uri): Promise<void> {
    if (!uri) return;
    const u = vscode.Uri.from(uri), r = this.reviews.get(key(u.fsPath));
    if (!r) return;
    const doc = this.docOf(u);
    this.emit(u.fsPath, 'reverted');
    this.reviews.delete(key(u.fsPath));
    this.clear(u.fsPath);
    if (r.created) {                                  // the agent created this file: reverting means removing it
      if (doc) await vscode.window.showTextDocument(doc).then(() => vscode.commands.executeCommand('workbench.action.closeActiveEditor'));
      try { fs.unlinkSync(u.fsPath); } catch { /* already gone */ }
    } else if (doc) {
      await this.writeDoc(doc, r.baseline.join(doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'));
    } else {
      fs.writeFileSync(u.fsPath, r.baseline.join(r.eol), 'utf8');       // not open in an editor: restore it on disk
    }
    this.lensEvents.fire();
    this.updateContext();
  }

  private async writeDoc(doc: vscode.TextDocument, text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
    await vscode.workspace.applyEdit(edit);
    await doc.save();                                  // the agent's change was on disk, so the reverted state belongs on disk too
  }

  // ── Keyboard: Alt+J / Alt+K / Alt+Enter / Alt+Shift+Backspace ────────────────
  private step(dir: 1 | -1): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const hunks = this.hunksOf(ed.document);
    if (!hunks.length) return;
    const line = ed.selection.active.line;
    const starts = hunks.map(h => Math.min(h.newStart, ed.document.lineCount - 1));
    const target = dir === 1 ? (starts.find(s => s > line) ?? starts[0]) : ([...starts].reverse().find(s => s < line) ?? starts[starts.length - 1]);
    const p = new vscode.Position(target, 0);
    ed.selection = new vscode.Selection(p, p);
    ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** The hunk under the cursor, otherwise the next one below it. */
  private here(act: (hunk: number) => unknown): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const hunks = this.hunksOf(ed.document);
    if (!hunks.length) return;
    const line = ed.selection.active.line;
    let i = hunks.findIndex(h => line >= h.newStart && line < Math.max(h.newEnd, h.newStart + 1));
    if (i < 0) i = hunks.findIndex(h => h.newStart > line);
    if (i < 0) i = hunks.length - 1;
    act(i);
  }
}
