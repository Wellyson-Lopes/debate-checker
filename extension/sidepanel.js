'use strict';

const $ = (sel) => document.querySelector(sel);
const make = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const DEFAULTS = {
  serverUrl: 'ws://127.0.0.1:8787/ws',
  token: '',
  language: 'pt-BR',
  nameA: 'Lula',
  nameB: 'Flávio Bolsonaro',
  context: 'Debate presidencial entre Lula e Flávio Bolsonaro',
};

const VERDICTS = {
  verdadeiro: { label: 'Verdadeiro', cls: 'ok', seg: 'seg-ok', icon: '✓' },
  parcialmente_verdadeiro: { label: 'Parcialmente verdadeiro', cls: 'part', seg: 'seg-part', icon: '◐' },
  enganoso: { label: 'Enganoso', cls: 'mis', seg: 'seg-mis', icon: '!' },
  falso: { label: 'Falso', cls: 'bad', seg: 'seg-bad', icon: '✕' },
  nao_verificavel: { label: 'Não verificável', cls: 'unk', seg: 'seg-unk', icon: '?' },
  erro: { label: 'Erro na checagem', cls: 'unk', seg: 'seg-unk', icon: '!' },
};
const SHORT = { verdadeiro: 'verdadeiro', parcialmente_verdadeiro: 'parcial', enganoso: 'enganoso', falso: 'falso', nao_verificavel: 'não verificável', erro: 'erro' };

const state = {
  roles: {},
  names: { A: '', B: '' },
  utts: new Map(),
  claims: new Map(),
  speakers: new Set(),
  snippets: new Map(),
  running: false,
};

const feed = $('#feed');

// ---------- utilidades ----------
const nameOf = (role) => (role === 'A' ? state.names.A || 'Candidato A' : role === 'B' ? state.names.B || 'Candidato B' : role === 'OTHER' ? 'Mediação / outros' : null);
const speakerLabel = (sp) => nameOf(state.roles[sp]) || `Voz ${sp}`;
const markClass = (role) => (role === 'A' ? 'A' : role === 'B' ? 'B' : role === 'OTHER' ? 'O' : 'U');
const sendToServer = (payload) => chrome.runtime.sendMessage({ target: 'offscreen', type: 'send', payload }).catch(() => {});

function setStatus(text, level = '') {
  const el = $('#statusLine');
  el.textContent = text;
  el.className = `status ${level}`.trim();
  $('#dot').className = `dot ${level === 'error' ? 'err' : state.running ? 'live' : 'idle'}`;
}

function setRunning(on) {
  state.running = on;
  $('#btnStart').hidden = on;
  $('#btnStop').hidden = !on;
  $('#dot').className = `dot ${on ? 'live' : 'idle'}`;
}

function resetFeed() {
  state.roles = {};
  state.utts.clear();
  state.claims.clear();
  state.speakers.clear();
  state.snippets.clear();
  feed.replaceChildren();
  $('#interim').hidden = true;
  renderSpeakers();
  renderBoard();
}

// ---------- renderização ----------
function paintUtt(u) {
  const role = state.roles[u.ev.speaker];
  u.mark.className = `mark ${markClass(role)}`;
  u.who.textContent = speakerLabel(u.ev.speaker);
  if (u.btns) {
    u.btns.btnA.setAttribute('aria-pressed', String(role === 'A'));
    u.btns.btnB.setAttribute('aria-pressed', String(role === 'B'));
    u.btns.btnO.setAttribute('aria-pressed', String(role === 'OTHER'));
  }
}

function repaintAll() {
  for (const u of state.utts.values()) paintUtt(u);
  $('#candA .cname').textContent = state.names.A || 'Candidato A';
  $('#candB .cname').textContent = state.names.B || 'Candidato B';
  const qA = $('#quickNameA');
  const qB = $('#quickNameB');
  if (qA && document.activeElement !== qA) qA.value = state.names.A || '';
  if (qB && document.activeElement !== qB) qB.value = state.names.B || '';
  renderSpeakers();
  renderBoard();
}

