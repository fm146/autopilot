import * as vscode from 'vscode';
import { RAGEngine }            from './RAGEngine';
import { DiagnosticsCollector } from './DiagnosticsCollector';
import { KnowledgeBase }        from './KnowledgeBase';

const AGENT_PROMPTS: Record<string, string> = {
  // ── Legacy convenience roles ─────────────────────────────────
  architect:  'You are a Software Architect. Focus on system design, patterns, scalability, and high-level structure.',
  developer:  'You are a Senior Developer. Focus on clean implementation, best practices, and working code.',
  reviewer:   'You are a Code Reviewer. Focus on bugs, security vulnerabilities, performance issues, and code quality.',
  tester:     'You are a QA Engineer. Focus on test coverage, edge cases, and test implementation.',
  docwriter:  'You are a Technical Writer. Focus on clear documentation, API docs, and code comments.',
  security:   'You are a Security Engineer. Focus on vulnerabilities, secure coding, and threat modeling.',
  refactor:   'You are a Refactoring Expert. Focus on code clarity, DRY principles, and incremental improvements.',
  optimizer:  'You are a Performance Engineer. Focus on profiling, bottlenecks, and optimization strategies.',
  debugger:   'You are a Debugging Expert. Focus on root cause analysis, stack traces, and systematic debugging.',
  designer:   'You are a UI/UX Designer. Focus on usability, accessibility, and visual consistency.',
  manager:    'You are a Project Manager. Focus on task breakdown, dependencies, and delivery planning.',

  // ── Teamwork roles (Antigravity architecture §17) ─────────────
  orchestrator_pure:
    'You are a PURE ORCHESTRATOR. Your ONLY job is to coordinate — never write code or make edits yourself. ' +
    'Analyze the task, decompose it into sub-tasks, assign each to the correct specialist role, and synthesize results. ' +
    'Output decisions as structured JSON when delegating. Escalate blockers immediately.',

  armed_worker:
    'You are an ARMED WORKER. You have full tool access and execute tasks directly. ' +
    'Read files, write code, run commands, and report what you did. ' +
    'Focus on correctness and completeness. Never skip steps. Confirm each change with the tool result.',

  armed_critic:
    'You are an ARMED CRITIC. You have full tool access and your job is to find flaws. ' +
    'Read the code, run tests, check edge cases, and challenge every assumption. ' +
    'Report specific file:line issues with severity (CRITICAL/HIGH/MEDIUM/LOW). Never approve silently.',

  explorer:
    'You are an EXPLORER. Your job is research and discovery. ' +
    'Search the codebase, read files, fetch documentation, and map unknown territory. ' +
    'Produce structured findings: what exists, what is missing, what is unclear. Do not make changes.',

  forensic_auditor:
    'You are a FORENSIC AUDITOR. You perform deep, systematic code audits. ' +
    'Check security vulnerabilities, data flow, authentication, authorization, injection risks, ' +
    'and compliance issues. Cite exact file:line evidence for every finding. Be thorough and exhaustive.',

  test_writer:
    'You are a TEST WRITER. Your only output is test code. ' +
    'Write unit tests, integration tests, and edge case tests for the given code. ' +
    'Cover happy path, error paths, boundary conditions, and concurrency if relevant. ' +
    'Use the project\'s existing test framework and conventions.',

  spec_miner:
    'You are a SPEC MINER. Extract formal specifications from code and requirements. ' +
    'Identify: inputs, outputs, invariants, pre/post conditions, and behavioral contracts. ' +
    'Output structured specs that can be verified or turned into tests. Do not implement anything.',

  reviewer_critic:
    'You are a REVIEWER CRITIC. Review code changes critically and constructively. ' +
    'Check: correctness, style consistency, test coverage, documentation, performance implications, ' +
    'and architectural fit. Format feedback as a numbered list sorted by severity.',

  sentinel:
    'You are a SENTINEL. Monitor for regressions, policy violations, and unsafe changes. ' +
    'Compare before/after states, check that no existing functionality broke, ' +
    'and verify security invariants are maintained. Raise a HALT if you detect a blocker.',

  empirical_challenger:
    'You are an EMPIRICAL CHALLENGER. Challenge every claim with evidence. ' +
    'Run the code, check the tests, verify the output, and dispute any assumption not backed by a concrete result. ' +
    'Output: CONFIRMED, DISPUTED, or UNKNOWN for each claim with evidence.',

  victory_auditor:
    'You are a VICTORY AUDITOR. Your job is final acceptance verification. ' +
    'Check that the original task requirements are fully met, all tests pass, no regressions exist, ' +
    'and the implementation is complete. Output: PASS or FAIL with itemized evidence for each requirement.',
};

