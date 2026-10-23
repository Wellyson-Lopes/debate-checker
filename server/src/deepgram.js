import WebSocket from 'ws';

/** Conexão de streaming com o Deepgram (áudio PCM 16 kHz mono, com separação de vozes). */
export function openDeepgram({ apiKey, model, language, handlers }) {
  const params = new URLSearchParams({
    model,
    language,
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    diarize: 'true',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    endpointing: '700',
    utterance_end_ms: '1500',
  });
  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
    headers: { Authorization: `Token ${apiKey}` },
  });
  const queue = [];
  let open = false;
  let errored = false;
  let lastAudio = Date.now();

  const fail = (err) => {
    if (errored) return;
    errored = true;
    handlers.onError?.(err);
  };

  const keepAlive = setInterval(() => {
    if (open && Date.now() - lastAudio > 4000) ws.send(JSON.stringify({ type: 'KeepAlive' }));
  }, 4000);

  ws.on('open', () => {
    open = true;
    for (const chunk of queue.splice(0)) ws.send(chunk);
    handlers.onOpen?.();
  });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'Results') handlers.onResults?.(msg);
    else if (msg.type === 'UtteranceEnd') handlers.onUtteranceEnd?.(msg);
    else if (msg.type === 'Error') fail(new Error(msg.description || msg.message || 'erro desconhecido'));
  });
  ws.on('unexpected-response', (_req, res) => {
    res.resume();
    const hint = res.statusCode === 401 || res.statusCode === 403 ? ' (confira DEEPGRAM_API_KEY)' : '';
    fail(new Error(`HTTP ${res.statusCode}${hint}`));
    ws.terminate();
  });
  ws.on('error', (err) => fail(err));
  ws.on('close', (code, reason) => {
    clearInterval(keepAlive);
    handlers.onClose?.(code, reason?.toString() ?? '');
  });

  return {
    sendAudio(buf) {
      lastAudio = Date.now();
      if (open) ws.send(buf);
      else if (queue.length < 200) queue.push(buf);
    },
    close() {
      clearInterval(keepAlive);
      try {
        if (open) ws.send(JSON.stringify({ type: 'CloseStream' }));
        ws.close();
      } catch { /* ignora */ }
    },
  };
}
