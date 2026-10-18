import * as http  from 'http';
import * as https from 'https';
import { ModelConfig } from './ModelRegistry';

export interface ChatMessage {
  role:    'system' | 'user' | 'assistant';
  content: string;
  images?: string[];  // base64-encoded images (for vision models)
  audio?:  Array<{ data: string; format: string }>;  // base64 voice messages (wav, mp3, ogg, flac, m4a…) for audio models
  id?:     string;    // stable id of a user message (links it to its restore point); never sent to the model
}

export interface StreamChunk {
  type:        'delta' | 'done' | 'error' | 'toolCall';
  content?:    string;
  error?:      string;
  toolName?:   string;
  toolArgs?:   Record<string, unknown>;
  tokenUsage?: { prompt: number; completion: number; total: number };
}

export interface GenOptions {
  maxTokens?:   number;
  temperature?:  number;
  tools?:        unknown[];
}

const AUDIO_MIME: Record<string, string> = {
  wav: 'audio/wav', mp3: 'audio/mp3', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', aiff: 'audio/aiff'
};

// Rough token estimator (4 chars ≈ 1 token)
export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((acc, m) => acc + m.content.length, 0) / 4);
}

// Truncate history to fit within token budget, keeping system prompt + last N turns
export function truncateHistory(
  messages: ChatMessage[],
  maxTokens = 6000
): ChatMessage[] {
  const system = messages.filter(m => m.role === 'system');
  const convo  = messages.filter(m => m.role !== 'system');

  let budget = maxTokens - estimateTokens(system);
  const kept: ChatMessage[] = [];

  // Walk from newest to oldest, keep while budget allows
  for (let i = convo.length - 1; i >= 0; i--) {
    const cost = Math.ceil(convo[i].content.length / 4) + 4;
    if (budget - cost < 0) break;
    budget -= cost;
    kept.unshift(convo[i]);
  }

  return [...system, ...kept];
}

// Some reasoning models (e.g. beam, gpt-oss) leak tool calls into plain text instead of
// tool_calls, e.g. `assistant to=view_file>[-] {"path":"a.js"} </rfl:parameter>`.
// Recover them so the agent loop keeps going. `knownTools` maps tool name -> parameter names;
// unknown tool names are ignored.
type LeakedCall = { name: string; args: Record<string, unknown> };

// Models often write invalid JSON here (unescaped quotes inside a string, missing closing `"}`).
// Split the region on the tool's known parameter names instead of relying on valid JSON.
function lenientArgs(region: string, props: string[]): Record<string, unknown> | null {
  const body = region.replace(/^\s*\{/, '');
  const keys: Array<{ prop: string; at: number; valueStart: number }> = [];
  for (const prop of props) {
    if (!/^\w+$/.test(prop)) continue;
    const re = new RegExp('(?:^|[,{\\s])("' + prop + '")\\s*:\\s*', 'g');
    let k: RegExpExecArray | null;
    while ((k = re.exec(body)) !== null) {
      keys.push({ prop, at: k.index + k[0].indexOf('"'), valueStart: k.index + k[0].length });
    }
  }
  if (!keys.length) return null;
  keys.sort((a, b) => a.at - b.at);

  const args: Record<string, unknown> = {};
  keys.forEach((key, i) => {
    const isLast = i === keys.length - 1;
    let raw = body.slice(key.valueStart, isLast ? body.length : keys[i + 1].at).trim();
    raw = raw.replace(/,$/, '').trim();
    if (isLast) raw = raw.replace(/\}$/, '').trim();
    if (raw.startsWith('"')) {
      let s = raw.slice(1);
      if (s.endsWith('"')) s = s.slice(0, -1);
      args[key.prop] = s.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_, e: string) =>
        e[0] === 'u' ? String.fromCharCode(parseInt(e.slice(1), 16)) :
        ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e);
    } else {
      try { args[key.prop] = JSON.parse(raw); } catch { args[key.prop] = raw; }
    }
  });
  return args;
}

