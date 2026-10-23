#!/usr/bin/env node
/**
 * Windows keepalive for the Codex desktop app (Node.js, stdlib only).
 *
 * The desktop app keeps an exclusive writer lock on every conversation it has
 * open, so resuming those threads from a second `codex app-server` instance
 * (the bridge's default continue path) fails with
 * `thread ... already has an active writer`.
 *
 * This watcher tails the session rollout files under CODEX_HOME/sessions and,
 * when a turn ends with `Selected model is at capacity`
 * (codex_error_info: server_overloaded), runs a recovery ladder. Each step is
 * verified by watching the rollout for a task_started before escalating:
 *
 *   1. navigate the app to the thread via `codex://threads/<id>`
 *   2. goal threads: when the thread goal went `blocked`, restore it with
 *      `thread/goal/set` (goal APIs bypass the rollout writer lock) and give
 *      the goal engine a window to resume on its own — zero context cost.
 *      Only `blocked` is auto-restored; `paused` / usage / budget states are
 *      treated as user intent and left alone.
 *   3. click the error card's Retry button through UI Automation (same-turn
 *      retry, no focus stealing; Chromium's accessibility tree is materialized
 *      by briefly flipping the SPI_SETSCREENREADER flag and restoring it).
 *   4. fall back to typing a goal-aware continue message with SendInput
 *      (send_keys.ps1, Unicode-safe) and restoring the previous foreground
 *      window.
 *
 * Safety: only reacts to errors that happen after startup, per-thread backoff
 * with a consecutive-attempt cap, cancels when the user already sent a message
 * or aborted the turn, single instance via pid lock, JSONL audit log.
 *
 * Usage: node keepalive.js [--message 继续] [--dry-run] [--max-attempts 8]
 *                          [--initial-delay 8] [--poll 3]
 *                          [--no-goal-restore] [--no-retry-click] [--scan]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(BASE, 'keepalive.log');
const LOCK_PATH = path.join(BASE, 'keepalive.lock');
const SEND_KEYS = path.join(BASE, 'send_keys.ps1');
const CLICK_RETRY = path.join(BASE, 'click_retry.ps1');
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_DIR = process.env.CODEX_KEEPALIVE_SESSIONS || path.join(CODEX_HOME, 'sessions');

const CAPACITY_CODES = new Set(['server_overloaded']);
const CAPACITY_MARK = 'at capacity';
const GOAL_RESTORE_STATES = new Set(['blocked']); // paused/usage/budget/complete are user or engine intent

const DEFAULT_MESSAGE = '继续当前任务，从中断处继续，不要重复已完成的工作。';
const GOAL_WAKE_WAIT_MS = 12000;  // window for the goal engine to resume by itself
const RETRY_WAIT_MS = 10000;      // window for a clicked retry / typed message to start a turn

function nowUtcIso() {
  return new Date().toISOString().slice(0, 19) + 'Z';
}

function logEvent(event, fields = {}) {
  const line = JSON.stringify({ ts: nowUtcIso(), event, ...fields });
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n', 'utf8'); } catch { /* log best-effort */ }
}

function acquireSingleInstanceLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = fs.openSync(LOCK_PATH, 'wx');
      fs.writeSync(fh, `pid=${process.pid}\n`);
      fs.closeSync(fh);
      const cleanup = () => { try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ } };
      process.on('exit', cleanup);
      process.on('SIGINT', () => { cleanup(); process.exit(0); });
      process.on('SIGTERM', () => { cleanup(); process.exit(0); });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let old = '';
      try { old = fs.readFileSync(LOCK_PATH, 'utf8').trim(); } catch { /* unreadable */ }
      const pid = Number((old.match(/pid=(\d+)/) || [])[1]);
      let alive = Number.isInteger(pid) && pid > 0;
      if (alive) { try { process.kill(pid, 0); } catch { alive = false; } }
      if (alive) {
        console.error(`another keepalive instance is running (${old})`);
        process.exit(1);
      }
      try { fs.unlinkSync(LOCK_PATH); } catch { /* raced; retry will fail loudly */ }
    }
  }
  console.error('could not acquire keepalive.lock');
  process.exit(1);
}

