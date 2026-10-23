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
const audit = [];
const activeActions = new Set();
const acknowledgedAlerts = new Set();

class AppServerClient {
  constructor() { this.pending = new Map(); this.nextId = 1; this.connected = false; this.start(); }
  start() {
    try { this.proc = spawn(CODEX_BIN, ['app-server', '--listen', 'stdio://'], { env: process.env }); } catch { return; }
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => { try { const msg = JSON.parse(line); if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(Object.assign(new Error(msg.error.message || 'app-server error'), { code: msg.error.code })) : p.resolve(msg.result); } } catch {} });
    this.proc.stderr?.on('data', (chunk) => process.stderr.write(`[codex] ${chunk}`));
    this.proc.on('exit', () => { this.connected = false; for (const p of this.pending.values()) p.reject(new Error('app-server exited')); this.pending.clear(); });
    this.ready = this.call('initialize', { clientInfo: { name: 'codex-manager', title: 'Codex 任务管家', version: '0.3.0' } }).then(() => { this.connected = true; this.notify('initialized', {}); }).catch(() => { this.connected = false; });
  }
  notify(method, params) { if (this.proc?.stdin?.writable) this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  call(method, params) { if (!this.proc?.stdin?.writable) return Promise.reject(new Error('app-server unavailable')); const id = this.nextId++; this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  async request(method, params) { await this.ready; return this.call(method, params); }
}
const app = new AppServerClient();
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' }); res.end(JSON.stringify(body)); };
const body = async (req) => { let data = ''; for await (const chunk of req) data += chunk; return data ? JSON.parse(data) : {}; };
const safeId = (id) => /^[a-zA-Z0-9_-]+$/.test(id) ? id : null;
const now = () => new Date().toISOString();
const auditAction = (action, fields = {}) => { const record = { id: crypto.randomUUID(), action, requestedAt: now(), result: 'accepted', errorCode: null, ...fields }; audit.unshift(record); audit.splice(100); return record; };

async function listJsonlFiles(root) { const result = []; async function walk(dir) { let entries = []; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; } for (const entry of entries) { const p = path.join(dir, entry.name); if (entry.isDirectory()) await walk(p); else if (entry.name.endsWith('.jsonl')) result.push(p); } } await walk(root); return result; }
const scanCache = new Map();
function classify(message, code) { const text = `${code || ''} ${message || ''}`.toLowerCase(); if (text.includes('auth') || text.includes('login') || text.includes('unauthorized')) return { code: code || 'authentication_required', severity: 'critical' }; if (text.includes('server_overloaded') || text.includes('capacity') || text.includes('at capacity')) return { code: code || 'server_overloaded', severity: 'error' }; if (text.includes('disconnect') || text.includes('timeout') || text.includes('unavailable')) return { code: code || 'connection_unstable', severity: 'warning' }; return { code: code || 'turn_failed', severity: 'error' }; }
async function scanIncidents() {
  const files = [...await listJsonlFiles(SESSION_ROOT), ...await listJsonlFiles(ARCHIVE_ROOT)]; const incidents = [];
  for (const file of files) { let s; try { s = await stat(file); } catch { continue; } const cached = scanCache.get(file); if (cached && cached.mtimeMs === s.mtimeMs) { incidents.push(...cached.items); continue; } let text; try { text = (await readFile(file, 'utf8')).slice(-1024 * 1024); } catch { continue; } const items = []; let sessionId = path.basename(file).match(/-(01[a-z0-9-]{34})\.jsonl$/)?.[1] || path.basename(file); let ordinal = 0; for (const line of text.split('\n')) { ordinal += 1; try { const row = JSON.parse(line); if (row.type === 'session_meta' && row.payload?.id) sessionId = row.payload.id; const p = row.payload || {}; const error = p.error || p.codex_error_info; const message = typeof error === 'string' ? error : error?.message || p.message; const isFailure = row.type === 'event_msg' && (message || p.type === 'task_complete' && p.error); if (!isFailure) continue; const c = classify(message, typeof error === 'string' ? error : error?.code); const key = `${file}:${ordinal}:${c.code}`; items.push({ id: crypto.createHash('sha1').update(key).digest('hex').slice(0, 16), key, threadId: sessionId, turnId: p.turn_id || p.turn_attribution?.turn_id || null, timestamp: row.timestamp || now(), code: c.code, severity: c.severity, message: message || 'task failed', path: file, source: 'rollout' }); } catch {} } scanCache.set(file, { mtimeMs: s.mtimeMs, items }); incidents.push(...items); }
  return incidents.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}
