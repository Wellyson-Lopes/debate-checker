// Documento offscreen: segura o áudio da aba e a conexão com o servidor enquanto o painel abre e fecha.
let session = null;
const history = [];
const MAX_HISTORY = 2000;

function emit(event, persist = true) {
  if (persist) {
    history.push(event);
    if (history.length > MAX_HISTORY) history.shift();
  }
  chrome.runtime.sendMessage({ target: 'panel', type: 'event', event }).catch(() => {});
}

function buildUrl({ serverUrl, token }) {
  const url = new URL(serverUrl);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

async function start({ streamId, audio, settings }) {
  if (session) await stop({ notify: false });
  history.length = 0;
  emit({ type: 'session', state: 'starting', audio });

  let ws;
  try {
    ws = new WebSocket(buildUrl(settings));
  } catch {
    emit({ type: 'status', level: 'error', message: `Endereço do servidor inválido: ${settings.serverUrl}` });
    return stop();
  }
  ws.binaryType = 'arraybuffer';
  const current = { ws, stream: null, ctx: null, closedByUser: false };
  session = current;

  ws.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      emit(msg, msg.type !== 'interim');
    } catch { /* ignora */ }
  });
  ws.addEventListener('close', (e) => {
    if (session !== current) return;
    if (!current.closedByUser) {
      emit({ type: 'status', level: 'error', message: `Conexão com o servidor encerrada (código ${e.code}). Clique em Iniciar para recomeçar.` });
    }
    stop();
  });

  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`Não consegui conectar em ${settings.serverUrl}. O servidor está rodando (npm start)? Se usa token, ele confere?`)), { once: true });
    });
    ws.send(JSON.stringify({
      type: 'config',
      audio,
      language: settings.language,
      names: { A: settings.nameA, B: settings.nameB },
      context: settings.context,
    }));
    if (!audio) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
    current.stream = stream;
    const ctx = new AudioContext();
    current.ctx = ctx;
    await ctx.audioWorklet.addModule('audio-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm16-downsampler', { channelCount: 1, channelCountMode: 'explicit' });
    node.port.onmessage = (e) => {
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1_000_000) ws.send(e.data);
    };
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(ctx.destination); // a captura silencia a aba; isto devolve o som para você
    source.connect(node);
    node.connect(silent);
    silent.connect(ctx.destination);
  } catch (err) {
    emit({ type: 'status', level: 'error', message: String(err?.message || err) });
    await stop();
  }
}

async function stop({ notify = true } = {}) {
  const s = session;
  if (!s) return;
  session = null;
  s.closedByUser = true;
  try {
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: 'stop' }));
    s.ws.close();
  } catch { /* ignora */ }
  s.stream?.getTracks().forEach((t) => t.stop());
  try { await s.ctx?.close(); } catch { /* ignora */ }
  emit({ type: 'session', state: 'ended' });
  if (notify) chrome.runtime.sendMessage({ target: 'background', type: 'stopped' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'start') start(msg);
  else if (msg.type === 'stop') stop();
  else if (msg.type === 'send') {
    if (session?.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(msg.payload));
  } else if (msg.type === 'panel-ready') {
    chrome.runtime.sendMessage({ target: 'panel', type: 'batch', events: history }).catch(() => {});
  }
});

chrome.runtime.sendMessage({ target: 'background', type: 'offscreen-ready' }).catch(() => {});