/** Index of the bracket that closes the one at `start`, ignoring brackets inside JSON strings; -1 if unbalanced. */
function findClose(text: string, start: number, open: string, close: string): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

export function extractLeakedToolCalls(
  text: string,
  knownTools: Map<string, string[]>
): { calls: LeakedCall[]; text: string; unparsed: string[] } {
  const calls: LeakedCall[] = [];
  const unparsed: string[] = [];
  const marker = /(?:assistant\s*)?to=([A-Za-z_][\w.-]*)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;

  // Degenerate output drops underscores ("viewfile" for view_file), so match names loosely.
  const norm = (s: string) => s.toLowerCase().replace(/[_.-]/g, '');
  const byNorm = new Map<string, string>();
  for (const k of knownTools.keys()) byNorm.set(norm(k), k);

  while ((m = marker.exec(text)) !== null) {
    // Wrapped form: `to=viewfiletoolcalls=[{"function":{"name":"viewfile","arguments":"{...}"}}]`
    const wrapped = /^(.*?)tool_?calls$/i.exec(m[1]);
    if (wrapped && text[marker.lastIndex] === '=' && text[marker.lastIndex + 1] === '[') {
      const arrStart = marker.lastIndex + 1;
      const arrEnd = findClose(text, arrStart, '[', ']');
      let items: unknown = null;
      if (arrEnd >= 0) { try { items = JSON.parse(text.slice(arrStart, arrEnd + 1)); } catch { items = null; } }
      const parsed: LeakedCall[] = [];
      if (Array.isArray(items)) {
        for (const item of items as Array<{ function?: { name?: string; arguments?: unknown }; name?: string; arguments?: unknown }>) {
          const fn = item?.function ?? item;
          const real = byNorm.get(norm(String(fn?.name ?? '')));
          if (!real) continue;
          let args: unknown = fn.arguments;
          if (typeof args === 'string') {
            const s: string = args;
            try { args = JSON.parse(s); } catch { args = lenientArgs(s, knownTools.get(real) ?? []) ?? {}; }
          }
          parsed.push({ name: real, args: args && typeof args === 'object' ? args as Record<string, unknown> : {} });
        }
      }
      if (!parsed.length) { unparsed.push(wrapped[1] || m[1]); continue; }
      calls.push(...parsed);
      out += text.slice(last, m.index);
      last = arrEnd + 1;
      marker.lastIndex = last;
      continue;
    }

    const name = knownTools.has(m[1]) ? m[1] : byNorm.get(norm(m[1]));
    const props = name ? knownTools.get(name) : undefined;
    if (!name || !props) continue;
    const start = text.indexOf('{', marker.lastIndex);
    if (start < 0) continue;

    // 1) strict: balanced braces + valid JSON
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = i; break; }
    }

    let args: Record<string, unknown> | null = null;
    if (end >= 0) {
      const raw = text.slice(start, end + 1);
      try { args = JSON.parse(raw) as Record<string, unknown>; } catch {
        try {
          // raw newlines/tabs inside string values
          args = JSON.parse(raw.replace(/[\u0000-\u001f]/g, c =>
            c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '')) as Record<string, unknown>;
        } catch { args = null; }
      }
    }

    // 2) lenient: region runs to the closing tag / next leaked call / end of text
    if (!args) {
      const stop = /<\/[\w:.-]+>|assistant\s*to=[A-Za-z_]/.exec(text.slice(start + 1));
      const regionEnd = stop ? start + 1 + stop.index : text.length;
      args = lenientArgs(text.slice(start, regionEnd), props);
      if (args) end = regionEnd - 1;
    }

    if (!args) { unparsed.push(name); continue; }
    calls.push({ name, args });

    out += text.slice(last, m.index);
    const tail = /^\s*<\/[\w:.-]+>/.exec(text.slice(end + 1));
    last = end + 1 + (tail ? tail[0].length : 0);
    marker.lastIndex = last;
  }
  out += text.slice(last);
  return { calls, text: calls.length ? out.trim() : text, unparsed };
}