function listRolloutFiles(root) {
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(root);
  return files;
}

function threadIdOf(file) {
  const name = path.basename(file);
  if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) return null;
  const parts = name.slice('rollout-'.length, -'.jsonl'.length).split('-');
  if (parts.length < 3) return null;
  return parts.slice(-5).join('-'); // 8-4-4-4-12 id; date/time prefix has 2 dashes
}

/** Minimal JSON-RPC client for `codex app-server`, spawned on demand. */
class AppServer {
  constructor() {
    this.proc = spawn(CODEX_BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.nextId = 1;
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message || 'app-server error')) : p.resolve(msg.result);
        }
      } catch { /* non-JSON line */ }
    });
    this.proc.stderr.on('data', () => { /* verbose codex logs, ignore */ });
    this.ready = this.call('initialize', { clientInfo: { name: 'capacity-keepalive', title: 'Capacity Keepalive', version: '0.3.0' } });
  }
  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  request(method, params) { return this.ready.then(() => this.call(method, params)); }
  close() { try { this.proc.kill(); } catch { /* already gone */ } }
}

class Keepalive {
  constructor(cfg) {
    this.cfg = cfg;
    this.offsets = new Map();      // rollout path -> byte offset of last complete line
    this.threads = new Map();      // thread id -> { streak, pendingAt, gaveUp }
    this.threadFiles = new Map();  // thread id -> rollout path (for wait loops)
    this.lastHeartbeat = 0;
    this.running = false;
  }

  stateOf(tid) {
    if (!this.threads.has(tid)) this.threads.set(tid, { streak: 0, pendingAt: null, gaveUp: false });
    return this.threads.get(tid);
  }

