import { chatCompletion, parseJsonLoose } from './llm.js';

export const VERDICTS = ['verdadeiro', 'parcialmente_verdadeiro', 'enganoso', 'falso', 'nao_verificavel'];

const ALIASES = {
  verdadeiro: 'verdadeiro', verdadeira: 'verdadeiro', true: 'verdadeiro',
  parcialmente_verdadeiro: 'parcialmente_verdadeiro', parcialmente_verdadeira: 'parcialmente_verdadeiro',
  parcial: 'parcialmente_verdadeiro', meio_verdadeiro: 'parcialmente_verdadeiro',
  enganoso: 'enganoso', enganosa: 'enganoso', misleading: 'enganoso',
  falso: 'falso', falsa: 'falso', false: 'falso',
  nao_verificavel: 'nao_verificavel', nao_verificado: 'nao_verificavel', inconclusivo: 'nao_verificavel',
};

const slug = (s) =>
  String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/[\s-]+/g, '_');

function systemPrompt({ context, today }) {
  return `Você é um verificador de fatos rigoroso e ultra-rápido para checagem de debates políticos AO VIVO.
Data de hoje: ${today}.
${context ? `Contexto do debate: ${context}\n` : ''}
Tarefa: verificar UMA afirmação e responder somente com JSON.

Regras de velocidade máxima (Debate ao Vivo):
- SEJA MUITO RÁPIDO: Faça apenas 1 busca web direta com termos-chave (máximo 2 se indispensável).
- Não leia textos longos. Se o resultado da busca ou o resumo de uma fonte confiável já responder o fato, emita o veredito imediatamente.
- Priorize fontes confiáveis (órgãos oficiais, IBGE, TSE, tribunais, grandes jornais, agências de checagem).
- Cite URLs que você consultou. Nunca invente fontes.
- Veredito sem fonte vira "nao_verificavel".

Vereditos permitidos:
- "verdadeiro": o fato central está correto.
- "parcialmente_verdadeiro": parte correta e parte imprecisa.
- "enganoso": dado fora de contexto ou comparação distorcida.
- "falso": contradito pelas fontes.
- "nao_verificavel": sem dados suficientes ou afirmação vaga.

Formato da resposta (somente JSON):
{"veredito":"...","resumo":"até 2 frases diretas explicando o veredito","fontes":[{"titulo":"...","url":"https://..."}]}`;
}

/** Valida a resposta do agente. Regra de ouro: veredito sem fonte citada é descartado. */
export function normalizeVerdict(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { verdict: 'erro', resumo: 'O agente não devolveu uma resposta em JSON.', fontes: [] };
  }
  let verdict = ALIASES[slug(parsed.veredito ?? parsed.verdict)] ?? 'nao_verificavel';
  let resumo = String(parsed.resumo ?? parsed.summary ?? '').trim().slice(0, 600);
  const fontes = (Array.isArray(parsed.fontes) ? parsed.fontes : [])
    .map((f) => ({ titulo: String(f?.titulo ?? f?.title ?? '').trim().slice(0, 140), url: String(f?.url ?? '').trim() }))
    .filter((f) => {
      try {
        const u = new URL(f.url);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    })
    .slice(0, 5);
  if (verdict !== 'nao_verificavel' && fontes.length === 0) {
    resumo = `Veredito descartado porque nenhuma fonte foi citada. ${resumo}`.trim();
    verdict = 'nao_verificavel';
  }
  return { verdict, resumo, fontes };
}

export async function verifyWithHermes({ hermes, claim, speakerName, context }) {
  if (!hermes.apiKey) throw new Error('HERMES_API_KEY não configurada no servidor');
  const today = new Date().toISOString().slice(0, 10);
  const raw = await chatCompletion({
    baseUrl: hermes.baseUrl,
    apiKey: hermes.apiKey,
    model: hermes.model,
    timeoutMs: hermes.timeoutMs,
    messages: [
      { role: 'system', content: systemPrompt({ context, today }) },
      {
        role: 'user',
        content: `Verifique a afirmação abaixo.\nAfirmação feita no debate por: ${speakerName || 'não identificado'}\n<afirmacao>${claim}</afirmacao>\n\nATENÇÃO AO SUJEITO: O falante (${speakerName || 'o candidato'}) pode estar citando ou acusando o adversário. Verifique se o fato dito dentro de <afirmacao> realmente ocorreu conforme descrito, pesquisando sobre quem é o sujeito da afirmação, sem confundir o autor da fala com o alvo da acusação.`,
      },
    ],
  });
  return normalizeVerdict(parseJsonLoose(raw));
}