async function accountInfo() { try { const raw = JSON.parse(await readFile(path.join(CODEX_HOME, 'auth.json'), 'utf8')); const accountId = raw.tokens?.account_id || null; return { id: 'local', maskedAccountId: accountId ? `${accountId.slice(0, 8)}…${accountId.slice(-4)}` : '未读取', authMode: raw.auth_mode || 'unknown', lastRefreshAt: raw.last_refresh || null, active: true, usageStatus: 'unavailable', usage: { status: 'unavailable', reason: '当前接口未提供剩余用量字段', source: 'Codex app-server', collectedAt: now() } }; } catch { return { id: 'local', maskedAccountId: '未登录', authMode: 'unknown', lastRefreshAt: null, active: false, usageStatus: 'unavailable', usage: { status: 'unavailable', reason: '未找到本机认证信息', source: '本地认证文件', collectedAt: now() } }; } }
function normalizeThread(t) { const status = typeof t.status === 'string' ? t.status : (t.status?.type === 'active' || t.status?.type === 'running' ? 'running' : t.status?.type === 'completed' ? 'completed' : 'idle'); return { id: t.id || t.threadId, title: t.name || t.title || t.preview || '未命名线程', cwd: t.cwd || t.path || null, model: t.model || t.modelSlug || null, provider: t.modelProvider || t.provider || null, status, latestTurnId: t.latestTurnId || null, updatedAt: t.updatedAt ? (typeof t.updatedAt === 'number' ? new Date(t.updatedAt * 1000).toISOString() : t.updatedAt) : now(), source: 'app-server' }; }
async function getThreads() { const raw = await app.request('thread/list', { limit: 100, archived: false }); const list = raw?.data || raw?.threads || raw || []; return Array.isArray(list) ? list.map(normalizeThread).filter((t) => t.id) : []; }
async function continueThread(threadId, model, actionId) { if (actionId && activeActions.has(actionId)) return { duplicate: true, actionId }; if (actionId) activeActions.add(actionId); const threads = await getThreads(); const thread = threads.find((t) => t.id === threadId); if (!thread) throw Object.assign(new Error('线程不存在或已归档'), { code: 'thread_not_found' }); if (thread.status === 'running') throw Object.assign(new Error('线程仍在运行，已阻止重复 writer'), { code: 'writer_conflict' }); const record = auditAction(model ? 'switch-model' : 'continue', { threadId, model: model || thread.model, actionId: actionId || crypto.randomUUID() }); try { const resumed = await app.request('thread/resume', { threadId, excludeTurns: true }); const turn = await app.request('turn/start', { threadId, input: [{ type: 'text', text: 'Continue the unfinished work from the latest checkpoint. Do not repeat completed actions. First inspect the current state and report what you are resuming.' }], ...(model ? { model } : {}) }); record.result = 'completed'; return { resumed, turn, actionId: record.actionId, auditId: record.id }; } catch (error) { record.result = 'failed'; record.errorCode = error.code || 'resume_failed'; throw error; } finally { if (actionId) activeActions.delete(actionId); } }

const server = http.createServer(async (req, res) => { try { if (req.method === 'OPTIONS') return json(res, 204, {}); const url = new URL(req.url, `http://${req.headers.host}`); const pathMatch = url.pathname.match(/^\/api\/threads\/([^/]+)(?:\/([^/]+))?$/); const id = pathMatch && safeId(pathMatch[1]);
  if (req.method === 'GET' && url.pathname === '/') return json(res, 200, { name: 'Codex 任务管家 bridge', ok: true, endpoints: ['/api/health', '/api/threads', '/api/alerts', '/api/account', '/api/models', '/api/audit'] });
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: app.connected, adapter: 'codex-app-server', appServer: app.connected ? 'running' : 'disconnected', codexHome: CODEX_HOME, watcher: 'rollout-scan', syncedAt: now() });
  if (req.method === 'GET' && url.pathname === '/api/account') return json(res, 200, await accountInfo());
  if (req.method === 'POST' && url.pathname === '/api/account/login') { auditAction('login'); spawn(CODEX_BIN, ['login', '--device-auth'], { detached: true, stdio: 'ignore', env: process.env }).unref(); return json(res, 202, { ok: true, message: '已启动 Codex 登录流程，请在浏览器完成账号切换' }); }
  if (req.method === 'GET' && url.pathname === '/api/threads') return json(res, 200, { data: await getThreads() });
  if (req.method === 'GET' && url.pathname === '/api/incidents') return json(res, 200, { data: await scanIncidents() });
  if (req.method === 'GET' && url.pathname === '/api/alerts') { const incidents = await scanIncidents(); const groups = new Map(); for (const item of incidents) { const key = `${item.threadId}:${item.code}`; const previous = groups.get(key); groups.set(key, previous ? { ...previous, lastSeenAt: item.timestamp, count: previous.count + 1 } : { ...item, firstSeenAt: item.timestamp, lastSeenAt: item.timestamp, count: 1, acknowledged: acknowledgedAlerts.has(item.id), recovered: false }); } return json(res, 200, { data: [...groups.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)) }); }
  if (req.method === 'POST' && url.pathname.match(/^\/api\/alerts\/([^/]+)\/acknowledge$/)) { acknowledgedAlerts.add(url.pathname.split('/')[3]); return json(res, 200, { ok: true, acknowledged: true }); }
  if (req.method === 'GET' && url.pathname === '/api/models') { const result = await app.request('model/list', { limit: 100 }); return json(res, 200, { data: result?.data || result?.models || result || [] }); }
  if (req.method === 'GET' && url.pathname === '/api/audit') return json(res, 200, { data: audit });
  if (id && req.method === 'GET' && pathMatch[2] === 'read') return json(res, 200, await app.request('thread/read', { threadId: id, includeTurns: true }));
  if (id && req.method === 'POST' && pathMatch[2] === 'continue') { const b = await body(req); return json(res, 200, await continueThread(id, b.model, b.actionId)); }
  if (id && req.method === 'POST' && pathMatch[2] === 'resume') return json(res, 200, await app.request('thread/resume', { threadId: id, excludeTurns: true }));
  return json(res, 404, { error: 'not_found' });
} catch (error) { return json(res, error.code === 'writer_conflict' ? 409 : 500, { error: error.message, code: error.code || 'bridge_error' }); } });
server.listen(PORT, '127.0.0.1', () => console.log(`Codex 任务管家 bridge listening on http://127.0.0.1:${PORT}`));
