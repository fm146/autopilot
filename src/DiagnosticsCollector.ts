import * as vscode from 'vscode';

export class DiagnosticsCollector {
  private disposable?: vscode.Disposable;
  private onChangeCallback?: () => void;

  start(onChange?: () => void): void {
    this.onChangeCallback = onChange;
    this.disposable = vscode.languages.onDidChangeDiagnostics(() => {
      onChange?.();
    });
  }

  dispose(): void { this.disposable?.dispose(); }

  // Returns formatted diagnostics for active file (errors + warnings)
  getActiveFileDiagnostics(maxItems = 20): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return '';

    const diags = vscode.languages.getDiagnostics(editor.document.uri)
      .filter(d => d.severity <= vscode.DiagnosticSeverity.Warning)
      .slice(0, maxItems);

    if (!diags.length) return '';

    const rel  = vscode.workspace.asRelativePath(editor.document.uri);
    const lines = diags.map(d => {
      const sev  = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARN';
      const loc  = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
      const src  = d.source ? `[${d.source}]` : '';
      return `  ${sev} ${loc} ${src} ${d.message}`;
    });

    return `<diagnostics file="${rel}">\n${lines.join('\n')}\n</diagnostics>`;
  }

  // Returns workspace-wide errors (errors only, top N files)
  getWorkspaceDiagnostics(maxFiles = 5): string {
    const all = vscode.languages.getDiagnostics();
    const errors = all
      .map(([uri, diags]) => ({
        uri,
        diags: diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error)
      }))
      .filter(x => x.diags.length)
      .slice(0, maxFiles);

    if (!errors.length) return '';

    const lines = errors.flatMap(({ uri, diags }) => {
      const rel = vscode.workspace.asRelativePath(uri);
      return diags.slice(0, 5).map(d => {
        const loc = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
        return `  ${rel}:${loc} ${d.message}`;
      });
    });

    return `<workspace_errors>\n${lines.join('\n')}\n</workspace_errors>`;
  }

  hasErrors(): boolean {
    const all = vscode.languages.getDiagnostics();
    return all.some(([, diags]) =>
      diags.some(d => d.severity === vscode.DiagnosticSeverity.Error)
    );
  }

  getErrorCount(): number {
    return vscode.languages.getDiagnostics()
      .flatMap(([, d]) => d)
      .filter(d => d.severity === vscode.DiagnosticSeverity.Error)
      .length;
  }
}