  poll() {
    for (const file of listRolloutFiles(SESSIONS_DIR)) {
      let size = 0;
      try { size = fs.statSync(file).size; } catch { continue; }
      let offset = this.offsets.get(file);
      if (offset === undefined) {
        // First sight of this file: skip everything already on disk so we only
        // act on failures that happen while the monitor runs.
        this.offsets.set(file, size);
        const tid = threadIdOf(file);
        if (tid) this.threadFiles.set(tid, file);
        continue;
      }
      if (size < offset) { offset = 0; }
      if (size === offset) continue;
      let chunk;
      try {
        const fh = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fh, buf, 0, buf.length, offset);
          chunk = buf;
        } finally { fs.closeSync(fh); }
      } catch { continue; }
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl === -1) continue; // no complete line appended yet
      this.offsets.set(file, offset + lastNl + 1);
      const tid = threadIdOf(file);
      if (!tid) continue;
      this.threadFiles.set(tid, file);
      for (const line of chunk.subarray(0, lastNl).toString('utf8').split('\n')) {
        if (line) this.handleLine(tid, line);
      }
    }
  }

  handleLine(tid, line) {
    let d;
    try { d = JSON.parse(line); } catch { return; }
    if (d.type !== 'event_msg') return;
    const p = d.payload || {};
    const st = this.stateOf(tid);

    if (p.type === 'task_complete') {
      const err = p.error || {};
      const isCapacity = !!p.error && (CAPACITY_CODES.has(err.codex_error_info)
        || String(err.message || '').toLowerCase().includes(CAPACITY_MARK));
      if (isCapacity) {
        st.streak += 1;
        if (st.streak > this.cfg.maxAttempts) {
          if (!st.gaveUp) {
            st.gaveUp = true;
            st.pendingAt = null;
            logEvent('give_up', { thread: tid, streak: st.streak, reason: `exceeded max_attempts=${this.cfg.maxAttempts}` });
          }
        } else {
          const delay = this.backoffSeconds(st.streak);
          st.pendingAt = Date.now() + delay * 1000;
          logEvent('capacity_error', { thread: tid, streak: st.streak, message: err.message, retry_in_s: Math.round(delay * 10) / 10 });
        }
      } else if (!p.error) {
        if (st.streak || st.pendingAt !== null || st.gaveUp) {
          logEvent('recovered', { thread: tid, after_streak: st.streak });
        }
        st.streak = 0; st.pendingAt = null; st.gaveUp = false;
      }
    } else if (p.type === 'task_started') {
      // A new turn started: either our own recovery already fired, or the user
      // came back. Either way there is nothing left to schedule.
      if (st.pendingAt !== null) {
        st.pendingAt = null;
        logEvent('cancelled_user_acted', { thread: tid });
      }
    } else if (p.type === 'turn_aborted') {
      // The user (or app) aborted: respect the stop, never auto-continue.
      if (st.pendingAt !== null) {
        st.pendingAt = null;
        logEvent('cancelled_aborted', { thread: tid });
      }
    }
  }

  backoffSeconds(streak) {
    return Math.min(this.cfg.initialDelay * 1.5 ** Math.max(0, streak - 1), 60);
  }

  /** Wait for a task_started to appear in the thread's rollout. */
  async waitForTaskStarted(tid, ms) {
    const file = this.threadFiles.get(tid);
    if (!file) return false;
    const deadline = Date.now() + ms;
    let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
    while (Date.now() < deadline) {
      await sleep(1000);
      let size = 0;
      try { size = fs.statSync(file).size; } catch { continue; }
      if (size <= offset) continue;
      let chunk = '';
      try {
        const fh = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fh, buf, 0, buf.length, offset);
          chunk = buf.toString('utf8');
        } finally { fs.closeSync(fh); }
      } catch { continue; }
      offset = size;
      if (chunk.includes('"task_started"')) return true;
    }
    return false;
  }

  async firePending() {
    const now = Date.now();
    for (const [tid, st] of this.threads) {
      if (st.pendingAt !== null && now >= st.pendingAt) {
        st.pendingAt = null; // clear before recovering so our own task_started never cancels anything
        await this.recover(tid, st.streak);
      }
    }
  }

  // ---------- recovery ladder ----------

  async readGoal(tid) {
    const app = new AppServer();
    try {
      const result = await app.request('thread/goal/get', { threadId: tid });
      return result?.goal || null;
    } catch (error) {
      logEvent('goal_query_failed', { thread: tid, error: String(error.message || error).slice(0, 200) });
      return null;
    } finally {
      app.close();
    }
  }

  async restoreGoal(tid, objective) {
    const app = new AppServer();
    try {
      await app.request('thread/goal/set', { threadId: tid, objective, status: 'active' });
      return true;
    } catch (error) {
      logEvent('goal_restore_failed', { thread: tid, error: String(error.message || error).slice(0, 200) });
      return false;
    } finally {
      app.close();
    }
  }

  async runPowershell(script, args = []) {
    try {
      const { stdout } = await execFileAsync('powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { timeout: 30000 });
      return String(stdout).trim();
    } catch (error) {
      return `error: ${String(error.message || error).slice(0, 150)}`;
    }
  }

  goalAwareMessage(objective) {
    const trimmed = objective.length > 160 ? `${objective.slice(0, 160)}…` : objective;
    return `继续执行当前目标：${trimmed}\n从中断处继续，不要重复已完成的工作；先检查当前状态再继续。`;
  }

  async recover(tid, attempt) {
    if (this.cfg.dryRun) {
      logEvent('recover_dry_run', { thread: tid, attempt, message: this.cfg.message });
      return;
    }
    logEvent('recover_start', { thread: tid, attempt });

    // Step 0: bring the thread to the front tab so the Retry card is in the DOM.
    try {
      await execFileAsync('cmd', ['/c', 'start', '', `codex://threads/${tid}`]);
    } catch (error) {
      logEvent('recover_failed', { thread: tid, step: 'navigate', error: String(error.message || error) });
      return;
    }
    await sleep(1500);

    // Step 1: goal restore (engine-level, zero context cost).
    let goal = null;
    if (this.cfg.goalRestore) {
      goal = await this.readGoal(tid);
      if (goal) {
        logEvent('goal_state', { thread: tid, status: goal.status, tokens_used: goal.tokensUsed });
        if (GOAL_RESTORE_STATES.has(goal.status)) {
          const ok = await this.restoreGoal(tid, goal.objective);
          if (ok) {
            logEvent('goal_restored', { thread: tid });
            const started = await this.waitForTaskStarted(tid, GOAL_WAKE_WAIT_MS);
            if (started) {
              logEvent('recover_done', { thread: tid, attempt, mode: 'goal-restore' });
              return;
            }
          }
        }
      }
    }

    // Step 2: Retry button via UI Automation (same-turn retry, no focus steal).
    if (this.cfg.retryClick) {
      const result = await this.runPowershell(CLICK_RETRY);
      if (result === 'invoked') {
        const started = await this.waitForTaskStarted(tid, RETRY_WAIT_MS);
        if (started) {
          logEvent('recover_done', { thread: tid, attempt, mode: 'retry-button' });
          return;
        }
        logEvent('retry_clicked_no_start', { thread: tid });
      } else if (result === 'no-window') {
        logEvent('recover_failed', { thread: tid, step: 'retry-click', reason: 'desktop window not found' });
        return;
      } else {
        logEvent('retry_click_skipped', { thread: tid, result });
      }
    }

    // Step 3: type a goal-aware (or plain) continue message.
    const message = goal?.objective ? this.goalAwareMessage(goal.objective) : this.cfg.message;
    const typed = await this.runPowershell(SEND_KEYS, ['-Text', message, '-Enter']);
    if (!typed.includes('typed')) {
      logEvent('recover_failed', { thread: tid, step: 'send_keys', out: typed });
      return;
    }
    const started = await this.waitForTaskStarted(tid, RETRY_WAIT_MS);
    logEvent(started ? 'recover_done' : 'recover_typed_no_start', { thread: tid, attempt, mode: 'typed' });
  }

  // ---------- main loop ----------

  async run() {
    logEvent('started', {
      pid: process.pid, sessions: SESSIONS_DIR, message: this.cfg.message,
      dry_run: this.cfg.dryRun, max_attempts: this.cfg.maxAttempts, initial_delay: this.cfg.initialDelay,
      goal_restore: this.cfg.goalRestore, retry_click: this.cfg.retryClick,
    });
    this.running = true;
    while (this.running) {
      try {
        this.poll();
        await this.firePending();
      } catch (error) {
        logEvent('loop_error', { error: String(error && error.stack || error).slice(0, 400) });
      }
      if (Date.now() - this.lastHeartbeat > 600000) {
        this.lastHeartbeat = Date.now();
        logEvent('heartbeat', { watching: this.offsets.size });
      }
      await sleep(this.cfg.poll * 1000);
    }
  }
}