type OnChunk = (c: StreamChunk) => void;

export class LLMClient {
  private active  = new Set<http.ClientRequest>();
  private aborted = false;

  /** Cancel every in-flight request (Stop button). Cancelled streams resolve silently. */
  abortAll(): void {
    this.aborted = true;
    for (const r of this.active) r.destroy();
    this.active.clear();
  }
  resetAbort(): void { this.aborted = false; }

  /** URL that identifies this app to OpenRouter (setting ragAssistant.openRouterAppUrl). */
  openRouterReferer?: string;
  /** Up to 2 OpenRouter marketplace categories describing this app (setting ragAssistant.openRouterCategories). */
  openRouterCategories?: string;

  /** Called once per model request with the tokens used (reported by the provider, else estimated at ~4 chars/token). */
  onUsage?: (modelName: string, prompt: number, completion: number) => void;

  async streamChat(
    model:    ModelConfig,
    apiKey:   string,
    messages: ChatMessage[],
    opts:     GenOptions,
    onChunk:  OnChunk
  ): Promise<void> {
    let outChars = 0;
    let reported: { prompt: number; completion: number } | undefined;
    const wrapped: OnChunk = c => {
      if (c.type === 'delta' && c.content) outChars += c.content.length;
      else if (c.type === 'toolCall') outChars += JSON.stringify(c.toolArgs ?? {}).length + (c.toolName?.length ?? 0);
      else if (c.type === 'done' && c.tokenUsage) reported = c.tokenUsage;
      onChunk(c);
    };
    try {
      switch (model.provider) {
        case 'ollama':  return await this.ollama(model, apiKey, messages, opts, wrapped);
        case 'gemini':  return await this.gemini(model, apiKey, messages, opts, wrapped);
        default:        return await this.openai(model, apiKey, messages, opts, wrapped);
      }
    } finally {
      if (this.onUsage && (reported || outChars)) {
        this.onUsage(model.name || model.modelId,
          reported?.prompt ?? estimateTokens(messages),
          reported?.completion ?? Math.ceil(outChars / 4));
      }
    }
  }

