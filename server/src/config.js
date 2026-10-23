import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Lê o arquivo .env (sem depender de pacote externo). Variáveis já definidas no ambiente têm prioridade. */
export function loadDotEnv(file = path.join(here, '..', '.env')) {
  if (!fs.existsSync(file)) return false;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else if (v.startsWith('#')) v = '';
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

export function buildConfig(env = process.env) {
  const str = (k, d = '') => (env[k] !== undefined && env[k] !== '' ? env[k] : d);
  const num = (k, d) => {
    const n = Number(env[k]);
    return env[k] !== undefined && env[k] !== '' && Number.isFinite(n) ? n : d;
  };
  return {
    host: str('HOST', '127.0.0.1'),
    port: num('PORT', 8787),
    serverToken: str('SERVER_TOKEN'),
    deepgram: { apiKey: str('DEEPGRAM_API_KEY'), model: str('DEEPGRAM_MODEL', 'nova-3') },
    llm: {
      baseUrl: str('LLM_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai'),
      apiKey: str('LLM_API_KEY'),
      model: str('LLM_MODEL', 'gemini-2.5-flash'),
      timeoutMs: num('LLM_TIMEOUT_MS', 30000),
    },
    hermes: {
      baseUrl: str('HERMES_BASE_URL', 'http://127.0.0.1:8642/v1'),
      apiKey: str('HERMES_API_KEY'),
      model: str('HERMES_MODEL', 'hermes-agent'),
      concurrency: num('HERMES_CONCURRENCY', 3),
      timeoutMs: num('HERMES_TIMEOUT_MS', 180000),
      maxQueue: num('MAX_QUEUE', 30),
    },
  };
}
