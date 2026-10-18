import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';
import * as https  from 'https';
import * as http   from 'http';

interface Chunk {
  file:    string; // relative path
  start:   number;
  end:     number;
  text:    string;
  tokens:  number;
}

interface ScoredChunk extends Chunk { score: number; }

const CHUNK_SIZE    = 480; // chars
const CHUNK_OVERLAP = 80;
const K1 = 1.5;
const B  = 0.75;
const RRF_K = 60; // RRF constant

export class RAGEngine {
  private index  = new Map<string, Map<string, number[]>>(); // term → fileKey → positions
  private chunks: Chunk[]          = [];
  private chunkMap = new Map<string, number[]>(); // fileKey → chunk indices
  private avgDocLen = 0;
  private indexed  = false;
  private indexing = false;
  // Vector search state
  private embeddings: Float32Array[] = []; // parallel to this.chunks
  private embeddingDim = 0;

  async ensureIndexed(): Promise<void> {
    if (this.indexed || this.indexing) return;
    this.indexing = true;
    try { await this.buildIndex(); } finally { this.indexing = false; this.indexed = true; }
  }

  invalidate(): void { this.indexed = false; this.index.clear(); this.chunks = []; this.chunkMap.clear(); }

  async search(query: string, topK = 5): Promise<ScoredChunk[]> {
    await this.ensureIndexed();
    if (!this.chunks.length) return [];

    const bm25Results = this.bm25Search(query, topK * 3);

    // Try hybrid search if embedding model is configured
    const cfg = vscode.workspace.getConfiguration('ragAssistant');
    const embeddingEndpoint = cfg.get<string>('embeddingEndpoint') ?? '';
    let candidates: ScoredChunk[];
    if (embeddingEndpoint) {
      try {
        const vecResults = await this.vectorSearch(query, embeddingEndpoint, topK * 3);
        if (vecResults.length) {
          candidates = this.rrfFusion(bm25Results, vecResults, topK * 2);
        } else {
          candidates = bm25Results;
        }
      } catch { candidates = bm25Results; }
    } else {
      candidates = bm25Results;
    }

    // MQuery Reranker (§1) — cross-encoder scoring via LLM
    const rerankerEndpoint = cfg.get<string>('rerankerEndpoint') ?? '';
    if (rerankerEndpoint && candidates.length > topK) {
      try {
        return await this.mqueueRerank(query, candidates, topK, rerankerEndpoint);
      } catch { /* fall back to RRF/BM25 order */ }
    }

    return candidates.slice(0, topK);
  }

