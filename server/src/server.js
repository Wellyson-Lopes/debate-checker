import http from 'node:http';
import { WebSocketServer } from 'ws';
import { openDeepgram } from './deepgram.js';
import { TurnAssembler } from './transcript.js';
import { PriorityQueue } from './queue.js';
import { extractClaims } from './claims.js';
import { verifyWithHermes } from './verify.js';

const clip = (v, n = 120) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const wordCount = (t) => t.split(/\s+/).filter(Boolean).length;
const normalize = (t) =>
  t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9% ]+/g, ' ').replace(/\s+/g, ' ').trim();

const STOP_WORDS = new Set(['o', 'a', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'por', 'para', 'com', 'que', 'se', 'e', 'ou', 'mas', 'como', 'ao', 'aos', 'seu', 'sua', 'seus', 'suas', 'meu', 'minha', 'ele', 'ela', 'eles', 'elas']);
function extractKeywords(text) {
  return new Set(normalize(text).split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w)));
}
function keywordSimilarity(wordsA, wordsB) {
  if (!wordsA.size || !wordsB.size) return 0;
  let inter = 0;
  for (const w of wordsA) if (wordsB.has(w)) inter++;
  const union = wordsA.size + wordsB.size - inter;
  return union > 0 ? inter / union : 0;
}

export function createApp(cfg) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== '/ws') return reject(404, 'Not Found');
    // Impede que sites quaisquer usem suas chaves via localhost: só a extensão (ou clientes sem Origin) entra.
    const origin = req.headers.origin;
    if (origin && !origin.startsWith('chrome-extension://')) return reject(403, 'Forbidden');
    if (cfg.serverToken && url.searchParams.get('token') !== cfg.serverToken) return reject(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => handleSession(ws, cfg));
  });

  return {
    server,
    listen: () => new Promise((resolve) => server.listen(cfg.port, cfg.host, () => resolve(server.address()))),
    close: () =>
      new Promise((resolve) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => resolve());
      }),
  };
}

