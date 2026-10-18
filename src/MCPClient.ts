import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';
import * as cp     from 'child_process';
import * as http   from 'http';
import * as https  from 'https';
import { provisionMcpServer } from './McpProvision';

interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

interface MCPServerConfig {
  command?:   string;          // stdio transport
  args?:      string[];
  env?:       Record<string, string>;
  serverUrl?: string;          // SSE transport (§25)
}

interface MCPTool {
  name:        string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id:      number;
  method:  string;
  params?: unknown;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id:      number;
  result?: unknown;
  error?:  { code: number; message: string };
}

export interface MCPToolDef {
  type: 'function';
  function: {
    name:        string;
    description: string;
    parameters:  Record<string, unknown>;
  };
  _mcpServer: string; // which server owns this tool
}

export class MCPServer {
  private proc?:         cp.ChildProcess;
  private pending =      new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private nextId  =      1;
  private buf     =      '';
  private stopped =      false;
  private reconnectCount = 0;
  private stderrTail = '';
  private readonly MAX_RECONNECTS = 5;
  onReconnect?: (name: string, attempt: number) => void;

  constructor(readonly name: string, private cfg: MCPServerConfig & { command: string }) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    this.proc = cp.spawn(this.cfg.command, this.cfg.args ?? [], {
      env:   { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // npx / npm are .cmd shims on Windows and cannot be spawned directly
      shell: process.platform === 'win32' && /^(npx|npm|pnpm|yarn|uvx)$/i.test(this.cfg.command)
    });
    // an undrained stderr pipe eventually blocks the server; keep the tail for error messages
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-1500); });

    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (chunk: string) => {
      this.buf += chunk;
      const lines = this.buf.split('\n');
      this.buf = lines.pop() ?? '';
      for (const ln of lines) {
        const t = ln.trim();
        if (!t) continue;
        try {
          const msg = JSON.parse(t) as JSONRPCResponse;
          const pend = this.pending.get(msg.id);
          if (pend) {
            this.pending.delete(msg.id);
            if (msg.error) pend.reject(new Error(msg.error.message));
            else pend.resolve(msg.result);
          }
        } catch { /* not JSON */ }
      }
    });

    this.proc.on('error', e => {
      console.error(`MCP server ${this.name} error:`, e);
      this.pending.forEach(p => p.reject(new Error(`MCP error: ${e.message}`)));
      this.pending.clear();
    });

    this.proc.on('exit', (code) => {
      this.pending.forEach(p => p.reject(new Error('MCP server exited')));
      this.pending.clear();
      // Auto-reconnect with exponential backoff
      if (!this.stopped && this.reconnectCount < this.MAX_RECONNECTS) {
        this.reconnectCount++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectCount - 1), 30000);
        this.onReconnect?.(this.name, this.reconnectCount);
        setTimeout(() => {
          if (!this.stopped) void this.reconnect();
        }, delay);
      }
    });

    // Initialize handshake
    await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities:    {},
      clientInfo:      { name: 'autopilot', version: '1.3.5' }
    }, 120_000);
    this.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); // a notification has no id
    this.reconnectCount = 0; // reset on successful connect
  }

  private async reconnect(): Promise<void> {
    try {
      await this.connect();
    } catch (e) {
      console.warn(`MCP ${this.name} reconnect failed (attempt ${this.reconnectCount}):`, e);
    }
  }

  async listTools(): Promise<MCPTool[]> {
    try {
      const result = await this.call('tools/list', {}, 60_000) as { tools?: MCPTool[] };
      return result?.tools ?? [];
    } catch { return []; }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.call('tools/call', { name, arguments: args }, 120_000) as {
      content?: Array<{ type: string; text?: string }>;
      isError?:  boolean;
    };
    const text = result?.content
      ?.filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('\n') ?? '';
    if (result?.isError) throw new Error(text);
    return text;
  }

  private call(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) { reject(new Error('MCP not running')); return; }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg: JSONRPCRequest = { jsonrpc: '2.0', id, method, params: params ?? undefined };
      this.proc.stdin!.write(JSON.stringify(msg) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout: ${method}${this.stderrTail ? ' — ' + this.stderrTail.trim().slice(-300) : ''}`));
        }
      }, timeoutMs);
    });
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
    this.proc = undefined;
  }
}

// ── SSE-based MCP server (§25 — HTTP SSE transport) ─────────────
class MCPSSEServer {
  private tools_: MCPTool[] = [];
  private stopped = false;
  private nextId  = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private eventEndpoint: string | null = null;

  constructor(readonly name: string, private readonly serverUrl: string) {}

  async start(): Promise<void> {
    // Discover tools via GET /tools or POST to JSON-RPC endpoint
    // SSE transport: server sends events, client POSTs requests
    await this.initialize();
    this.tools_ = await this.listTools();
  }

  private async initialize(): Promise<void> {
    // POST initialize request to serverUrl
    await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'autopilot', version: '1.3.5' } }
    });
    // Try to notify initialized (non-fatal)
    await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'notifications/initialized', params: null }).catch(() => {});
    // Detect event endpoint (some SSE servers use /events or /sse)
    this.eventEndpoint = this.serverUrl.endsWith('/') ? this.serverUrl + 'sse' : this.serverUrl + '/sse';
  }

  async listTools(): Promise<MCPTool[]> {
    try {
      const result = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list', params: {} }) as { result?: { tools?: MCPTool[] } };
      return result?.result?.tools ?? [];
    } catch { return []; }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.post({
      jsonrpc: '2.0', id: this.nextId++, method: 'tools/call',
      params: { name, arguments: args }
    }) as { result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean } };
    const content = result?.result?.content ?? [];
    const text    = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
    if (result?.result?.isError) throw new Error(text);
    return text;
  }

  private post(body: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const json    = JSON.stringify(body);
      const parsed  = new URL(this.serverUrl);
      const isHttps = parsed.protocol === 'https:';
      const lib     = isHttps ? https : http;
      const options = {
        hostname: parsed.hostname,
        port:     parsed.port || (isHttps ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json), 'Accept': 'application/json' },
        timeout:  12000
      };
      const req = lib.request(options, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('SSE MCP timeout')); });
      req.write(json);
      req.end();
    });
  }

  stop(): void { this.stopped = true; }

  getTools(): MCPTool[] { return this.tools_; }
}

export class MCPClient {
  private servers    = new Map<string, MCPServer>();
  private sseServers = new Map<string, MCPSSEServer>(); // SSE transport servers
  private tools:       MCPToolDef[] = [];

  async loadConfig(): Promise<void> {
    // Check workspace root AND global config (~/.gemini/config/mcp_config.json)
    const configPaths: string[] = [];
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) configPaths.push(path.join(root, 'mcp_config.json'));

    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
    if (home) {
      configPaths.push(path.join(home, '.gemini', 'config', 'mcp_config.json'));
    }

    for (const cfgPath of configPaths) {
      if (!fs.existsSync(cfgPath)) continue;
      let cfg: MCPConfig;
      try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as MCPConfig;
      } catch (e) {
        vscode.window.showWarningMessage(`RAG: Invalid mcp_config.json at ${cfgPath} — ${e}`);
        continue;
      }
      await this.loadServersFromConfig(cfg);
    }
  }

  private async loadServersFromConfig(cfg: MCPConfig): Promise<void> {
    for (const [name, serverCfg] of Object.entries(cfg.mcpServers ?? {})) {
      if (this.servers.has(name) || this.sseServers.has(name)) continue; // already loaded

      try {
        if (serverCfg.serverUrl) {
          // SSE transport (§25)
          const sseServer = new MCPSSEServer(name, serverCfg.serverUrl);
          await sseServer.start();
          this.sseServers.set(name, sseServer);
          const tools = sseServer.getTools();
          for (const t of tools) {
            this.tools.push({
              type: 'function',
              function: { name: `mcp__${name}__${t.name}`, description: `[MCP:${name}] ${t.description}`, parameters: t.inputSchema ?? { type: 'object', properties: {} } },
              _mcpServer: name
            });
          }
          vscode.window.showInformationMessage(`RAG: MCP SSE server "${name}" loaded with ${tools.length} tools`);
        } else if (serverCfg.command) {
          // stdio transport. `npx <package>` servers are downloaded on first use (and reuse an installed Chrome/Edge
          // instead of fetching Chromium); anything else is launched exactly as configured.
          let launch = { command: serverCfg.command, args: serverCfg.args ?? [], env: serverCfg.env ?? {} };
          try {
            launch = await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `RAG: MCP "${name}"` },
              p => provisionMcpServer(serverCfg.command!, serverCfg.args ?? [], serverCfg.env ?? {}, m => p.report({ message: m }))
            );
          } catch (e) {
            vscode.window.showWarningMessage(`RAG: could not prepare MCP "${name}" (${e instanceof Error ? e.message : e}); starting it as configured.`);
          }
          const server = new MCPServer(name, { ...serverCfg, ...launch } as MCPServerConfig & { command: string });
          server.onReconnect = (n, attempt) => {
            vscode.window.showWarningMessage(`RAG: MCP server "${n}" crashed — reconnecting (attempt ${attempt}/5)...`);
          };
          await server.start();
          const tools = await server.listTools();
          this.servers.set(name, server);
          for (const t of tools) {
            this.tools.push({
              type: 'function',
              function: { name: `mcp__${name}__${t.name}`, description: `[MCP:${name}] ${t.description}`, parameters: t.inputSchema ?? { type: 'object', properties: {} } },
              _mcpServer: name
            });
          }
          vscode.window.showInformationMessage(`RAG: MCP server "${name}" loaded with ${tools.length} tools`);
        }
      } catch (e) {
        vscode.window.showWarningMessage(`RAG: MCP server "${name}" failed to start — ${e}`);
      }
    }
  }

  getToolDefs(): MCPToolDef[] { return [...this.tools]; }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    // name format: mcp__serverName__toolName
    const match = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
    if (!match) throw new Error(`Invalid MCP tool name: ${name}`);
    const [, serverName, toolName] = match;

    const stdioServer = this.servers.get(serverName);
    if (stdioServer) return stdioServer.callTool(toolName, args);

    const sseServer = this.sseServers.get(serverName);
    if (sseServer) return sseServer.callTool(toolName, args);

    throw new Error(`MCP server not found: ${serverName}`);
  }

  isMCPTool(name: string): boolean { return name.startsWith('mcp__'); }

  dispose(): void {
    this.servers.forEach(s => s.stop());
    this.sseServers.forEach(s => s.stop());
  }
}
