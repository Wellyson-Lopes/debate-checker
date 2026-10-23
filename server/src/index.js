import { buildConfig, loadDotEnv } from './config.js';
import { createApp } from './server.js';

const found = loadDotEnv();
const cfg = buildConfig();

console.log('Debate Checker — servidor');
if (!found) console.log('  ! Arquivo .env não encontrado. Copie .env.example para .env e preencha as chaves.');
const miss = [];
if (!cfg.deepgram.apiKey) miss.push('DEEPGRAM_API_KEY (transcrição)');
if (!cfg.llm.apiKey) miss.push('LLM_API_KEY (extração de afirmações)');
if (!cfg.hermes.apiKey) miss.push('HERMES_API_KEY (checagem pelo Hermes)');
if (miss.length) console.log(`  ! Faltando: ${miss.join(', ')}`);

const app = createApp(cfg);
const addr = await app.listen();
console.log(`  ouvindo em ws://${cfg.host}:${addr.port}/ws`);
console.log(`  Hermes: ${cfg.hermes.baseUrl}   LLM: ${cfg.llm.model}   Deepgram: ${cfg.deepgram.model}`);
console.log('  Rode "npm run check" para testar as conexões.');

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
