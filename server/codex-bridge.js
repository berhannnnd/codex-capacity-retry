import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSION_ROOT = path.join(CODEX_HOME, 'sessions');
const ARCHIVE_ROOT = path.join(CODEX_HOME, 'archived_sessions');

class AppServerClient {
  constructor() { this.pending = new Map(); this.nextId = 1; this.notifications = []; this.start(); }
  start() {
    this.proc = spawn(CODEX_BIN, ['app-server', '--listen', 'stdio://'], { env: process.env });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => { try { const msg = JSON.parse(line); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message || 'app-server error')) : p.resolve(msg.result); } else if (msg.method) this.notifications.push(msg); } catch {} });
    this.proc.stderr.on('data', (chunk) => process.stderr.write(`[codex] ${chunk}`));
    this.proc.on('exit', () => { for (const p of this.pending.values()) p.reject(new Error('app-server exited')); this.pending.clear(); });
    this.ready = this.call('initialize', { clientInfo: { name: 'capacity-retry-console', title: 'Capacity Retry Console', version: '0.2.0' } }).then(() => this.notify('initialized', {}));
  }
  notify(method, params) { this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  call(method, params) { const id = this.nextId++; this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  async request(method, params) { await this.ready; return this.call(method, params); }
}

const app = new AppServerClient();
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
const body = async (req) => { let data = ''; for await (const chunk of req) data += chunk; return data ? JSON.parse(data) : {}; };
const safeId = (id) => /^[a-zA-Z0-9_-]+$/.test(id) ? id : null;

async function listJsonlFiles(root) {
  const result = [];
  async function walk(dir) {
    let entries = []; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) { const p = path.join(dir, entry.name); if (entry.isDirectory()) await walk(p); else if (entry.name.endsWith('.jsonl')) result.push(p); }
  }
  await walk(root); return result;
}

const scanCache = new Map();
async function scanIncidents() {
  const files = [...await listJsonlFiles(SESSION_ROOT), ...await listJsonlFiles(ARCHIVE_ROOT)];
  const incidents = [];
  for (const file of files) {
    let s; try { s = await stat(file); } catch { continue; }
    const cached = scanCache.get(file); if (cached && cached.mtimeMs === s.mtimeMs) { incidents.push(...cached.items); continue; }
    let text; try { const full = await readFile(file, 'utf8'); text = full.slice(-512 * 1024); } catch { continue; }
    const items = []; let sessionId = path.basename(file).match(/-(01[a-z0-9-]{34})\.jsonl$/)?.[1] || path.basename(file);
    for (const line of text.split('\n')) {
      try {
        const row = JSON.parse(line); if (row.type === 'session_meta' && row.payload?.id) sessionId = row.payload.id;
        const p = row.payload; const error = p?.error || p?.codex_error_info;
        const message = typeof error === 'string' ? error : error?.message;
        if (row.type === 'event_msg' && (message?.toLowerCase().includes('capacity') || p?.codex_error_info === 'server_overloaded' || p?.type === 'task_complete' && p?.error)) {
          items.push({ threadId: sessionId, timestamp: row.timestamp, turnId: p?.turn_id || p?.turn_attribution?.turn_id || null, type: p?.codex_error_info || 'capacity_failure', message: message || 'task failed', path: file });
        }
      } catch {}
    }
    scanCache.set(file, { mtimeMs: s.mtimeMs, items }); incidents.push(...items);
  }
  return incidents.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

async function continueThread(threadId, model) {
  const params = { threadId, excludeTurns: true };
  const resumed = await app.request('thread/resume', params);
  const input = [{ type: 'text', text: 'Continue the unfinished work from the latest checkpoint. Do not repeat completed actions. First inspect the current state and report what you are resuming.' }];
  const turn = await app.request('turn/start', { threadId, input, ...(model ? { model } : {}) });
  return { resumed, turn };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' }); return res.end(); }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, adapter: 'codex-app-server', codexHome: CODEX_HOME });
    if (req.method === 'GET' && url.pathname === '/api/threads') return json(res, 200, await app.request('thread/list', { limit: Number(url.searchParams.get('limit') || 40), archived: false }));
    if (req.method === 'GET' && url.pathname === '/api/incidents') return json(res, 200, { data: await scanIncidents() });
    const match = url.pathname.match(/^\/api\/threads\/([^/]+)\/([^/]+)$/); const id = match && safeId(match[1]);
    if (id && req.method === 'GET' && match[2] === 'read') return json(res, 200, await app.request('thread/read', { threadId: id, includeTurns: false }));
    if (id && req.method === 'POST' && match[2] === 'continue') { const b = await body(req); return json(res, 200, await continueThread(id, b.model)); }
    if (id && req.method === 'POST' && match[2] === 'resume') return json(res, 200, await app.request('thread/resume', { threadId: id, excludeTurns: true }));
    if (req.method === 'GET' && url.pathname === '/api/models') return json(res, 200, await app.request('model/list', { limit: 100 }));
    return json(res, 404, { error: 'not_found' });
  } catch (error) { return json(res, 500, { error: error.message, code: error.code || 'bridge_error' }); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Capacity Retry bridge listening on http://127.0.0.1:${PORT}`));
