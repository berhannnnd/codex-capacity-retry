import './style.css';
import { createRetryController, formatRemaining } from './engine.js';

const app = document.querySelector('#app');
const controller = createRetryController({ maxAttempts: 4, baseDelay: 8, jitter: 0 });
let bridge = { connected: false, incidents: [], threads: [], account: { accountId: '未读取', authMode: 'unknown', lastRefresh: null, usage: { available: false } } };
let selected = { threadId: null, title: '等待同步本机线程', model: '—', provider: '—', updated: '—' };
let logs = [];
let lastSync = null;
let timer;

function log(level, message) {
  logs.unshift({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level, message });
  logs = logs.slice(0, 30);
}
function latestIncident() { return bridge.incidents[0]; }
function selectedThread() { return bridge.threads.find((thread) => thread.id === selected.threadId); }

function render() {
  const incident = latestIncident();
  const thread = selectedThread();
  const s = controller.snapshot;
  const remaining = s.nextAt ? formatRemaining(s.nextAt - Date.now()) : '—';
  const state = s.state === 'waiting' ? '等待恢复' : s.state === 'retrying' ? '正在恢复' : s.state === 'continued' ? '已发送继续指令' : s.state === 'switched' ? '已切换模型' : '监听中';
  const statusText = bridge.connected ? '实时监听已连接' : '演示模式';
  const account = bridge.account || {};
  const refreshed = account.lastRefresh ? new Date(account.lastRefresh).toLocaleString('zh-CN') : '—';
  selected = { ...selected, title: selected.threadId ? (selected.title === '等待同步本机线程' ? `线程 ${selected.threadId.slice(0, 12)}…` : selected.title) : selected.title, ...(thread ? { title: thread.name || thread.preview || selected.title, model: thread.model || '—', provider: thread.modelProvider || '—', updated: thread.updatedAt ? new Date(thread.updatedAt * 1000).toLocaleString('zh-CN') : '—' } : {}) };
  app.innerHTML = `<main class="app-shell">
    <header class="topbar"><nav class="side-nav"><span class="nav-active">⌂</span><span>◈</span><span>◌</span><span>⚙</span></nav><div class="brand"><div class="brand-mark">⌁</div><div><div class="brand-name">Codex 任务管家</div><div class="brand-sub">本机线程监听与安全恢复</div></div></div><div class="top-actions"><span class="account-chip">账号 ${account.accountId || '未读取'} <button id="switchAccount">切换</button></span><span class="connection ${bridge.connected ? 'connected' : ''}"><i></i>${statusText}</span><button class="text-button" id="refresh">立即同步</button></div></header>
    <section class="welcome"><div><div class="eyebrow">控制台首页</div><h1>你的 Codex 任务，<span>现在怎么样？</span></h1><p>这里集中展示本机 Codex 线程的运行状态、容量错误和可执行的恢复动作。数据来自 app-server 与本地 rollout 记录。</p></div><div class="sync-time">最近同步<br><strong>${lastSync || '尚未同步'}</strong></div></section>
    <section class="summary-grid"><article class="summary-card"><div class="summary-label">实时状态</div><strong class="summary-value"><span class="live-dot"></span>${bridge.connected ? 'Running' : 'Offline'}</strong><small>app-server 与本地记录监听</small></article><article class="summary-card"><div class="summary-label">今日告警</div><strong class="summary-value warning">${bridge.incidents.length}</strong><small>已落盘的容量/过载失败事件</small></article><article class="summary-card"><div class="summary-label">当前模型</div><strong class="summary-value model">${selected.model}</strong><small>${selected.provider} · 线程最后记录</small></article><article class="summary-card"><div class="summary-label">剩余用量</div><strong class="summary-value usage">不可读取</strong><small>当前 Codex app-server 未提供额度字段</small></article></section>
    <section class="layout"><div class="main-column">
      <article class="panel selected-panel"><div class="panel-title"><div><div class="eyebrow">当前选中</div><h2>${selected.title}</h2></div><span class="state-chip ${incident ? 'danger' : 'ok'}"><i></i>${incident ? '需要关注' : state}</span></div><div class="detail-grid"><div><span>线程 ID</span><strong>${selected.threadId || '暂无'}</strong></div><div><span>最近更新时间</span><strong>${selected.updated}</strong></div><div><span>模型 / Provider</span><strong>${selected.model} / ${selected.provider}</strong></div></div>${incident ? `<div class="incident"><div class="incident-icon">!</div><div><strong>检测到模型容量错误</strong><p>${incident.message}</p><small>发生时间：${new Date(incident.timestamp).toLocaleString('zh-CN')} · turn：${incident.turnId || '未知'}</small></div></div>` : `<div class="empty-state"><strong>当前没有新的容量错误</strong><p>监听服务会继续检查新的 rollout 事件。</p></div>`}</article>
      <article class="panel"><div class="panel-title"><div><div class="eyebrow">怎么处理</div><h2>选择一个恢复动作</h2></div><span class="muted-label">动作会写入真实 Codex 线程</span></div><div class="action-list"><button class="action primary" id="continue"><span class="action-number">1</span><span><b>继续当前工作</b><small>恢复线程并发送“从最新检查点继续”的新 turn。</small></span><span class="arrow">→</span></button><button class="action" id="switch"><span class="action-number">2</span><span><b>换一个模型继续</b><small>使用备用模型发送新 turn，适合持续过载时使用。</small></span><span class="arrow">→</span></button><button class="action" id="retry"><span class="action-number">3</span><span><b>稍后再试</b><small>按退避策略等待后再发起恢复，不会立即重复请求。</small></span><span class="arrow">→</span></button></div><div class="action-note">安全提示：恢复动作可能继续执行未完成的工具步骤。请先确认线程没有在其他窗口里继续运行。</div></article>
      <article class="panel account-panel"><div class="panel-title"><div><div class="eyebrow">账号与权限</div><h2>${account.authMode === 'chatgpt' ? 'ChatGPT 登录' : account.authMode}</h2></div><button class="outline-button" id="switchAccount2">切换账号</button></div><div class="account-details"><div><span>当前账号</span><strong>${account.accountId || '未读取'}</strong></div><div><span>最近刷新</span><strong>${refreshed}</strong></div><div><span>用量状态</span><strong class="muted">${account.usage?.available ? '已连接' : '接口未提供'}</strong></div></div></article><article class="panel explain-panel"><div class="panel-title"><div><div class="eyebrow">指标说明</div><h2>这几个数字分别是什么？</h2></div></div><div class="explain-grid"><div><b>容量错误</b><p>Codex 已记录但模型暂时无法接收请求的失败次数。</p></div><div><b>线程 ID</b><p>一段 Codex 对话的唯一编号，用来读取和恢复同一任务。</p></div><div><b>当前模型</b><p>线程最后记录的模型名称，不是实时额度或可用性保证。</p></div><div><b>真实模式</b><p>已连接本机 app-server，并读取真实线程和 rollout 文件。</p></div></div></article>
    </div><aside class="panel feed"><div class="panel-title"><div><div class="eyebrow">实时动态</div><h2>事件记录</h2></div><button class="text-button" id="clear">清空</button></div><div class="feed-list">${logs.length ? logs.map((item) => `<div class="feed-item"><time>${item.time}</time><span class="level ${item.level.toLowerCase()}">${item.level}</span><p>${item.message}</p></div>`).join('') : '<div class="feed-empty">同步后，线程变化和恢复动作会显示在这里。</div>'}</div></aside></section>
    <footer><span>Codex 任务管家 · 本地运行</span><span>${bridge.connected ? '数据源：app-server + rollout JSONL' : '数据源：模拟适配器'}</span></footer>
  </main>`;
  bind();
}