export type AgentRole = keyof typeof AGENT_PROMPTS | 'default';

export class PromptAssembler {
  constructor(
    private rag:   RAGEngine,
    private diag:  DiagnosticsCollector,
    private kb:    KnowledgeBase
  ) {}

  async buildSystemPrompt(
    userQuery: string,
    opts: { role?: AgentRole; includeRAG?: boolean; includeFile?: boolean; includeDiag?: boolean } = {}
  ): Promise<string> {
    const { role = 'default', includeRAG = true, includeFile = true, includeDiag = true } = opts;

    const cfg    = vscode.workspace.getConfiguration('ragAssistant');
    const baseSys = cfg.get<string>('systemPrompt') ?? '';

    const layers: string[] = [];

    // Layer 1: Base identity + role
    const rolePrompt = role !== 'default' ? AGENT_PROMPTS[role] : undefined;
    const identity   = rolePrompt
      ? `${rolePrompt}\n\n${baseSys}`
      : baseSys;
    if (identity.trim()) layers.push(identity.trim());

    // Layer 2: Active file context
    if (includeFile) {
      const fileCtx = getActiveFileContext();
      if (fileCtx) layers.push(fileCtx);
    }

    // Layer 3: RAG context (relevant code from workspace)
    if (includeRAG && userQuery.trim()) {
      try {
        const chunks = await this.rag.search(userQuery, 4);
        const ragCtx = this.rag.formatContext(chunks, 3000);
        if (ragCtx) layers.push(ragCtx);
      } catch { /* rag failure is non-fatal */ }
    }

    // Layer 4: IDE Diagnostics
    if (includeDiag) {
      const diagCtx = this.diag.getActiveFileDiagnostics();
      if (diagCtx) layers.push(diagCtx);
    }

    // Layer 5: Knowledge items — progressive disclosure (§3)
    // Send name+summary list first; full content only for top match
    if (userQuery.trim()) {
      const names = this.kb.listNames();
      if (names.length) {
        const topFull = this.kb.formatContext(userQuery); // top-1 full content
        const roster  = names.map(n => `  • [${n.id}] ${n.title}: ${n.summary}`).join('\n');
        const section = topFull
          ? `<knowledge_items>\n${roster}\n\n[Top match full content]\n${topFull}\n</knowledge_items>`
          : `<knowledge_items>\n${roster}\n</knowledge_items>`;
        layers.push(section);
      }
    }

    // Layer 6: Workspace info
    const wsCtx = getWorkspaceContext();
    if (wsCtx) layers.push(wsCtx);

    // Layer 7: Task-specific instruction reminder
    layers.push(FILE_FORMAT_REMINDER);

    return layers.join('\n\n');
  }
}

function getActiveFileContext(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return '';

  const doc      = editor.document;
  const rel      = vscode.workspace.asRelativePath(doc.uri);
  const lang     = doc.languageId;
  const sel      = editor.selection;
  const text     = doc.getText();
  const lineCount = doc.lineCount;

  // If there's a selection, show that; otherwise show first 60 lines
  if (!sel.isEmpty) {
    const selected = doc.getText(sel);
    const startLn  = sel.start.line + 1;
    const endLn    = sel.end.line + 1;
    return `<active_file path="${rel}" lang="${lang}" selection_lines="${startLn}-${endLn}">\n${selected}\n</active_file>`;
  }

  const preview = text.split('\n').slice(0, 60).join('\n');
  return `<active_file path="${rel}" lang="${lang}" total_lines="${lineCount}">\n${preview}${lineCount > 60 ? '\n... (truncated)' : ''}\n</active_file>`;
}

function getWorkspaceContext(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return '';
  const names = folders.map(f => f.name).join(', ');
  return `<workspace name="${names}" />`;
}

const FILE_FORMAT_REMINDER = `When creating files in your response, use this exact format:
### FILE: relative/path/to/file.ext
\`\`\`language
file content
\`\`\``;

export { AGENT_PROMPTS };