  // BM25 search (§1) — inverted index with TF-IDF weighting
  private bm25Search(query: string, topK: number): ScoredChunk[] {
    const terms = tokenize(query);
    if (!terms.length) return [];

    const scores = new Float64Array(this.chunks.length);
    const N      = this.chunks.length;

    for (const term of terms) {
      const postings = this.index.get(term);
      if (!postings) continue;
      const df  = postings.size;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      postings.forEach((_, fileKey) => {
        const indices = this.chunkMap.get(fileKey) ?? [];
        for (const ci of indices) {
          const chunk  = this.chunks[ci];
          const tf     = countTermInChunk(term, chunk.text);
          const docLen = chunk.tokens;
          const norm   = 1 - B + B * docLen / this.avgDocLen;
          scores[ci] += idf * (tf * (K1 + 1)) / (tf + K1 * norm);
        }
      });
    }

    const entries: [number, number][] = [];
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] > 0) entries.push([i, scores[i]]);
    }
    entries.sort((a, b) => b[1] - a[1]);
    return entries.slice(0, topK).map(([i, score]) => ({ ...this.chunks[i], score }));
  }

  // Vector search via external embedding API (§1 HybridSearch)
  private async vectorSearch(query: string, endpoint: string, topK: number): Promise<ScoredChunk[]> {
    if (!this.embeddings.length || this.embeddingDim === 0) return [];

    const queryVec = await this.getEmbedding(query, endpoint);
    if (!queryVec) return [];

    // Cosine similarity against all chunk embeddings
    const scored: [number, number][] = [];
    for (let i = 0; i < this.embeddings.length; i++) {
      const emb = this.embeddings[i];
      if (!emb || emb.length !== queryVec.length) continue;
      const sim = cosineSimilarity(queryVec, emb);
      if (sim > 0) scored.push([i, sim]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, topK).map(([i, score]) => ({ ...this.chunks[i], score }));
  }

  // RRF (Reciprocal Rank Fusion) — fuse BM25 + vector rankings (§1)
  private rrfFusion(bm25: ScoredChunk[], vector: ScoredChunk[], topK: number): ScoredChunk[] {
    const rrfScores = new Map<string, number>();

    const rank = (results: ScoredChunk[]) => {
      results.forEach((chunk, rank) => {
        const key = `${chunk.file}:${chunk.start}`;
        rrfScores.set(key, (rrfScores.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
      });
    };
    rank(bm25);
    rank(vector);

    // Build unified result set from both lists
    const seen = new Map<string, ScoredChunk>();
    for (const chunk of [...bm25, ...vector]) {
      const key = `${chunk.file}:${chunk.start}`;
      if (!seen.has(key)) seen.set(key, chunk);
    }

    return [...seen.entries()]
      .map(([key, chunk]) => ({ ...chunk, score: rrfScores.get(key) ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // MQuery Reranker (§1) — cross-encoder that scores query↔chunk relevance
  // Uses an external cross-encoder endpoint (e.g. Cohere rerank, or local model)
  // Endpoint expects POST { query, documents: string[] } → { results: [{index, relevance_score}] }
  private async mqueueRerank(
    query: string,
    candidates: ScoredChunk[],
    topK: number,
    endpoint: string
  ): Promise<ScoredChunk[]> {
    const documents = candidates.map(c => c.text.slice(0, 512));
    const body = JSON.stringify({ query, documents, top_n: topK, model: 'rerank-english-v3.0' });
    const isHttps = endpoint.startsWith('https');
    const lib = isHttps ? https : http;
    const parsed = new URL(endpoint);

    return new Promise((resolve) => {
      const req = lib.request({
        hostname: parsed.hostname,
        port:     parsed.port || (isHttps ? 443 : 80),
        path:     parsed.pathname,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout:  8000
      }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => data += c);
        res.on('end', () => {
          try {
            const resp = JSON.parse(data) as { results?: Array<{ index: number; relevance_score: number }> };
            const results = resp.results ?? [];
            if (!results.length) { resolve(candidates.slice(0, topK)); return; }
            const reranked = results
              .sort((a, b) => b.relevance_score - a.relevance_score)
              .slice(0, topK)
              .map(r => ({ ...candidates[r.index], score: r.relevance_score }));
            resolve(reranked);
          } catch { resolve(candidates.slice(0, topK)); }
        });
        res.on('error', () => resolve(candidates.slice(0, topK)));
      });
      req.on('error', () => resolve(candidates.slice(0, topK)));
      req.on('timeout', () => { req.destroy(); resolve(candidates.slice(0, topK)); });
      req.write(body);
      req.end();
    });
  }

  // Get embedding vector from external API
  private async getEmbedding(text: string, endpoint: string): Promise<Float32Array | null> {
    return new Promise((resolve) => {
      const body = JSON.stringify({ input: text.slice(0, 2000), model: 'text-embedding-3-small' });
      const isHttps = endpoint.startsWith('https');
      const lib     = isHttps ? https : http;
      try {
        const parsed = new URL(endpoint);
        const options = {
          hostname: parsed.hostname,
          port:     parsed.port || (isHttps ? 443 : 80),
          path:     parsed.pathname + parsed.search,
          method:   'POST',
          headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout:  5000
        };
        const req = lib.request(options, res => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => { data += c; });
          res.on('end', () => {
            try {
              const json = JSON.parse(data) as { data?: Array<{ embedding: number[] }> };
              const vec  = json.data?.[0]?.embedding;
              if (vec?.length) resolve(new Float32Array(vec));
              else resolve(null);
            } catch { resolve(null); }
          });
          res.on('error', () => resolve(null));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
      } catch { resolve(null); }
    });
  }

  // Index embeddings for all chunks (called after BM25 index build if endpoint configured)
  async buildEmbeddingIndex(endpoint: string): Promise<void> {
    if (!this.chunks.length) return;
    this.embeddings = new Array(this.chunks.length).fill(null);
    const batchSize = 20;
    for (let i = 0; i < this.chunks.length; i += batchSize) {
      const batch = this.chunks.slice(i, i + batchSize);
      const vecs  = await Promise.all(batch.map(c => this.getEmbedding(c.text, endpoint)));
      vecs.forEach((v, j) => {
        if (v) {
          this.embeddings[i + j] = v;
          if (!this.embeddingDim) this.embeddingDim = v.length;
        }
      });
    }
  }

  formatContext(chunks: ScoredChunk[], maxChars = 4000): string {
    if (!chunks.length) return '';
    const parts: string[] = ['<rag_context>'];
    let total = 0;
    for (const c of chunks) {
      const snippet = `\n[File: ${c.file} lines ${c.start}-${c.end}]\n${c.text}\n`;
      if (total + snippet.length > maxChars) break;
      parts.push(snippet);
      total += snippet.length;
    }
    parts.push('</rag_context>');
    return parts.join('');
  }

  private async buildIndex(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;

    const exts = [
      '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
      '**/*.py', '**/*.go', '**/*.rs', '**/*.java',
      '**/*.c', '**/*.cpp', '**/*.h',
      '**/*.md', '**/*.json', '**/*.yaml', '**/*.yml'
    ];

    const uris = await vscode.workspace.findFiles(
      `{${exts.join(',')}}`,
      '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.venv/**,**/.rag/**}',   // .rag holds downloaded reference repos
      2000
    );

    let totalLen = 0;
    for (const uri of uris) {
      try {
        const rel  = vscode.workspace.asRelativePath(uri);
        const text = fs.readFileSync(uri.fsPath, 'utf8');
        const fileChunks = chunkText(text, rel);
        const startIdx   = this.chunks.length;
        this.chunks.push(...fileChunks);
        this.chunkMap.set(rel, fileChunks.map((_, i) => startIdx + i));
        for (let ci = startIdx; ci < this.chunks.length; ci++) {
          const chunk = this.chunks[ci];
          totalLen   += chunk.tokens;
          for (const term of tokenize(chunk.text)) {
            if (!this.index.has(term)) this.index.set(term, new Map());
            const postings = this.index.get(term)!;
            if (!postings.has(rel)) postings.set(rel, []);
            postings.get(rel)!.push(ci);
          }
        }
      } catch { /* skip binary or unreadable */ }
    }

    this.avgDocLen = this.chunks.length ? totalLen / this.chunks.length : 1;
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9_$]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && t.length <= 40);
}

function countTermInChunk(term: string, text: string): number {
  const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  return (text.match(re) ?? []).length || 1;
}

function chunkText(text: string, file: string): Chunk[] {
  const lines  = text.split('\n');
  const chunks: Chunk[] = [];
  let pos = 0;
  let lineNum = 1;

  while (pos < text.length) {
    const end    = Math.min(pos + CHUNK_SIZE, text.length);
    const chunk  = text.slice(pos, end);
    const startLine = lineNum;
    const endLine   = startLine + (chunk.match(/\n/g) ?? []).length;
    chunks.push({ file, start: startLine, end: endLine, text: chunk, tokens: Math.ceil(chunk.length / 4) });
    lineNum = endLine;
    pos    += CHUNK_SIZE - CHUNK_OVERLAP;
    if (pos >= text.length) break;
  }
  return chunks;
}

// Singleton
let _instance: RAGEngine | undefined;
export function getRAGEngine(): RAGEngine {
  if (!_instance) _instance = new RAGEngine();
  return _instance;
}
