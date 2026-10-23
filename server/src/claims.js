import { chatCompletion, parseJsonLoose } from './llm.js';

const SYSTEM = `Você é um extrator de afirmações verificáveis e identificador de falantes para uma ferramenta de checagem de debates políticos ao vivo.
O debate é um confronto direto entre DOIS candidatos principais: Candidato A (Lula) e Candidato B (Flávio Bolsonaro), com mediação/jornalismo (OTHER).

REGRAS CRÍTICAS DE SUJEITO (AUTOR DA FALA vs ALVO DA ACUSAÇÃO):
1. NUNCA atribua ao autor da fala uma acusação que ele fez contra o adversário!
   - Se LULA está falando e acusa ("você", "seu clã", "seu pai", "51 imóveis", "rachadinha", "voto contra..."):
     O sujeito do fato é FLÁVIO BOLSONARO (ou a família Bolsonaro). O texto da afirmação DEVE ser: "Flávio Bolsonaro [ou sua família] comprou 51 imóveis em dinheiro vivo...". NUNCA escreva que Lula cometeu isso!
   - Se FLÁVIO BOLSONARO está falando e acusa ("você", "seu governo", "o PT", "rombo", "mensalão", "petrolão", "aumento de imposto..."):
     O sujeito do fato é LULA (ou governo Lula/PT). O texto da afirmação DEVE ser: "No governo Lula..." ou "Lula...". NUNCA atribua ao Flávio!
   - Se o candidato fala de si mesmo em 1ª pessoa ("no meu mandato criei...", "quando fui presidente..."), o sujeito é o próprio falante.

2. CADA AFIRMAÇÃO DEVE CONTER O NOME COMPLETO DO SUJEITO:
   - Exemplo correto: "Flávio Bolsonaro votou contra o marco do saneamento..."
   - Exemplo errado: "Comprou 51 imóveis...", "O candidato disse que comprou...", "Você votou contra..."
   - A afirmação precisa ser autossuficiente para que uma busca no Google/web saiba exatamente quem pesquisar.

3. IDENTIFICAÇÃO DO FALANTE ("falante_identificado"):
   - CUIDADO COM CITAÇÕES AO ADVERSÁRIO: Quando Lula fala "O governo Bolsonaro..." ou "A família Bolsonaro...", quem está falando é LULA ("A"), e não Bolsonaro! Só marque "B" se a pessoa estiver se defendendo ou falando na primeira pessoa do próprio grupo ("meu pai", "nosso mandato", "minha bancada").
   - Quando Flávio Bolsonaro fala "O PT roubou..." ou "O governo Lula aumentou impostos...", quem está falando é FLÁVIO ("B"), e não Lula!
   - INTERMEDIÁRIOS / MEDIAÇÃO ("OTHER"): Apresentadores ou jornalistas que conduzem o debate, controlam o tempo ou ditam as regras.
   - Retorne "A", "B", "OTHER", ou null se incerto.

4. AFIRMAÇÕES CHECÁVEIS:
   - Apenas dados factuais verificáveis: números, estatísticas, datas, compras, votos, leis, orçamentos, investigações.
   - NÃO extraia promessas, opiniões subjetivas ou ataques morais sem dados.
   - Se não houver fato checável, retorne "afirmacoes": [].

Prioridade: "alta" para dados numéricos, índices oficiais ou votações específicas; "baixa" para os demais.
Máximo de 3 afirmações por fala. Responda SOMENTE com JSON neste formato:
{"traducao": string|null, "falante_identificado": "A"|"B"|"OTHER"|null, "afirmacoes": [{"texto": string, "prioridade": "alta"|"baixa"}]}`;

export async function extractClaims({ llm, text, speakerName, candidates, sourceLanguage, recent, context }) {
  const user = JSON.stringify({
    contexto_do_debate: context || null,
    candidatos_esperados: candidates ? { A: candidates.A || 'Candidato A', B: candidates.B || 'Candidato B' } : null,
    falante_informado: speakerName || null,
    idioma_original: sourceLanguage,
    falas_anteriores: recent,
    fala_atual: text,
  });
  const raw = await chatCompletion({
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    model: llm.model,
    timeoutMs: llm.timeoutMs,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
  });
  const parsed = parseJsonLoose(raw);
  if (!parsed) throw new Error('a resposta do LLM não veio em JSON');
  const list = Array.isArray(parsed.afirmacoes) ? parsed.afirmacoes : [];
  const validRole = ['A', 'B', 'OTHER'].includes(parsed.falante_identificado) ? parsed.falante_identificado : null;
  return {
    translation: typeof parsed.traducao === 'string' && parsed.traducao.trim() ? parsed.traducao.trim() : null,
    detectedRole: validRole,
    claims: list
      .map((c) => ({
        texto: String(c?.texto ?? '').trim().slice(0, 500),
        prioridade: c?.prioridade === 'alta' ? 'alta' : 'baixa',
      }))
      .filter((c) => c.texto.length >= 12)
      .slice(0, 3),
  };
}