function addUtterance(ev) {
  if (state.utts.has(ev.id)) return;
  state.speakers.add(ev.speaker);
  state.snippets.set(ev.speaker, ev.text);
  const root = make('article', 'utt');
  const head = make('div', 'uhead');
  const left = make('div', 'uhead-left');
  const mark = make('span', 'mark');
  const who = make('span', 'who');
  left.append(mark, who);

  const switcher = make('div', 'u-switcher');
  const btnA = make('button', 'btn-mini', 'A');
  btnA.type = 'button';
  btnA.title = 'Voz ' + ev.speaker + ' -> ' + (state.names.A || 'Candidato A');
  btnA.addEventListener('click', (e) => { e.stopPropagation(); setRole(ev.speaker, 'A'); });

  const btnB = make('button', 'btn-mini', 'B');
  btnB.type = 'button';
  btnB.title = 'Voz ' + ev.speaker + ' -> ' + (state.names.B || 'Candidato B');
  btnB.addEventListener('click', (e) => { e.stopPropagation(); setRole(ev.speaker, 'B'); });

  const btnO = make('button', 'btn-mini', 'Med');
  btnO.type = 'button';
  btnO.title = 'Voz ' + ev.speaker + ' -> Mediação / Outros';
  btnO.addEventListener('click', (e) => { e.stopPropagation(); setRole(ev.speaker, 'OTHER'); });

  const btnCopyUtt = make('button', 'btn-mini', 'Copiar');
  btnCopyUtt.type = 'button';
  btnCopyUtt.title = 'Copiar fala';
  btnCopyUtt.addEventListener('click', async (e) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(ev.text);
    btnCopyUtt.textContent = '✓';
    setTimeout(() => (btnCopyUtt.textContent = 'Copiar'), 2000);
  });

  switcher.append(btnA, btnB, btnO, btnCopyUtt);
  head.append(left, switcher);

  const text = make('p', 'utext', ev.text);
  const orig = make('p', 'orig');
  orig.hidden = true;
  const claims = make('div', 'claims');
  root.append(head, text, orig, claims);
  feed.prepend(root);
  const u = { ev, root, mark, who, text, orig, claims, btns: { btnA, btnB, btnO } };
  state.utts.set(ev.id, u);
  paintUtt(u);
  renderSpeakers();
}

function addTranslation(ev) {
  const u = state.utts.get(ev.utteranceId);
  if (!u) return;
  u.orig.textContent = `Original: ${u.ev.text}`;
  u.orig.hidden = false;
  u.text.textContent = ev.text;
}

function addClaim(ev) {
  const u = state.utts.get(ev.utteranceId);
  if (!u || state.claims.has(ev.id)) return;
  const card = make('div', 'claim');
  const text = make('p', 'ctext', ev.text);

  const vrow = make('div', 'vrow');
  const vleft = make('div', 'vrow-status');
  const badge = make('span', 'badge wait', 'Na fila…');
  const meta = make('span', 'meta');
  vleft.append(badge, meta);

  const tools = make('div', 'claim-tools');
  const btnCopy = make('button', 'btn-tool', 'Copiar');
  btnCopy.type = 'button';
  btnCopy.title = 'Copiar texto da afirmação';
  btnCopy.addEventListener('click', async (e) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(ev.text);
    btnCopy.textContent = 'Copiado! ✓';
    setTimeout(() => (btnCopy.textContent = 'Copiar'), 2000);
  });

  const linkSearch = make('a', 'btn-tool link-search', '🔍 Google');
  linkSearch.href = `https://www.google.com/search?q=${encodeURIComponent(ev.text)}`;
  linkSearch.target = '_blank';
  linkSearch.rel = 'noopener noreferrer';
  linkSearch.title = 'Pesquisar esta afirmação no Google';

  tools.append(btnCopy, linkSearch);
  vrow.append(vleft, tools);

  const sum = make('p', 'csum');
  const srcs = make('ul', 'src');
  card.append(text, vrow, sum, srcs);
  u.claims.append(card);
  u.root.classList.add('has-claims');
  state.claims.set(ev.id, { ev, card, badge, meta, sum, srcs, verdict: null, data: null });
  renderBoard();
}

function markChecking(id) {
  const c = state.claims.get(id);
  if (c && !c.verdict) c.badge.textContent = 'Verificando…';
}

