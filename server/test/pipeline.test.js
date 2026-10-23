import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { buildConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

/** Servidor falso compatível com OpenAI: faz as vezes do LLM extrator e do Hermes. */
function mockLLM(verifierReply, extractorReply) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msgs = JSON.parse(body).messages;
      const system = msgs[0].content;
      let content;
      if (system.includes('extrator de afirmações')) {
        content = JSON.stringify(extractorReply || {
          traducao: null,
          afirmacoes: [{ texto: 'O desemprego caiu para 6% em 2025 segundo o IBGE.', prioridade: 'alta' }],
        });
      } else if (system.includes('verificador de fatos')) {
        content = '```json\n' + JSON.stringify(verifierReply) + '\n```';
      } else content = '{}';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

async function setup(verifierReply, extra = {}, extractorReply) {
  const mock = await mockLLM(verifierReply, extractorReply);
  const cfg = buildConfig({ PORT: '0', LLM_API_KEY: 'x', LLM_BASE_URL: mock.url, HERMES_API_KEY: 'y', HERMES_BASE_URL: mock.url, ...extra });
  const app = createApp(cfg);
  const addr = await app.listen();
  return { mock, app, url: `ws://127.0.0.1:${addr.port}/ws` };
}

function connect(url, opts) {
  const ws = new WebSocket(url, opts);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  const waitFor = (pred, ms = 4000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const f = msgs.find(pred);
        if (f) return resolve(f);
        if (Date.now() - t0 > ms) return reject(new Error('timeout esperando mensagem'));
        setTimeout(tick, 20);
      };
      tick();
    });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, msgs, waitFor }));
    ws.on('error', reject);
    ws.on('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

test('fluxo completo: fala -> afirmação -> veredito com fonte', async () => {
  const { mock, app, url } = await setup({
    veredito: 'Falso',
    resumo: 'O IBGE reportou outro valor.',
    fontes: [{ titulo: 'IBGE', url: 'https://www.ibge.gov.br/' }, { titulo: 'lixo', url: 'javascript:alert(1)' }],
  });
  const c = await connect(url);
  c.ws.send(JSON.stringify({ type: 'config', audio: false, language: 'pt-BR', names: { A: 'Ana', B: 'Beto' } }));
  await c.waitFor((m) => m.type === 'status' && m.state === 'ready');
  c.ws.send(JSON.stringify({ type: 'map', speaker: 0, role: 'A' }));
  c.ws.send(JSON.stringify({ type: 'inject', speaker: 0, text: 'No meu governo o desemprego caiu para seis por cento em 2025 segundo o IBGE' }));
  const claim = await c.waitFor((m) => m.type === 'claim');
  assert.equal(claim.priority, 'alta');
  const verdict = await c.waitFor((m) => m.type === 'verdict');
  assert.equal(verdict.verdict, 'falso');
  assert.equal(verdict.fontes.length, 1, 'URL não http(s) deve ser descartada');
  assert.equal(verdict.fontes[0].url, 'https://www.ibge.gov.br/');
  c.ws.close();
  await app.close();
  mock.server.close();
});

test('veredito sem fonte vira não verificável', async () => {
  const { mock, app, url } = await setup({ veredito: 'verdadeiro', resumo: 'Parece certo.', fontes: [] });
  const c = await connect(url);
  c.ws.send(JSON.stringify({ type: 'config', audio: false }));
  await c.waitFor((m) => m.state === 'ready');
  c.ws.send(JSON.stringify({ type: 'inject', speaker: 1, text: 'O desemprego caiu para seis por cento em dois mil e vinte e cinco' }));
  const verdict = await c.waitFor((m) => m.type === 'verdict');
  assert.equal(verdict.verdict, 'nao_verificavel');
  assert.match(verdict.resumo, /nenhuma fonte/);
  c.ws.close();
  await app.close();
  mock.server.close();
});

test('falas de mediação (OTHER) não geram afirmações', async () => {
  const { mock, app, url } = await setup({ veredito: 'falso', resumo: '', fontes: [] });
  const c = await connect(url);
  c.ws.send(JSON.stringify({ type: 'config', audio: false }));
  await c.waitFor((m) => m.state === 'ready');
  c.ws.send(JSON.stringify({ type: 'map', speaker: 2, role: 'OTHER' }));
  c.ws.send(JSON.stringify({ type: 'inject', speaker: 2, text: 'Boa noite, vamos começar o primeiro bloco do debate de hoje' }));
  await c.waitFor((m) => m.type === 'utterance');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(c.msgs.filter((m) => m.type === 'claim').length, 0);
  c.ws.close();
  await app.close();
  mock.server.close();
});

test('segurança: origem de site comum e token errado são recusados', async () => {
  const { mock, app, url } = await setup({}, { SERVER_TOKEN: 'segredo' });
  await assert.rejects(connect(`${url}?token=segredo`, { headers: { Origin: 'https://site-malicioso.example' } }), /403/);
  await assert.rejects(connect(`${url}?token=errado`), /401/);
  const ok = await connect(`${url}?token=segredo`, { headers: { Origin: 'chrome-extension://abcdef' } });
  ok.ws.close();
  await app.close();
  mock.server.close();
});

test('auto-identificação de falante pelo LLM associa voz ao candidato', async () => {
  const { mock, app, url } = await setup(
    { veredito: 'verdadeiro', resumo: 'Correto.', fontes: [{ titulo: 'IBGE', url: 'https://ibge.gov.br' }] },
    {},
    {
      traducao: null,
      falante_identificado: 'B',
      afirmacoes: [{ texto: 'A inflação fechou em 4% segundo dados oficiais.', prioridade: 'alta' }],
    }
  );
  const c = await connect(url);
  c.ws.send(JSON.stringify({ type: 'config', audio: false, names: { A: 'Candidato A', B: 'Candidato B' } }));
  await c.waitFor((m) => m.state === 'ready');
  c.ws.send(JSON.stringify({ type: 'inject', speaker: 3, text: 'No meu mandato a inflação fechou em quatro por cento segundo o IBGE' }));
  const spkEv = await c.waitFor((m) => m.type === 'speakers' && m.roles['3'] === 'B');
  assert.equal(spkEv.roles['3'], 'B', 'Voz 3 deve ter sido auto-associada ao candidato B');
  const claim = await c.waitFor((m) => m.type === 'claim');
  assert.equal(claim.speaker, 3);
  c.ws.close();
  await app.close();
  mock.server.close();
});