  // ── Ollama — local or Ollama Cloud (NDJSON streaming) ────────
  // Ollama Cloud: baseUrl = https://ollama.com, apiKey = Bearer token
  private ollama(
    model: ModelConfig, apiKey: string, msgs: ChatMessage[], opts: GenOptions, on: OnChunk
  ): Promise<void> {
    const req: Record<string, unknown> = {
      model:    model.modelId,
      messages: msgs.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.images?.length) msg.images = m.images; // Ollama vision
        return msg;
      }),
      stream:   true,
      options: {
        num_predict:  opts.maxTokens  ?? 8192,
        temperature:  opts.temperature ?? 0.7
      }
    };
    if (opts.tools?.length) { req.tools = opts.tools; }

    // Ollama Cloud requires Bearer auth; local Ollama ignores the header if empty
    const headers: Record<string, string> = {};
    if (apiKey) { headers['Authorization'] = `Bearer ${apiKey}`; }

    return this.post(new URL('/api/chat', model.baseUrl), JSON.stringify(req), headers, line => {
      const d = JSON.parse(line);
      // skip thinking tokens (gpt-oss / beam reasoning models)
      if (d.message?.content) on({ type: 'delta', content: d.message.content });
      // tool calls (Ollama returns them complete, not streamed)
      if (d.message?.tool_calls) {
        for (const tc of d.message.tool_calls) {
          on({ type: 'toolCall', toolName: tc.function.name, toolArgs: tc.function.arguments ?? {} });
        }
      }
      if (d.done) {
        const p = Number(d.prompt_eval_count) || 0, c = Number(d.eval_count) || 0;
        on({ type: 'done', tokenUsage: p || c ? { prompt: p, completion: c, total: p + c } : undefined });
      }
    }, on);
  }

  // ── OpenAI-compatible SSE streaming ──────────────────────────
  private openai(
    model: ModelConfig, apiKey: string, msgs: ChatMessage[], opts: GenOptions, on: OnChunk
  ): Promise<void> {
    const req: Record<string, unknown> = {
      model:       model.modelId,
      messages:    msgs.map(m => {
        if (m.images?.length || m.audio?.length) {
          // OpenAI multimodal format: content array with text + image_url / input_audio parts
          return {
            role:    m.role,
            content: [
              { type: 'text', text: m.content },
              ...(m.images ?? []).map(img => ({
                type:      'image_url',
                image_url: { url: `data:image/jpeg;base64,${img}` }
              })),
              ...(m.audio ?? []).map(a => ({
                type:        'input_audio',
                input_audio: { data: a.data, format: a.format }
              }))
            ]
          };
        }
        return { role: m.role, content: m.content };
      }),
      stream:      true,
      max_tokens:  opts.maxTokens  ?? 8192,
      temperature: opts.temperature ?? 0.7
    };
    if (opts.tools?.length) { req.tools = opts.tools; req.tool_choice = 'auto'; }
    const body = JSON.stringify(req);
    const headers: Record<string, string> = {};
    if (apiKey) { headers['Authorization'] = `Bearer ${apiKey}`; }
    if (model.provider === 'openrouter') {
      // App attribution (openrouter.ai/docs/app-attribution): OpenRouter identifies an app by its URL.
      // Some free models are restricted to agentic apps, which it recognises from this identity.
      headers['HTTP-Referer']             = this.openRouterReferer || 'http://localhost';
      headers['X-OpenRouter-Title']       = 'Autopilot';
      headers['X-Title']                  = 'Autopilot';
      headers['X-OpenRouter-Categories']  = this.openRouterCategories || 'ide-extension,cli-agent';
    }
    // Keep the base path: OpenRouter is https://openrouter.ai/api, so the endpoint is /api/v1/chat/completions
    const base = new URL(model.baseUrl);
    const prefix = base.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    // Reasoning models may stream their thinking in a separate field and leave "content" empty.
    let sawContent = false, reasoning = '', failed = false;
    const fail = (e: unknown) => {
      const x = e as { message?: string; code?: number | string; metadata?: { raw?: unknown } };
      const raw = x?.metadata?.raw ? ` (${String(typeof x.metadata.raw === 'string' ? x.metadata.raw : JSON.stringify(x.metadata.raw)).slice(0, 200)})` : '';
      failed = true;
      on({ type: 'error', error: `${model.name}: ${x?.message ?? JSON.stringify(e).slice(0, 300)}${x?.code ? ` [${x.code}]` : ''}${raw}` });
    };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (!sawContent && !failed && reasoning.trim()) on({ type: 'delta', content: reasoning });
      on({ type: 'done' });
    };
    return this.post(new URL(prefix + '/v1/chat/completions', base), body, headers, line => {
      if (line === 'data: [DONE]') { finish(); return; }
      // Errors can arrive as a plain JSON body or inside the event stream, with HTTP 200: never swallow them
      const json = line.startsWith('data: ') ? line.slice(6) : line.startsWith('{') ? line : '';
      if (!json) return;                                    // ": OPENROUTER PROCESSING" keep-alive comments
      const d = JSON.parse(json);
      if (d.error) { fail(d.error); return; }
      const ch = d.choices?.[0];
      const delta = ch?.delta ?? ch?.message;
      const content = delta?.content;
      if (content) { sawContent = true; on({ type: 'delta', content }); }
      const think = delta?.reasoning ?? delta?.reasoning_content;
      if (typeof think === 'string') reasoning += think;
      if (ch?.error) { fail(ch.error); return; }
      const fin = ch?.finish_reason;
      if (fin === 'error') { fail({ message: 'the provider stopped with an error' }); return; }
      if (fin && fin !== 'null') finish();
    }, on);
  }

  // ── Google Gemini SSE streaming ───────────────────────────────
  private gemini(
    model: ModelConfig, apiKey: string, msgs: ChatMessage[], opts: GenOptions, on: OnChunk
  ): Promise<void> {
    const sys  = msgs.find(m => m.role === 'system');
    const chat = msgs.filter(m => m.role !== 'system');

    const reqBody: Record<string, unknown> = {
      contents: chat.map(m => ({
        role:  m.role === 'assistant' ? 'model' : 'user',
        parts: [
          { text: m.content },
          ...(m.images ?? []).map(img => ({ inlineData: { mimeType: 'image/jpeg', data: img } })),
          ...(m.audio ?? []).map(a => ({ inlineData: { mimeType: AUDIO_MIME[a.format] ?? 'audio/wav', data: a.data } }))
        ]
      })),
      generationConfig: {
        maxOutputTokens: opts.maxTokens  ?? 8192,
        temperature:     opts.temperature ?? 0.7
      }
    };
    if (sys) { reqBody.systemInstruction = { parts: [{ text: sys.content }] }; }

    const url = new URL(
      `/v1beta/models/${model.modelId}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
      model.baseUrl
    );

    return this.post(url, JSON.stringify(reqBody), {}, line => {
      if (!line.startsWith('data: ')) return;
      const d = JSON.parse(line.slice(6));
      const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) on({ type: 'delta', content: text });
      const fin = d.candidates?.[0]?.finishReason;
      if (fin === 'STOP' || d.usageMetadata) {
        const p = Number(d.usageMetadata?.promptTokenCount) || 0, c = Number(d.usageMetadata?.candidatesTokenCount) || 0;
        on({ type: 'done', tokenUsage: p || c ? { prompt: p, completion: c, total: p + c } : undefined });
      }
    }, on);
  }

  // ── Low-level streaming POST ──────────────────────────────────
  private post(
    url:      URL,
    body:     string,
    headers:  Record<string, string>,
    parseLine: (line: string) => void,
    onChunk:  OnChunk
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const isHttps = url.protocol === 'https:';
      const lib     = isHttps ? https : http;

      const reqOpts: http.RequestOptions = {
        hostname: url.hostname,
        port:     url.port ? +url.port : (isHttps ? 443 : 80),
        path:     url.pathname + url.search,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Accept':         'text/event-stream, application/x-ndjson, */*',
          ...headers
        }
      };

      const req = lib.request(reqOpts, res => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = '';
          res.on('data', (c: Buffer) => { errBody += c.toString(); });
          res.on('end', () => {
            const hint = /agentic harness/i.test(errBody)
              ? ' — OpenRouter only serves this free model to apps it recognises as agentic. ' +
                'Set ragAssistant.openRouterAppUrl to your own app URL, or pick another model.'
              : '';
            onChunk({ type: 'error', error: `HTTP ${res.statusCode}: ${errBody.slice(0, 300)}${hint}` });
            resolve();
          });
          return;
        }

        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const ln of lines) {
            const t = ln.trim();
            if (t) { try { parseLine(t); } catch { /* ignore */ } }
          }
        });
        res.on('end', () => {
          if (buf.trim()) { try { parseLine(buf.trim()); } catch {} }
          onChunk({ type: 'done' });
          resolve();
        });
        res.on('error', e => {
          if (this.aborted) { resolve(); return; }
          onChunk({ type: 'error', error: e.message }); reject(e);
        });
        res.on('close', () => resolve());
      });

      this.active.add(req);
      req.on('close', () => { this.active.delete(req); resolve(); });
      req.on('error', e => {
        if (this.aborted) { resolve(); return; }
        onChunk({ type: 'error', error: e.message }); reject(e);
      });
      req.write(body);
      req.end();
    });
  }
}