function setVerdict(ev) {
  const c = state.claims.get(ev.claimId);
  if (!c) return;
  const v = VERDICTS[ev.verdict] || VERDICTS.erro;
  c.verdict = VERDICTS[ev.verdict] ? ev.verdict : 'erro';
  c.data = ev;
  c.badge.className = `badge ${v.cls}`;
  c.badge.textContent = `${v.icon} ${v.label}`;
  c.meta.textContent = ev.cached ? 'já checada antes' : ev.ms ? `checada em ${Math.round(ev.ms / 1000)} s` : '';
  c.sum.textContent = ev.resumo || '';
  c.srcs.replaceChildren();
  for (const f of ev.fontes || []) {
    let url;
    try { url = new URL(f.url); } catch { continue; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    const li = make('li');
    const a = make('a', null, f.titulo || url.hostname);
    a.href = url.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    li.append(a);
    c.srcs.append(li);
  }
  renderBoard();
}

function renderBoard() {
  for (const role of ['A', 'B']) {
    const box = $(role === 'A' ? '#candA' : '#candB');
    const counts = {};
    let waiting = 0;
    for (const c of state.claims.values()) {
      if (state.roles[c.ev.speaker] !== role) continue;
      if (!c.verdict) waiting++;
      else counts[c.verdict] = (counts[c.verdict] || 0) + 1;
    }
    const bar = box.querySelector('.bar');
    const chips = box.querySelector('.chips');
    bar.replaceChildren();
    chips.replaceChildren();
    for (const [key, n] of Object.entries(counts)) {
      const seg = make('span', VERDICTS[key].seg);
      seg.style.flex = String(n);
      seg.title = `${n} ${SHORT[key]}`;
      bar.append(seg);
      const chip = make('span', 'chip');
      chip.append(make('b', null, String(n)), document.createTextNode(` ${SHORT[key]}`));
      chips.append(chip);
    }
    if (waiting) chips.append(make('span', 'chip', `${waiting} em checagem`));
    if (!bar.children.length && !waiting) chips.append(make('span', 'chip', 'Sem checagens ainda'));
  }
}

function setRole(sp, role) {
  state.roles[sp] = role;
  sendToServer({ type: 'map', speaker: Number(sp), role });
  repaintAll();
}

function swapAB() {
  const spA = Object.keys(state.roles).find((k) => state.roles[k] === 'A');
  const spB = Object.keys(state.roles).find((k) => state.roles[k] === 'B');
  if (spA === undefined && spB === undefined) return;
  if (spA !== undefined) {
    state.roles[spA] = 'B';
    sendToServer({ type: 'map', speaker: Number(spA), role: 'B' });
  }
  if (spB !== undefined) {
    state.roles[spB] = 'A';
    sendToServer({ type: 'map', speaker: Number(spB), role: 'A' });
  }
  repaintAll();
}

function renderSpeakers() {
  const box = $('#speakers');
  box.replaceChildren();
  if (!state.speakers.size) { box.hidden = true; return; }
  box.hidden = false;
  box.append(make('h2', null, 'Quem é quem (Vozes detectadas)'));
  box.append(make('p', 'hint', 'A transcrição separa as vozes. Toque para associar ao candidato (ou a IA detecta sozinha conforme eles falam).'));
  for (const sp of [...state.speakers].sort((a, b) => a - b)) {
    const row = make('div', 'spk');
    const info = make('div', 'spk-info');
    info.append(make('span', 'lbl', `Voz ${sp}`));
    const snip = state.snippets.get(sp);
    if (snip) {
      const snipEl = make('span', 'spk-snippet', `"${snip.slice(0, 65)}${snip.length > 65 ? '…' : ''}"`);
      snipEl.title = snip;
      info.append(snipEl);
    }
    row.append(info);

    const btns = make('div', 'spk-btns');
    for (const [role, label] of [['A', nameOf('A')], ['B', nameOf('B')], ['OTHER', 'Mediação']]) {
      const b = make('button', null, label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.roles[sp] === role));
      b.addEventListener('click', () => setRole(sp, role));
      btns.append(b);
    }
    row.append(btns);
    box.append(row);
  }
  const hasA = Object.values(state.roles).includes('A');
  const hasB = Object.values(state.roles).includes('B');
  if (hasA || hasB) {
    const sw = make('button', 'btn', 'Trocar A ⇄ B');
    sw.type = 'button';
    sw.addEventListener('click', swapAB);
    box.append(sw);
  }
}

// ---------- eventos vindos do servidor ----------
function handle(ev) {
  switch (ev.type) {
    case 'session':
      if (ev.state === 'starting') { resetFeed(); setRunning(true); setStatus(ev.audio ? 'Conectando ao servidor…' : 'Conectando (modo teste)…'); }
      else if (ev.state === 'ended') { setRunning(false); $('#interim').hidden = true; if (!$('#statusLine').classList.contains('error')) setStatus('Parado.'); }
      break;
    case 'status':
      if (ev.state === 'ready') {
        if (!ev.hermes) setStatus('Servidor sem HERMES_API_KEY: as afirmações não serão checadas.', 'warn');
        else if (!ev.llm) setStatus('Servidor sem LLM_API_KEY: não consigo extrair afirmações.', 'warn');
        else setStatus(ev.audio ? 'Ouvindo a aba…' : 'Modo teste: envie falas de texto abaixo (Configurações e teste).');
      } else setStatus(ev.message || '', ev.level === 'error' ? 'error' : 'warn');
      break;
    case 'interim': {
      const box = $('#interim');
      if (!ev.text) { box.hidden = true; break; }
      box.hidden = false;
      box.textContent = `${speakerLabel(ev.speaker)}: ${ev.text}`;
      break;
    }
    case 'utterance': addUtterance(ev); break;
    case 'translation': addTranslation(ev); break;
    case 'claim': addClaim(ev); break;
    case 'claim-status': markChecking(ev.claimId); break;
    case 'verdict': setVerdict(ev); break;
    case 'speakers':
      state.roles = { ...ev.roles };
      if (ev.names) state.names = { A: ev.names.A || '', B: ev.names.B || '' };
      repaintAll();
      break;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'panel') return;
  if (msg.type === 'event') handle(msg.event);
  else if (msg.type === 'batch') for (const ev of msg.events) handle(ev);
});

