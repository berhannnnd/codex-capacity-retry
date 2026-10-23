#!/usr/bin/env node
/**
 * Windows keepalive for the Codex desktop app (Node.js, stdlib only).
 *
 * The desktop app keeps an exclusive writer lock on every conversation it has
 * open, so resuming those threads from a second `codex app-server` instance
 * (the bridge's default continue path) fails with
 * `thread ... already has an active writer`.
 *
 * This watcher takes the other road: it tails the session rollout files under
 * CODEX_HOME/sessions, and when a turn ends with
 * `Selected model is at capacity` (codex_error_info: server_overloaded) it
 *
 *   1. navigates the desktop app to that thread via `codex://threads/<id>`,
 *   2. activates the window and types a "继续" message with SendInput
 *      (send_keys.ps1, Unicode-safe, IME/layout independent),
 *   3. restores the previously focused window.
 *
 * Safety: only reacts to errors that happen after startup, per-thread backoff
 * with a consecutive-attempt cap, cancels when the user already sent a message
 * or aborted the turn, single instance via pid lock, JSONL audit log.
 *
 * Usage: node keepalive.js [--message 继续] [--dry-run] [--max-attempts 8]
 *                          [--initial-delay 8] [--poll 3] [--scan]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(BASE, 'keepalive.log');
const LOCK_PATH = path.join(BASE, 'keepalive.lock');
const SEND_KEYS = path.join(BASE, 'send_keys.ps1');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_DIR = process.env.CODEX_KEEPALIVE_SESSIONS || path.join(CODEX_HOME, 'sessions');

const CAPACITY_CODES = new Set(['server_overloaded']);
const CAPACITY_MARK = 'at capacity';

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

class Keepalive {
  constructor(cfg) {
    this.cfg = cfg;
    this.offsets = new Map(); // rollout path -> byte offset of last complete line
    this.threads = new Map(); // thread id -> { streak, pendingAt, gaveUp }
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
      // A new turn started: either our own injection already fired, or the user
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

  async firePending() {
    const now = Date.now();
    for (const [tid, st] of this.threads) {
      if (st.pendingAt !== null && now >= st.pendingAt) {
        st.pendingAt = null; // clear before injecting so our own task_started never cancels anything
        await this.inject(tid, st.streak);
      }
    }
  }

  async inject(tid, attempt) {
    if (this.cfg.dryRun) {
      logEvent('inject_dry_run', { thread: tid, attempt, message: this.cfg.message });
      return;
    }
    logEvent('inject_start', { thread: tid, attempt, message: this.cfg.message });
    try {
      await execFileAsync('cmd', ['/c', 'start', '', `codex://threads/${tid}`]);
    } catch (error) {
      logEvent('inject_failed', { thread: tid, step: 'navigate', error: String(error.message || error) });
      return;
    }
    await sleep(1500);
    try {
      const { stdout } = await execFileAsync('powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SEND_KEYS, '-Text', this.cfg.message, '-Enter'],
        { timeout: 30000 });
      if (String(stdout).includes('typed')) {
        logEvent('inject_done', { thread: tid, attempt });
      } else {
        logEvent('inject_failed', { thread: tid, attempt, out: String(stdout).trim().slice(0, 200) });
      }
    } catch (error) {
      logEvent('inject_failed', { thread: tid, step: 'send_keys', error: String(error.message || error).slice(0, 300) });
    }
  }

  async run() {
    logEvent('started', {
      pid: process.pid, sessions: SESSIONS_DIR, message: this.cfg.message,
      dry_run: this.cfg.dryRun, max_attempts: this.cfg.maxAttempts, initial_delay: this.cfg.initialDelay,
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
      message: { type: 'string', default: '继续' },
      'dry-run': { type: 'boolean', default: false },
      'max-attempts': { type: 'string', default: '8' },
      'initial-delay': { type: 'string', default: '8' },
      poll: { type: 'string', default: '3' },
      scan: { type: 'boolean', default: false },
    },
  });
  const norm = {
    message: cfg.message,
    dryRun: cfg['dry-run'],
    maxAttempts: Number(cfg['max-attempts']),
    initialDelay: Number(cfg['initial-delay']),
    poll: Number(cfg.poll),
  };
  if (cfg.scan) { scanHistory(24); return; }
  acquireSingleInstanceLock();
  new Keepalive(norm).run().catch((error) => { console.error(error); process.exit(1); });
}

main();
