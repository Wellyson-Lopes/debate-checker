// Service worker: abre o painel, pega o áudio da aba (tabCapture) e entrega ao documento offscreen.
const DEFAULTS = {
  serverUrl: 'ws://127.0.0.1:8787/ws',
  token: '',
  language: 'pt-BR',
  nameA: 'Lula',
  nameB: 'Flávio Bolsonaro',
  context: 'Debate presidencial entre Lula e Flávio Bolsonaro',
};

let resolveReady = null;

async function hasOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  const ready = new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    resolveReady = () => { clearTimeout(timer); resolve(); };
  });
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Captura o áudio da aba do debate e envia para transcrição.',
  });
  await ready;
}

async function setBadge(on) {
  await chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  if (on) await chrome.action.setBadgeBackgroundColor({ color: '#4338CA' });
}

async function startCapture(tabId, { audio = true } = {}) {
  await chrome.storage.session.remove('lastError');
  const settings = await chrome.storage.local.get(DEFAULTS);
  // O streamId precisa ser pedido logo após o clique do usuário e usado em poucos segundos.
  const streamId = audio ? await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }) : null;
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId, audio, tabId, settings }).catch(() => {});
  await setBadge(true);
}

async function reportError(err) {
  const message = String(err?.message || err);
  const friendly = /Cannot capture|chrome:\/\/|extension|activeTab|invoked/i.test(message)
    ? `${message}. Abra a página do debate (não pode ser uma página interna do Chrome) e clique no ícone da extensão.`
    : message;
  await chrome.storage.session.set({ lastError: friendly });
  chrome.runtime.sendMessage({ target: 'panel', type: 'event', event: { type: 'status', level: 'error', message: friendly } }).catch(() => {});
}

// Clique no ícone: abre o painel e já começa a ouvir a aba (o clique é o que autoriza a captura).
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  startCapture(tab.id).catch(reportError);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'background') return;
  (async () => {
    if (msg.type === 'offscreen-ready') resolveReady?.();
    else if (msg.type === 'stopped') {
      await setBadge(false);
      if (await hasOffscreen()) await chrome.offscreen.closeDocument();
    } else if (msg.type === 'start-here' || msg.type === 'start-test') {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab && msg.type === 'start-here') throw new Error('Não encontrei a aba ativa');
      await startCapture(tab?.id ?? 0, { audio: msg.type === 'start-here' });
    }
  })().catch(reportError);
});