function handleSession(ws, cfg) {
  const s = {
    started: false,
    closed: false,
    language: 'pt-BR',
    names: { A: 'Lula', B: 'Flávio Bolsonaro' },
    context: 'Debate presidencial entre Lula e Flávio Bolsonaro',
    roles: new Map(), // índice da voz -> 'A' | 'B' | 'OTHER'
    speakersSeen: new Set(),
    expectedNextSpeaker: null,
    lastSpeaker: null,
    recent: [],
    cache: [],
    inFlight: [],
    uttSeq: 0,
    claimSeq: 0,
    dg: null,
    warned: new Set(),
  };
  const send = (obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  };
  const warnOnce = (msg) => {
    if (s.warned.has(msg)) return;
    s.warned.add(msg);
    send({ type: 'status', level: 'warn', message: msg });
  };
  const queue = new PriorityQueue({ concurrency: cfg.hermes.concurrency, maxSize: cfg.hermes.maxQueue });
  const assembler = new TurnAssembler((turn) => void handleUtterance(turn));

  const roleName = (r) => (r === 'A' ? s.names.A || 'Candidato A' : r === 'B' ? s.names.B || 'Candidato B' : null);
  const speakerName = (sp) => {
    const r = s.roles.get(sp);
    return r === 'OTHER' ? 'Mediação/outros' : roleName(r);
  };
  const pushSpeakers = () => send({ type: 'speakers', roles: Object.fromEntries(s.roles), names: s.names });

  async function handleUtterance({ speaker, text }) {
    if (s.closed) return;
    s.speakersSeen.add(speaker);
    const id = ++s.uttSeq;
    send({ type: 'utterance', id, speaker, text });

    const norm = normalize(text);

    // 1. Passagem de palavra determinística (quando a fala anterior disse quem falaria a seguir):
    // Se a fala anterior disse "Candidato Lula...", quem começa a falar AGORA é Lula (A).
    if (s.expectedNextSpeaker && s.lastSpeaker !== speaker) {
      s.roles.set(speaker, s.expectedNextSpeaker);
      s.expectedNextSpeaker = null;
      pushSpeakers();
    }

    // Se quem está falando agora passa a palavra para alguém (ex: mediador ou oponente fazendo pergunta):
    if (/candidato lula|presidente lula|vez (do|de) lula|pergunta (do|de) lula|palavra (com|ao|do) lula|lula comeca|com a palavra lula|lula tem a palavra|lula seu tempo/i.test(norm)) {
      s.expectedNextSpeaker = 'A';
    } else if (/candidato flavio|senador flavio|flavio bolsonaro|vez (do|de) flavio|pergunta (do|de) flavio|palavra (com|ao|do) flavio|flavio comeca|com a palavra flavio|flavio tem a palavra|flavio seu tempo/i.test(norm)) {
      s.expectedNextSpeaker = 'B';
    }

    // 2. Reconhecimento direto por pistas inequívocas de fala:
    // ATENÇÃO: Nunca inverta se o falante estiver apenas citando o oponente!
    // Lula falando de si mesmo:
    if (/meu governo|quando fui presidente|quando presidi|quando eu era presidente|nosso governo do pt|minha gestao como presidente/i.test(norm)) {
      s.roles.set(speaker, 'A');
      pushSpeakers();
    } 
    // Flávio Bolsonaro falando de si mesmo ou do pai:
    else if (/meu mandato de senador|meu mandato no senado|como senador pelo rio|governo do meu pai|meu pai jair bolsonaro/i.test(norm)) {
      s.roles.set(speaker, 'B');
      pushSpeakers();
    } 
    // Mediação estrita:
    else if (/direito de resposta|regras do debate|sorteio de temas|bloco do debate|tempo esgotado|intervalo comercial/i.test(norm)) {
      s.roles.set(speaker, 'OTHER');
      pushSpeakers();
    }

    // 3. Atualiza histórico de contexto SEMPRE:
    const currentWho = speakerName(speaker) || `Falante ${speaker}`;
    s.recent.push({ falante: currentWho, texto: text.slice(0, 300) });
    if (s.recent.length > 5) s.recent.shift();
    s.lastSpeaker = speaker;

    // Se for mediação estrita confirmada ou fala com menos de 4 palavras, não extrai afirmação
    if (s.roles.get(speaker) === 'OTHER' || wordCount(text) < 4) return;
    if (!cfg.llm.apiKey) return warnOnce('LLM_API_KEY ausente no servidor: não consigo extrair afirmações das falas.');

    let out;
    try {
      out = await extractClaims({
        llm: cfg.llm,
        text,
        speakerName: speakerName(speaker),
        candidates: s.names,
        sourceLanguage: s.language,
        recent: s.recent,
        context: s.context,
      });
    } catch (e) {
      return send({ type: 'status', level: 'warn', message: `Falha ao extrair afirmações: ${e.message}` });
    }
    if (s.closed) return;

    // Se o extrator identificou o papel do falante (A, B ou OTHER):
    if (out.detectedRole) {
      if (!s.roles.has(speaker) || (s.roles.get(speaker) === 'OTHER' && out.detectedRole !== 'OTHER')) {
        s.roles.set(speaker, out.detectedRole);
        pushSpeakers();
      }
    }

    if (s.roles.get(speaker) === 'OTHER') return;
    if (out.translation) send({ type: 'translation', utteranceId: id, text: out.translation });
    for (const claim of out.claims) enqueueClaim({ utteranceId: id, speaker, claim });
  }

  function enqueueClaim({ utteranceId, speaker, claim }) {
    const claimId = ++s.claimSeq;
    const who = speakerName(speaker);
    send({ type: 'claim', id: claimId, utteranceId, speaker, text: claim.texto, priority: claim.prioridade });

    const words = extractKeywords(claim.texto);
    const hit = s.cache.find((entry) => keywordSimilarity(entry.words, words) >= 0.70);
    if (hit) return send({ type: 'verdict', claimId, ...hit.verdict, cached: true });

    const inFlightHit = s.inFlight.find((entry) => keywordSimilarity(entry.words, words) >= 0.70);
    if (inFlightHit) {
      send({ type: 'claim-status', claimId, status: 'checking' });
      inFlightHit.listeners.push((v) => {
        send({ type: 'verdict', claimId, ...v, cached: true });
      });
      return;
    }

    const inFlightEntry = { words, listeners: [] };
    s.inFlight.push(inFlightEntry);

    queue.add({
      priority: claim.prioridade === 'alta' ? 2 : 1,
      onDrop: () => {
        const idx = s.inFlight.indexOf(inFlightEntry);
        if (idx !== -1) s.inFlight.splice(idx, 1);
        send({ type: 'verdict', claimId, verdict: 'erro', resumo: 'Fila cheia: não deu tempo de checar esta afirmação.', fontes: [] });
      },
      run: async () => {
        if (s.closed) return;
        send({ type: 'claim-status', claimId, status: 'checking' });
        const t0 = Date.now();
        let v;
        try {
          v = await verifyWithHermes({ hermes: cfg.hermes, claim: claim.texto, speakerName: who, context: s.context });
        } catch (e) {
          v = { verdict: 'erro', resumo: `Falha ao consultar o Hermes: ${e.message}`, fontes: [] };
        }
        const idx = s.inFlight.indexOf(inFlightEntry);
        if (idx !== -1) s.inFlight.splice(idx, 1);

        if (v.verdict !== 'erro') s.cache.push({ text: claim.texto, words, verdict: v });
        send({ type: 'verdict', claimId, ...v, ms: Date.now() - t0 });
        for (const notify of inFlightEntry.listeners) notify(v);
      },
    });
  }

  function startDeepgram() {
    s.dg = openDeepgram({
      apiKey: cfg.deepgram.apiKey,
      model: cfg.deepgram.model,
      language: s.language,
      handlers: {
        onResults: (m) => {
          const alt = m.channel?.alternatives?.[0];
          const text = (alt?.transcript || '').trim();
          if (!alt || !text) return;
          const words = alt.words || [];
          if (!m.is_final) {
            const sp = words.length ? words[words.length - 1].speaker : undefined;
            return send({ type: 'interim', ...assembler.preview(Number.isInteger(sp) ? sp : undefined, text) });
          }
          assembler.push(words, text, !!m.speech_final);
          const pv = assembler.preview(undefined, '');
          send({ type: 'interim', speaker: pv.speaker, text: pv.text });
        },
        onUtteranceEnd: () => assembler.flush(),
        onError: (e) => send({ type: 'status', level: 'error', message: `Deepgram: ${e.message}` }),
        onClose: (code, reason) => {
          if (!s.closed) send({ type: 'status', level: 'error', message: `O Deepgram encerrou a conexão (${code}). ${reason}`.trim() });
        },
      },
    });
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) return s.dg?.sendAudio(data);
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    switch (m.type) {
      case 'config': {
        if (s.started) break;
        s.started = true;
        s.language = clip(m.language, 12) || 'pt-BR';
        s.names.A = clip(m.names?.A) || 'Lula';
        s.names.B = clip(m.names?.B) || 'Flávio Bolsonaro';
        s.context = clip(m.context, 500) || 'Debate presidencial entre Lula e Flávio Bolsonaro';
        const audio = m.audio !== false;
        if (audio) {
          if (!cfg.deepgram.apiKey) {
            send({ type: 'status', level: 'error', message: 'DEEPGRAM_API_KEY ausente no servidor (arquivo server/.env).' });
            break;
          }
          startDeepgram();
        }
        send({ type: 'status', state: 'ready', audio, hermes: !!cfg.hermes.apiKey, llm: !!cfg.llm.apiKey });
        pushSpeakers();
        break;
      }
      case 'names':
        s.names.A = clip(m.A);
        s.names.B = clip(m.B);
        pushSpeakers();
        break;
      case 'map':
        if (Number.isInteger(m.speaker) && ['A', 'B', 'OTHER'].includes(m.role)) {
          s.roles.set(m.speaker, m.role);
          pushSpeakers();
        }
        break;
      case 'inject': {
        const text = clip(m.text, 2000);
        if (Number.isInteger(m.speaker) && text) void handleUtterance({ speaker: m.speaker, text });
        break;
      }
      case 'stop':
        ws.close();
        break;
    }
  });

  ws.on('close', () => {
    s.closed = true;
    s.dg?.close();
    queue.close();
    assembler.dispose();
  });
}