// ---------- exportação ----------
function exportMarkdown() {
  const lines = ['# Relatório do debate', '', `Gerado em ${new Date().toLocaleString('pt-BR')}.`, '',
    '> Checagens automáticas feitas por IA. Podem conter erros: confira sempre as fontes.', ''];
  const utts = [...state.utts.values()].sort((a, b) => a.ev.id - b.ev.id);
  for (const u of utts) {
    const mine = [...state.claims.values()].filter((c) => c.ev.utteranceId === u.ev.id);
    if (!mine.length) continue;
    lines.push(`## ${speakerLabel(u.ev.speaker)}`, '', `> ${u.ev.text.replace(/\n/g, ' ')}`, '');
    for (const c of mine) {
      const v = VERDICTS[c.verdict] || { label: 'Sem veredito' };
      lines.push(`- **${v.label}**: ${c.ev.text}`);
      if (c.data?.resumo) lines.push(`  - ${c.data.resumo}`);
      for (const f of c.data?.fontes || []) lines.push(`  - Fonte: [${f.titulo || f.url}](${f.url})`);
    }
    lines.push('');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = make('a');
  a.href = URL.createObjectURL(blob);
  a.download = `debate-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- configurações ----------
const FIELDS = ['serverUrl', 'token', 'language', 'nameA', 'nameB', 'context'];

async function loadSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  for (const k of FIELDS) $(`#${k}`).value = s[k];
  state.names = { A: s.nameA || '', B: s.nameB || '' };
  const qA = $('#quickNameA');
  const qB = $('#quickNameB');
  if (qA) qA.value = state.names.A;
  if (qB) qB.value = state.names.B;
  repaintAll();
}

async function updateQuickNames() {
  const qA = $('#quickNameA');
  const qB = $('#quickNameB');
  const valA = qA ? qA.value.trim() : state.names.A;
  const valB = qB ? qB.value.trim() : state.names.B;
  $('#nameA').value = valA;
  $('#nameB').value = valB;
  state.names = { A: valA, B: valB };
  await chrome.storage.local.set({ nameA: valA, nameB: valB });
  sendToServer({ type: 'names', A: valA, B: valB });
  repaintAll();
}

async function saveSettings() {
  const s = {};
  for (const k of FIELDS) s[k] = $(`#${k}`).value.trim();
  if (!s.serverUrl) s.serverUrl = DEFAULTS.serverUrl;
  await chrome.storage.local.set(s);
  state.names = { A: s.nameA, B: s.nameB };
  const qA = $('#quickNameA');
  const qB = $('#quickNameB');
  if (qA) qA.value = state.names.A;
  if (qB) qB.value = state.names.B;
  sendToServer({ type: 'names', A: s.nameA, B: s.nameB });
  repaintAll();
  $('#saved').textContent = 'Salvo.';
  setTimeout(() => ($('#saved').textContent = ''), 2500);
}

$('#quickNameA')?.addEventListener('input', updateQuickNames);
$('#quickNameB')?.addEventListener('input', updateQuickNames);
$('#save').addEventListener('click', saveSettings);
$('#btnStart').addEventListener('click', () => chrome.runtime.sendMessage({ target: 'background', type: 'start-here' }).catch(() => {}));
$('#btnStop').addEventListener('click', () => chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {}));
$('#btnExport').addEventListener('click', exportMarkdown);
$('#onlyClaims').addEventListener('change', (e) => feed.classList.toggle('only-claims', e.target.checked));
$('#testStart').addEventListener('click', () => chrome.runtime.sendMessage({ target: 'background', type: 'start-test' }).catch(() => {}));
$('#testSend').addEventListener('click', () => {
  const text = $('#testText').value.trim();
  if (!text) return;
  sendToServer({ type: 'inject', speaker: Number($('#testSpeaker').value) || 0, text });
});

(async () => {
  await loadSettings();
  const { lastError } = await chrome.storage.session.get('lastError');
  if (lastError) setStatus(lastError, 'error');
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'panel-ready' }).catch(() => {});
})();
