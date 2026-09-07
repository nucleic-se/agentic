/** Dependency-free browser client. All remote content is rendered as text. */
export const WEB_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Agentic</title><link rel="stylesheet" href="/app.css"><script defer src="/app.js"></script></head>
<body><section id="login" class="login"><form id="login-form" class="login-card"><span class="eyebrow">YOUR AGENT WORKSPACE</span><h1>Agentic<span class="accent">.</span></h1><p>A quiet place to get things done.</p><label for="token">Workspace access token</label><input id="token" type="password" required autocomplete="current-password" minlength="24"><button type="submit" class="primary">Connect to workspace →</button><p id="login-error" role="alert"></p><small>Connect using the token from your local agent host.</small></form></section>
<div id="app" hidden><aside id="sidebar"><div class="brand">Agentic<span class="accent">.</span><button id="close-drawer" class="mobile" aria-label="Close sessions">×</button></div><button id="new" class="new-session">＋ New session</button><div class="eyebrow section-label">SESSIONS</div><nav id="sessions" aria-label="Sessions"></nav><div class="sidebar-bottom"><button id="inspect">Inspect session</button><button id="composition">◈ Extensions</button><button id="logout">Disconnect</button><span class="local-label">LOCAL WORKSPACE</span></div></aside><button id="scrim" class="scrim" aria-label="Close navigation" hidden></button>
<main><header><button id="menu" class="mobile" aria-label="Open sessions">☰</button><div class="heading"><h2 id="title">Workspace</h2><span id="status">Choose a session to begin</span></div><div class="header-actions"><span id="connection" class="connection">Connecting</span><button id="fork" title="Fork current session">Fork</button><button id="resume">Resume</button></div></header><div id="error" role="alert" hidden></div><section id="transcript" aria-label="Conversation"><div class="empty"><span class="eyebrow">READY WHEN YOU ARE</span><h1>What are we building?</h1><p>Start a session. Give your agent a task.</p></div></section><section id="approvals" aria-label="Pending approvals"></section><section class="composer-wrap"><div id="queue" class="queue"></div><form id="composer"><textarea id="message" rows="3" placeholder="Describe a task, ask a question, or steer the agent…" aria-label="Message"></textarea><div class="composer-bottom"><select id="mode" aria-label="Message delivery"><option value="steer">Steer current work</option><option value="enqueue">Queue follow-up</option></select><div><button id="cancel" type="button">Stop</button><button id="send" type="submit" class="primary">Send ↑</button></div></div></form><footer><span id="usage">Your session stays on the agent host.</span><span>Enter to send · Shift + Enter for a new line</span></footer></section></main></div><dialog id="extensions"><div class="dialog-heading"><h2>Loaded extensions</h2><button id="close-extensions" aria-label="Close extensions">×</button></div><p>The composition powering this workspace.</p><div id="extension-list"></div></dialog><dialog id="inspector"><h2>Harness inspector</h2><p>Committed state and exact provider-adapter requests. Refresh to capture again.</p><button id="refresh-inspector">Refresh snapshot</button><button id="next-trace">Next trace page</button><button id="download-inspector">Download JSON</button><button id="close-inspector">Close</button><pre id="inspection-meta"></pre><div id="inspection-data"></div></dialog></body></html>`;

export const WEB_STYLE = `
#inspector{width:min(960px,95vw);max-height:90vh;overflow:auto}#inspector pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px monospace}#inspector details{margin:12px 0} :root{color-scheme:dark;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#121515;color:#e6e9e6;--muted:#88928c;--line:#2a302d;--accent:#c5e3b4}*{box-sizing:border-box}body{margin:0}button,input,textarea,select{font:inherit}button{cursor:pointer;background:transparent;color:inherit;border:1px solid var(--line);border-radius:8px;padding:8px 12px;transition:background .15s}button:hover{background:#29312b}button:disabled{opacity:.4;cursor:default}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.primary{background:var(--accent);border-color:var(--accent);color:#1b2918;font-weight:600}.primary:hover{background:#d4edc5}.accent{color:var(--accent)}.eyebrow{font-size:10px;letter-spacing:.16em;color:var(--muted);font-weight:600}#app{height:100dvh;display:grid;grid-template-columns:245px minmax(0,1fr)}[hidden]{display:none!important}aside{background:#171b18;border-right:1px solid var(--line);display:flex;flex-direction:column;padding:26px 16px;min-height:0}.brand{font-size:25px;font-weight:650;letter-spacing:-1px;padding:0 10px 25px;display:flex;align-items:center}.new-session{text-align:left;padding:11px 12px;background:#20271f;border-color:#35422f}.section-label{margin:30px 11px 12px}nav{overflow:auto;flex:1}nav button{display:block;border:0;width:100%;text-align:left;margin:3px 0;padding:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#aab3ac}nav button.selected{background:#2b3428;color:#e4efdc}nav button small{display:block;margin-top:5px;color:var(--muted);font-size:11px}.sidebar-bottom{border-top:1px solid var(--line);padding-top:15px;display:flex;flex-direction:column;gap:8px}.sidebar-bottom button{text-align:left;border:0}.local-label{font-size:9px;letter-spacing:.13em;color:#6a786c;padding:15px 12px 0}main{min-width:0;display:flex;flex-direction:column;min-height:0}header{height:83px;flex-shrink:0;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--line);padding:0 32px}.heading{flex:1;min-width:0}h2{font-size:15px;font-weight:550;margin:0 0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#status{color:var(--muted);font-size:11px}.header-actions{display:flex;align-items:center;gap:8px}.header-actions button{font-size:12px}.connection{color:#a9ca99;font-size:11px;margin-right:12px}.connection.offline{color:#d8ac83}#transcript{flex:1;overflow:auto;padding:30px max(25px,calc((100% - 850px)/2));scroll-behavior:smooth}.empty{margin:15vh auto 0;max-width:600px}.empty h1{font-size:36px;font-weight:450;letter-spacing:-1px;margin:20px 0 12px}.empty p{color:var(--muted);font-size:14px}.message{margin:0 0 26px;max-width:850px;overflow-wrap:anywhere}.message .label{font-size:10px;letter-spacing:.12em;color:var(--muted);margin-bottom:10px}.message.user{background:#20271f;border:1px solid #2e392a;padding:18px 20px;border-radius:12px}.message.user .label{color:#a9c499}.message pre{white-space:pre-wrap;font-family:inherit;line-height:1.7;font-size:14px;margin:0}.message details{border:1px solid var(--line);border-radius:9px;margin:10px 0;background:#191e1b;padding:12px}.message summary{cursor:pointer;font:12px ui-monospace,monospace;color:#aec49f}.message details pre{font:12px/1.6 ui-monospace,monospace;margin-top:12px;color:#a7b3aa;max-height:350px;overflow:auto}.composer-wrap{padding:10px max(25px,calc((100% - 850px)/2)) 18px}#composer{background:#1c211e;border:1px solid #3c4937;border-radius:13px;padding:15px 16px 12px;box-shadow:0 7px 30px #0002}textarea{width:100%;background:transparent;border:0;resize:vertical;color:#e6e9e6;min-height:66px;max-height:250px;font-size:14px;line-height:1.5}textarea:focus{outline:0}textarea::placeholder{color:#778278}.composer-bottom{display:flex;align-items:center;justify-content:space-between;margin-top:10px;gap:8px}select{color:#aab8a7;background:#20271f;border:1px solid var(--line);border-radius:6px;font-size:11px;padding:7px;max-width:58%}.composer-bottom button{font-size:12px;margin-left:6px}footer{display:flex;justify-content:space-between;gap:15px;font-size:10px;color:#6c796e;margin-top:12px}.queue{color:var(--muted);font-size:11px;margin-bottom:8px}#error{background:#442b24;color:#f0beaa;padding:12px 24px;font-size:13px}#approvals{max-height:32vh;overflow:auto;padding:0 max(25px,calc((100% - 850px)/2))}.approval{border:1px solid #6c623b;background:#302e21;padding:15px;border-radius:10px;margin-bottom:12px}.approval h3{margin:0 0 8px;font-size:13px;color:#e7dbaa}.approval p{font-size:12px;color:#cdc6aa}.approval pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;max-height:130px;overflow:auto}.approval button{margin-right:8px}.login{min-height:100dvh;display:grid;place-items:center;padding:25px;background:radial-gradient(ellipse at 50% 20%,#253020 0%,#121515 55%)}.login-card{width:min(100%,380px)}.login-card h1{font-size:48px;letter-spacing:-2px;margin:20px 0 10px}.login-card p{font-size:14px;color:var(--muted);margin-bottom:35px}.login-card label{display:block;font-size:12px;margin-bottom:10px}.login-card input{width:100%;background:#1b221c;color:inherit;border:1px solid #3b4937;border-radius:8px;padding:13px;margin-bottom:14px}.login-card button{width:100%;padding:13px}.login-card small{font-size:11px;color:var(--muted)}#login-error{color:#efaa93;margin:15px 0}.mobile{display:none}dialog{background:#1b211c;color:inherit;border:1px solid #3a4635;border-radius:14px;width:min(540px,calc(100% - 32px));padding:24px}dialog::backdrop{background:#0009}.dialog-heading{display:flex;justify-content:space-between;align-items:center}dialog p{font-size:13px;color:var(--muted)}.extension{border-top:1px solid var(--line);padding:15px 0}.extension strong{font:12px ui-monospace,monospace}.extension p{margin:8px 0 0}.scrim{position:fixed;inset:0;background:#0009;z-index:9;border:0;border-radius:0}
@media(max-width:760px){#app{grid-template-columns:1fr}aside{position:fixed;inset:0 auto 0 0;width:270px;z-index:10;transform:translateX(-100%);transition:transform .2s}.drawer-open aside{transform:translateX(0)}.mobile{display:inline-block}#close-drawer{margin-left:auto}.brand{padding-bottom:20px}header{height:72px;padding:0 15px;gap:10px}.header-actions{gap:5px}.header-actions button{padding:7px;font-size:11px}.connection{font-size:0;margin-right:4px}.connection:before{content:'●';font-size:10px}.heading h2{font-size:13px}#transcript{padding:24px 18px}.empty{margin-top:12vh}.empty h1{font-size:29px}.composer-wrap{padding:10px 12px max(13px,env(safe-area-inset-bottom))}#approvals{padding:0 12px}footer span:last-child{display:none}textarea{font-size:16px}#composer{padding:12px}#message{min-height:65px}.message pre{font-size:14px}.message.user{padding:15px}.header-actions #resume{max-width:65px}.login-card input{font-size:16px}}
`;

export const WEB_SCRIPT = String.raw`
'use strict';
const $ = id => document.getElementById(id);
let selected = null, stream = null, snapshot = null, refreshTimer = null, refreshing = false, refreshAgain = false;
let delta = '', deltaOperation = null, pendingSend = null;
const encode = encodeURIComponent;
function text(tag, value, className) { const el = document.createElement(tag); el.textContent = value; if (className) el.className = className; return el; }
function error(err) { $('error').hidden = false; $('error').textContent = err.message || String(err); }
function clearError() { $('error').hidden = true; }
async function api(path, data) {
  const response = await fetch('/api/' + path, data === undefined ? {} : { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  const result = await response.json();
  if (response.status === 401) { showLogin(); throw new Error(result.error); }
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
function showLogin() { if (stream) stream.close(); stream = null; $('login').hidden = false; $('app').hidden = true; }
function drawer(open) { document.body.classList.toggle('drawer-open', open); $('scrim').hidden = !open; }
async function choose(id) { clearError(); selected = id; delta = ''; deltaOperation = null; drawer(false); await refresh(); }
function message(role, content) { const card = text('article', '', 'message ' + role); card.append(text('div', role === 'user' ? 'YOU' : role === 'tool_result' ? 'TOOL RESULT' : 'AGENT', 'label')); card.append(text('pre', content)); return card; }
function toolDetails(label, value) { const detail = document.createElement('details'); detail.append(text('summary', label)); detail.append(text('pre', typeof value === 'string' ? value : JSON.stringify(value, null, 2))); return detail; }
function reconcileDelta(record) {
  if (deltaOperation && record.operations.some(operation => operation.id === deltaOperation && operation.status !== 'intent')) { delta = ''; deltaOperation = null; }
}
function render(record) {
  reconcileDelta(record);
  snapshot = record; const feed = $('transcript'); const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  feed.replaceChildren(); $('title').textContent = record.title; $('status').textContent = record.status + ' · ' + record.id.slice(0, 8);
  for (const item of record.messages) {
    const card = message(item.role, item.content || '');
    if (item.role === 'tool_result') { card.lastChild.remove(); card.append(toolDetails(item.toolName || 'Tool output', item.content)); }
    for (const call of item.toolCalls || []) card.append(toolDetails(call.name, call.args));
    feed.append(card);
  }
  for (const op of record.operations.filter(op => op.status === 'intent' || op.status === 'unknown' || op.status === 'failed')) {
    const card = text('article', '', 'message'); card.append(toolDetails((op.name || op.kind) + ' · ' + op.status, op.status === 'failed' ? op.output : op.input)); feed.append(card);
  }
  if (delta) { const card = message('assistant', delta); card.id = 'live-delta'; feed.append(card); }
  if (!feed.children.length) { const empty = text('div', '', 'empty'); empty.append(text('span', 'SESSION READY', 'eyebrow'), text('h1', 'Make something happen.'), text('p', 'Your agent is ready for its first task.')); feed.append(empty); }
  $('approvals').replaceChildren();
  for (const request of record.approvals) {
    const card = text('article', '', 'approval'); card.append(text('h3', 'Approval needed · ' + request.name), text('p', request.reason), text('pre', JSON.stringify(request.args, null, 2)));
    for (const allow of [true, false]) { const button = text('button', allow ? 'Allow once' : 'Deny', allow ? 'primary' : ''); button.onclick = async () => { button.disabled = true; try { await api('sessions/' + encode(record.id) + '/approve', {approvalId: request.id, allow}); await refresh(); } catch(e) {error(e); button.disabled = false;} }; card.append(button); }
    $('approvals').append(card);
  }
  $('queue').textContent = record.queue.length ? record.queue.length + ' queued message' + (record.queue.length === 1 ? '' : 's') : '';
  $('usage').textContent = (record.usage.inputTokens || 0).toLocaleString() + ' input · ' + (record.usage.outputTokens || 0).toLocaleString() + ' output tokens';
  $('cancel').disabled = !['running','waiting'].includes(record.status); $('resume').disabled = ['running','waiting'].includes(record.status);
  if (record.error) error(new Error(record.error));
  if (nearBottom) feed.scrollTop = feed.scrollHeight;
}
async function refresh() {
  if (refreshing) { refreshAgain = true; return; } refreshing = true;
  try {
    const records = await api('sessions'); $('sessions').replaceChildren();
    for (const record of records) { const button = text('button', record.title, record.id === selected ? 'selected' : ''); button.append(text('small', record.status)); button.onclick = () => choose(record.id).catch(error); $('sessions').append(button); }
    if (!selected && records.length) selected = records[0].id;
    if (selected) { const id = selected; const record = await api('sessions/' + encode(id)); if (id === selected) render(record); }
    $('fork').disabled = !selected; $('resume').disabled = !selected || ['running','waiting'].includes(snapshot?.status); $('cancel').disabled = !selected || !['running','waiting'].includes(snapshot?.status);
  } finally { refreshing = false; if (refreshAgain) { refreshAgain = false; schedule(); } }
}
function schedule() { if (!refreshTimer) refreshTimer = setTimeout(() => {refreshTimer = null; refresh().catch(error);}, 80); }
function connect() {
  if (stream) stream.close(); stream = new EventSource('/api/stream');
  stream.addEventListener('ready', () => { $('connection').textContent = 'Connected'; $('connection').classList.remove('offline'); delta = ''; deltaOperation = null; refresh().catch(error); });
  stream.onmessage = event => {
    const update = JSON.parse(event.data);
    if (update.type === 'delta' && update.sessionId === selected) {
      if (deltaOperation !== update.operationId) {delta = ''; deltaOperation = update.operationId;}
      delta = (delta + (update.text || '')).slice(-200000);
      let card = $('live-delta'); if (!card) {card = message('assistant', ''); card.id = 'live-delta'; $('transcript').append(card);}
      card.lastChild.textContent = delta;
      const feed = $('transcript'); if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 200) feed.scrollTop = feed.scrollHeight;
    } else { schedule(); }
  };
  stream.onerror = () => { $('connection').textContent = 'Reconnecting'; $('connection').classList.add('offline'); api('sessions').catch(err => { if (!$('app').hidden) error(err); }); };
}
async function enter() { $('login').hidden = true; $('app').hidden = false; await refresh(); connect(); }
$('login-form').onsubmit = async event => {event.preventDefault(); $('login-error').textContent = ''; try { await api('login',{token:$('token').value}); $('token').value = ''; await enter(); } catch(e) {$('login-error').textContent = e.message;} };
$('menu').onclick = () => drawer(true); $('close-drawer').onclick = $('scrim').onclick = () => drawer(false);
$('new').onclick = async () => {clearError(); try {const record = await api('sessions',{}); await choose(record.id); $('message').focus();} catch(e){error(e);} };
$('fork').onclick = async () => {if (!selected) return; clearError(); try {const record = await api('sessions/' + encode(selected) + '/fork',{}); await choose(record.id);} catch(e){error(e);} };
for (const action of ['cancel','resume']) $(action).onclick = async () => {if (!selected) return; clearError(); try {await api('sessions/' + encode(selected) + '/' + action,{}); await refresh();} catch(e){error(e);} };
$('composer').onsubmit = async event => {
  event.preventDefault(); const content = $('message').value; if (!content.trim()) return; clearError(); $('send').disabled = true;
  try {if (!selected) {const record = await api('sessions',{}); selected = record.id;}
    const sessionId = selected, mode = $('mode').value;
    if (!pendingSend || pendingSend.sessionId !== sessionId || pendingSend.content !== content || pendingSend.mode !== mode) {
      const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); const commandId = Array.from(bytes, n => n.toString(16).padStart(2,'0')).join('');
      pendingSend = { sessionId, content, mode, commandId };
    }
    const command = pendingSend;
    await api('sessions/' + encode(sessionId) + '/submit',{content,commandId:command.commandId,mode});
    if (pendingSend === command) pendingSend = null;
    if (selected === sessionId && $('message').value === content) $('message').value = ''; await refresh();
  } catch(e){error(e);} finally {$('send').disabled = false;}
};
$('message').onkeydown = event => {if(event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) {event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit();}};
$('composition').onclick = async () => {try {const extensions = await api('composition'); $('extension-list').replaceChildren(); for(const extension of extensions){const row = text('div','','extension'); row.append(text('strong',extension.id + ' @ ' + extension.version),text('p',extension.roles.join(', ') || 'UI / lifecycle')); $('extension-list').append(row);} $('extensions').showModal(); drawer(false);} catch(e){error(e);} };
let inspection = null, inspectedSession = null;
async function inspectSession(after = 0) {
  if (!inspectedSession) return;
  inspection = await api('sessions/' + inspectedSession + '/inspect?after=' + after);
  $('inspection-meta').textContent = 'Captured ' + new Date(inspection.capturedAt).toLocaleString() + ' · revision ' + inspection.revision;
  const panel = $('inspection-data'); panel.replaceChildren();
  function detail(label, value) { const row = text('details', ''); row.append(text('summary', label), text('pre', JSON.stringify(value, null, 2))); panel.append(row); }
  detail('Session state, queues, approvals and budgets', inspection.state);
  for (const op of inspection.state.operations) {
    detail(op.kind + ' · ' + op.status + ' · ' + op.id, op);
    if (op.requestRef) {
      const button = text('button', 'Load exact request · ' + op.id);
      const sessionId = inspectedSession, captured = inspection;
      button.onclick = async () => {
        button.disabled = true;
        try {
          const saved = await api('sessions/' + encode(sessionId) + '/operations/' + encode(op.id));
          if (inspection !== captured || inspectedSession !== sessionId) return;
          (inspection.loadedOperations ??= []).push(saved);
          detail('Exact recorded request · ' + op.id, saved);
        } catch (e) { button.disabled = false; error(e); }
      };
      panel.append(button);
    }
  }
  for (const event of inspection.events) detail('#' + event.sequence + ' · ' + event.type, event);
  $('next-trace').disabled = inspection.nextSequence >= inspection.revision || inspection.events.length === 0;
}
$('inspect').onclick = async () => { try { inspectedSession = selected; if (!inspectedSession) return; await inspectSession(); $('inspector').showModal(); drawer(false); } catch(e) { error(e); } };
$('refresh-inspector').onclick = () => inspectSession().catch(error);
$('next-trace').onclick = () => inspectSession(inspection.nextSequence).catch(error);
$('close-inspector').onclick = () => $('inspector').close();
$('download-inspector').onclick = () => { if (!inspection) return; const url = URL.createObjectURL(new Blob([JSON.stringify(inspection, null, 2)], {type:'application/json'})); const link = document.createElement('a'); link.href = url; link.download = 'agentic-inspection.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
$('close-extensions').onclick = () => $('extensions').close();
$('logout').onclick = async () => {try {await api('logout',{}); selected = null; snapshot = null; pendingSend = null; $('transcript').replaceChildren(); $('sessions').replaceChildren(); $('message').value = ''; showLogin();} catch(e){error(e);} };
api('sessions').then(enter).catch(() => showLogin());
`;
