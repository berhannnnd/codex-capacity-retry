import './style.css';
import { createRetryController, formatRemaining, RETRY_STATES } from './engine.js';

const app = document.querySelector('#app');
const controller = createRetryController({ maxAttempts: 4, baseDelay: 8, jitter: 0 });
let task = { threadId: null, id: 'task_7f2a', title: 'Refactor provider capability probes', model: 'gpt-6.1-sol', provider: 'OpenAI', started: '09:42:18', status: 'waiting' };
let logs = [
  ['09:42:18', 'ERROR', 'Selected model is at capacity. Please try a different model.'],
  ['09:42:18', 'INFO', 'Retry policy armed · exponential backoff · max 4 attempts'],
  ['09:41:52', 'INFO', 'Task resumed from checkpoint · plan digest 8c4e…']
];
let tick;
let bridge = { connected: false, threads: [], incidents: [] };

function log(level, message) {
  logs.unshift([new Date().toLocaleTimeString('en-US', { hour12: false }), level, message]);
}

function render() {
  const s = controller.snapshot;
  const remaining = s.nextAt ? formatRemaining(s.nextAt - Date.now()) : '—';
  const stateLabel = { idle: 'READY', waiting: 'WAITING', retrying: 'RETRYING', continued: 'CONTINUED', switched: 'SWITCHED', exhausted: 'EXHAUSTED' }[s.state];
  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div class="brand"><span class="brand-mark">↻</span><div><div class="eyebrow">LOCAL CONTROL PLANE</div><h1>Capacity Retry <span>Console</span></h1></div></div>
        <div class="top-actions"><span class="adapter-pill"><i></i> ${bridge.connected ? 'Live app-server' : 'Simulated adapter'}</span><button class="ghost" id="reset">Reset session</button></div>
      </header>
      <section class="hero">
        <div><p class="kicker">TASK RECOVERY / 01</p><h2>Keep the work moving<br><em>when capacity moves.</em></h2><p class="lede">A small control room for model-capacity failures. Observe the backoff, choose the next action, and keep a clear audit trail.</p></div>
        <div class="hero-orbit"><div class="orbit-ring"></div><div class="orbit-core"><strong>${String(s.attempt).padStart(2,'0')}</strong><span>attempt</span></div><span class="orbit-label">MODEL CAPACITY</span></div>
      </section>
      <section class="metrics"><div><span>ACTIVE TASK</span><strong>${task.id}</strong></div><div><span>PROVIDER</span><strong>${task.provider}</strong></div><div><span>MODEL</span><strong>${task.model}</strong></div><div><span>CHECKPOINT</span><strong>9 min ago</strong></div></section>
      <section class="workspace">
        <div class="primary-column">
          <article class="card incident-card"><div class="card-head"><div><span class="section-index">01</span><h3>Capacity incident</h3></div><span class="status ${s.state}"><i></i>${stateLabel}</span></div><div class="incident-body"><div class="signal"><div class="signal-icon">!</div><div><strong>Selected model is at capacity</strong><p>The provider returned a capacity response. The task is paused safely at its latest checkpoint.</p></div></div><div class="countdown"><div><span>NEXT RETRY IN</span><strong>${remaining}</strong></div><div class="progress"><span style="width:${s.nextAt ? Math.max(4, Math.min(100, 100 - ((s.nextAt - Date.now()) / 8000) * 100)) : 0}%"></span></div><small>Attempt ${s.attempt} of ${s.maxAttempts} · no work is lost</small></div></div></article>
          <article class="card action-card"><div class="card-head"><div><span class="section-index">02</span><h3>Choose a recovery action</h3></div><span class="hint">Safe by default</span></div><div class="actions"><button class="action primary" id="retry"><span class="action-icon">↻</span><span><b>Retry current task</b><small>Wait for the next slot, then resume from checkpoint.</small></span><kbd>R</kbd></button><button class="action" id="continue"><span class="action-icon">→</span><span><b>Continue in a new session</b><small>Open a clean session with the same task context.</small><kbd>N</kbd></button><button class="action" id="switch"><span class="action-icon">⇄</span><span><b>Switch model</b><small>Pick a configured fallback. Requires an explicit adapter.</small><kbd>M</kbd></button></div></article>
          <article class="card adapter-card"><div class="card-head"><div><span class="section-index">03</span><h3>Adapter boundary</h3></div><span class="tag">EXPLICIT</span></div><div class="adapter-row"><div class="adapter-state"><span class="adapter-dot"></span><div><strong>Simulation only</strong><small>Actions update this console and its log.</small></div></div><div class="adapter-copy">Real Codex API or desktop control is intentionally not claimed. Implement <code>TaskAdapter</code> to connect a verified runtime.</div></div></article>
        </div>
        <aside class="log-panel"><div class="log-head"><div><span class="section-index">LIVE FEED</span><h3>Event log</h3></div><span class="live-dot">LIVE</span></div><div class="log-list">${logs.map(([time, level, message]) => `<div class="log-row"><time>${time}</time><span class="log-level ${level.toLowerCase()}">${level}</span><p>${message}</p></div>`).join('')}</div><button class="clear" id="clear">Clear log <span>⌘K</span></button></aside>
      </section>
      <footer><span>CAPACITY RETRY CONSOLE · 0.1.0</span><span>LOCAL STATE ONLY · <a href="https://github.com" target="_blank" rel="noreferrer">adapter docs ↗</a></span></footer>
    </main>`;
  bind();
}

function bind() {
  document.querySelector('#retry').onclick = async () => { controller.markRetrying(); log('INFO', `Retry dispatched for ${task.id} · attempt ${controller.snapshot.attempt}`); if (bridge.connected && task.threadId) { await liveContinue(); } else { setTimeout(() => { controller.fail(); log('WARN', 'Provider still at capacity · backoff scheduled'); render(); }, 500); } render(); };
  document.querySelector('#continue').onclick = () => { controller.markContinued(); task = { ...task, id: 'task_new_91c', status: 'continued' }; log('INFO', 'New session created from checkpoint · adapter simulation'); render(); };
  document.querySelector('#switch').onclick = async () => { controller.markSwitched(); task = { ...task, model: 'gpt-6-luna', status: 'switched' }; if (bridge.connected && task.threadId) await liveContinue('gpt-6-luna'); log('INFO', bridge.connected ? 'Fallback model turn sent through Codex app-server' : 'Fallback model selected · gpt-6-luna (simulated)'); render(); };
  document.querySelector('#reset').onclick = () => { controller.reset(); task = { id: 'task_7f2a', title: 'Refactor provider capability probes', model: 'gpt-6.1-sol', provider: 'OpenAI', started: '09:42:18', status: 'waiting' }; logs = []; log('INFO', 'Session reset · waiting for task event'); render(); };
  document.querySelector('#clear').onclick = () => { logs = []; render(); };
}

async function liveContinue(model) { const response = await fetch(`http://127.0.0.1:8787/api/threads/${task.threadId}/continue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(model ? { model } : {}) }); if (!response.ok) { log('ERROR', `app-server action failed · HTTP ${response.status}`); return; } log('INFO', 'app-server accepted continuation turn'); }
async function syncBridge() { try { const health = await fetch('http://127.0.0.1:8787/api/health'); if (!health.ok) return; const [incidents, threads] = await Promise.all([fetch('http://127.0.0.1:8787/api/incidents').then(r => r.json()), fetch('http://127.0.0.1:8787/api/threads?limit=40').then(r => r.json())]); bridge = { connected: true, incidents: incidents.data || [], threads: threads.data || [] }; const latest = bridge.incidents[0]; const found = latest && bridge.threads.find(t => t.id === latest.threadId); if (latest) task = { ...task, threadId: latest.threadId, id: latest.threadId, model: found?.model || task.model, provider: found?.modelProvider || task.provider, title: found?.name || task.title }; log('INFO', `Live bridge connected · ${bridge.incidents.length} recorded capacity events`); render(); } catch { /* local simulation remains available */ } }
tick = setInterval(() => { if (controller.snapshot.nextAt) render(); }, 1000);
render();
syncBridge();