async function liveContinue(model) {
  if (!selected.threadId) { log('WARN', '尚未选中可恢复的线程'); render(); return; }
  const response = await fetch(`http://127.0.0.1:8787/api/threads/${selected.threadId}/continue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(model ? { model } : {}) });
  if (!response.ok) { log('ERROR', `恢复请求失败 · HTTP ${response.status}`); return; }
  log('INFO', model ? `已发送换模型继续请求 · ${model}` : '已发送继续当前工作的请求');
}
async function syncBridge() {
  try {
    const health = await fetch('http://127.0.0.1:8787/api/health');
    if (!health.ok) throw new Error('bridge unavailable');
    const [incidents, threads, account] = await Promise.all([fetch('http://127.0.0.1:8787/api/incidents').then((r) => r.json()), fetch('http://127.0.0.1:8787/api/threads?limit=40').then((r) => r.json()), fetch('http://127.0.0.1:8787/api/account').then((r) => r.json())]);
    const previous = bridge.connected; bridge = { connected: true, incidents: incidents.data || [], threads: threads.data || [], account };
    const incident = latestIncident(); if (incident && (!selected.threadId || !bridge.threads.some((t) => t.id === selected.threadId))) selected.threadId = incident.threadId;
    if (selected.threadId) { try { const detail = await fetch(`http://127.0.0.1:8787/api/threads/${selected.threadId}/read`).then((r) => r.json()); const realThread = detail.thread || detail; if (realThread?.id) selected = { ...selected, title: realThread.name || realThread.preview || `线程 ${realThread.id.slice(0, 12)}…`, model: realThread.model || selected.model, provider: realThread.modelProvider || selected.provider, updated: realThread.updatedAt ? new Date(realThread.updatedAt * 1000).toLocaleString('zh-CN') : selected.updated }; } catch { selected.title = selected.threadId ? `线程 ${selected.threadId.slice(0, 12)}…` : selected.title; } }
    lastSync = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    if (!previous) log('INFO', `已连接真实 Codex · 发现 ${bridge.incidents.length} 条容量事件`);
    render();
  } catch { if (bridge.connected) { bridge.connected = false; log('WARN', '真实桥接暂时不可用，已切回演示模式'); render(); } }
}
function bind() {
  document.querySelector('#refresh').onclick = syncBridge;
  document.querySelector('#clear').onclick = () => { logs = []; render(); };
  const switchAccount = async () => { const response = await fetch('http://127.0.0.1:8787/api/account/login', { method: 'POST' }); log(response.ok ? 'INFO' : 'ERROR', response.ok ? '已启动账号切换流程，请在浏览器完成登录' : '账号切换启动失败'); render(); };
  document.querySelector('#switchAccount').onclick = switchAccount;
  document.querySelector('#switchAccount2').onclick = switchAccount;
  document.querySelector('#continue').onclick = async () => { controller.markContinued(); if (bridge.connected) await liveContinue(); else log('INFO', '演示：已创建继续任务'); render(); };
  document.querySelector('#switch').onclick = async () => { controller.markSwitched(); if (bridge.connected) await liveContinue('gpt-6-luna'); else log('INFO', '演示：已切换到 gpt-6-luna'); render(); };
  document.querySelector('#retry').onclick = () => { controller.markRetrying(); log('INFO', `退避计时开始 · 第 ${controller.snapshot.attempt} 次`); controller.fail(); render(); };
}
render(); syncBridge(); timer = setInterval(syncBridge, 5000); window.addEventListener('beforeunload', () => clearInterval(timer));
