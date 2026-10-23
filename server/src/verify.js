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
  return `Você é um verificador de fatos profissional, rigoroso e imparcial para checagem de debates políticos AO VIVO (seguindo os critérios padrão da Agência Lupa, Aos Fatos e Comprova).
Data de hoje: ${today}.
${context ? `Contexto do debate: ${context}\n` : ''}
Tarefa: verificar UMA afirmação feita no debate e responder somente com JSON.

COMO TRABALHAR:
- Busque na web os dados reais e checagens sobre o assunto (agências de checagem, G1 Fato ou Fake, UOL Confere, Estadão Verifica, órgãos oficiais, PF, CGU, IBGE, TSE).
- Seja objetivo e rápido: faça 1 a 2 buscas bem direcionadas. Responda em JSON.

CRITÉRIOS RIGOROSOS DE VEREDITO (ATENÇÃO ESPECIAL A DADOS FORA DE CONTEXTO):
1. "verdadeiro":
   - O fato central, os números, a AUTORIA e a RESPONSABILIDADE estão 100% corretos.
   - Não há omissão maliciosa de contexto que mude o sentido da frase.

2. "enganoso":
   - USA DADO OU NÚMERO REAL, MAS DISTORCE A CULPA OU O CONTEXTO:
     * Culpa o governo ou o adversário por uma fraude ou crime praticado por terceiros ou entidades privadas (ex: associações ou sindicatos que fraudaram o INSS).
     * Omite que o problema começou em gestões anteriores (atravessando diferentes governos).
     * Omite que o próprio governo atual investigou (via PF/CGU) e está ressarcindo as vítimas.
     * Compara grandezas sem ajuste pela inflação ou distorce a relação de causa e efeito.
   - Sempre que um dado real for usado para induzir a uma conclusão distorcida ou injusta sobre o adversário, o veredito DEVE ser "enganoso".

3. "parcialmente_verdadeiro":
   - Há parte do dado que é verdadeira, mas com imprecisões numéricas ou mistura com alegações não comprovadas.

4. "falso":
   - O fato central não ocorreu, é inventado ou foi categoricamente desmentido por documentos ou fontes oficiais.

5. "nao_verificavel":
   - Não há dados públicos suficientes, a frase é excessivamente vaga ou não há fontes confiáveis.

Formato da resposta (somente JSON):
{"veredito":"verdadeiro"|"parcialmente_verdadeiro"|"enganoso"|"falso"|"nao_verificavel","resumo":"até 3 frases claras: o que é real, o que foi distorcido ou omitido e por que o veredito foi dado","fontes":[{"titulo":"...","url":"https://..."}]}
Todo veredito diferente de "nao_verificavel" exige pelo menos uma fonte confiável com URL.`;
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
        content: `Afirmação dita no debate:\n<afirmacao>${claim}</afirmacao>\nFalante no debate: ${speakerName || 'não identificado'}\n\nORIENTAÇÃO DE CHECAGEM:\n1. O dado numérico ou fato citado é real?\n2. A responsabilidade/autoria alegada condiz com a verdade, ou é ENGANOSO (ex.: culpa o governo por fraudes de terceiros/associações privadas, omite que começou em governos anteriores, ou omite que o próprio governo desmantelou o esquema e está ressarcindo as vítimas)?\n3. Emita o veredito rigoroso e justo em JSON com fontes reais.`,
      },
    ],
  });
  return normalizeVerdict(parseJsonLoose(raw));
}
