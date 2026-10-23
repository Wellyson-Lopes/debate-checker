import { buildConfig, loadDotEnv } from './config.js';
import { chatCompletion } from './llm.js';
import { verifyWithHermes } from './verify.js';

const found = loadDotEnv();
const cfg = buildConfig();
const deep = process.argv.includes('--verify');
let failed = false;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failed = true; console.log(`  ✗ ${m}`); };
const warn = (m) => console.log(`  ! ${m}`);

console.log('Debate Checker — teste de conexões');
if (!found) bad('Arquivo server/.env não encontrado (copie de .env.example).');

console.log('\nDeepgram');
if (!cfg.deepgram.apiKey) bad('DEEPGRAM_API_KEY vazia');
else {
  try {
    const r = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${cfg.deepgram.apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 401) bad('chave recusada (401)');
    else if (r.ok) ok('chave aceita');
    else ok(`chave aceita (resposta ${r.status}, provavelmente chave com permissão restrita)`);
  } catch (e) { bad(`sem conexão: ${e.message}`); }
}

console.log('\nLLM de extração');
if (!cfg.llm.apiKey) bad('LLM_API_KEY vazia');
else {
  try {
    const t0 = Date.now();
    const out = await chatCompletion({ ...cfg.llm, messages: [{ role: 'user', content: 'Responda apenas: OK' }], temperature: 0 });
    ok(`${cfg.llm.model} respondeu em ${Date.now() - t0} ms: "${out.trim().slice(0, 40)}"`);
  } catch (e) { bad(`falhou: ${e.message}`); }
}

console.log('\nHermes Agent');
if (!cfg.hermes.apiKey) bad('HERMES_API_KEY vazia (use o mesmo valor de API_SERVER_KEY do ~/.hermes/.env)');
else {
  const origin = new URL(cfg.hermes.baseUrl).origin;
  try {
    const h = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5000) });
    h.ok ? ok(`API server no ar em ${origin}`) : bad(`/health respondeu ${h.status}`);
  } catch {
    bad(`não achei o API server em ${origin}. Rodou "hermes gateway" com API_SERVER_ENABLED=true?`);
  }
  try {
    const m = await fetch(`${cfg.hermes.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${cfg.hermes.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (m.status === 401) bad('chave recusada (401): HERMES_API_KEY diferente de API_SERVER_KEY');
    else if (m.ok) ok('autenticação OK');
    else bad(`/models respondeu ${m.status}`);
  } catch (e) { bad(`falhou: ${e.message}`); }

  if (deep) {
    console.log('\nChecagem de ponta a ponta (pode levar de 20 s a 2 min)');
    try {
      const t0 = Date.now();
      const v = await verifyWithHermes({
        hermes: cfg.hermes,
        claim: 'O Brasil tem 26 estados e um Distrito Federal.',
        speakerName: 'Teste',
        context: 'Teste de conexão',
      });
      ok(`veredito "${v.verdict}" em ${Math.round((Date.now() - t0) / 1000)} s`);
      if (v.resumo) console.log(`    ${v.resumo}`);
      for (const f of v.fontes) console.log(`    - ${f.titulo || f.url} (${f.url})`);
      if (v.verdict === 'nao_verificavel' || v.verdict === 'erro') warn('O Hermes respondeu, mas sem veredito com fonte. Confira se ele tem busca na web configurada (hermes setup).');
    } catch (e) { bad(`falhou: ${e.message}`); }
  } else {
    console.log('\n  (dica: "npm run check:hermes" testa também uma checagem completa)');
  }
}

console.log(failed ? '\nTem coisa para ajustar acima.' : '\nTudo certo.');
process.exit(failed ? 1 : 0);