function scanHistory(hours) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  for (const file of listRolloutFiles(SESSIONS_DIR)) {
    try {
      if (fs.statSync(file).mtimeMs < cutoff) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        let d; try { d = JSON.parse(line); } catch { continue; }
        if (d.type !== 'event_msg' || d.payload?.type !== 'task_complete') continue;
        const err = d.payload.error || {};
        if (d.payload.error && (CAPACITY_CODES.has(err.codex_error_info)
          || String(err.message || '').toLowerCase().includes(CAPACITY_MARK))) {
          console.log(`${d.timestamp}  ${path.basename(file).slice(0, 60)}  ${err.codex_error_info}  ${err.message}`);
        }
      }
    } catch { /* unreadable file */ }
  }
}

function main() {
  const { values: cfg } = parseArgs({
    options: {
      message: { type: 'string', default: DEFAULT_MESSAGE },
      'dry-run': { type: 'boolean', default: false },
      'max-attempts': { type: 'string', default: '8' },
      'initial-delay': { type: 'string', default: '8' },
      poll: { type: 'string', default: '3' },
      'no-goal-restore': { type: 'boolean', default: false },
      'no-retry-click': { type: 'boolean', default: false },
      scan: { type: 'boolean', default: false },
    },
  });
  const norm = {
    message: cfg.message,
    dryRun: cfg['dry-run'],
    maxAttempts: Number(cfg['max-attempts']),
    initialDelay: Number(cfg['initial-delay']),
    poll: Number(cfg.poll),
    goalRestore: !cfg['no-goal-restore'],
    retryClick: !cfg['no-retry-click'],
  };
  if (cfg.scan) { scanHistory(24); return; }
  acquireSingleInstanceLock();
  new Keepalive(norm).run().catch((error) => { console.error(error); process.exit(1); });
}

main();
