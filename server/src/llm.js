/** Chamada a um endpoint /chat/completions compatível com OpenAI (com retry automático em 503 draining / 429). */
export async function chatCompletion({ baseUrl, apiKey, model, messages, temperature, timeoutMs = 30000, retries = 3 }) {
  const body = { model, messages, stream: false };
  if (temperature !== undefined) body.temperature = temperature;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        if ((res.status === 503 || res.status === 502 || res.status === 429) && attempt < retries) {
          await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
          continue;
        }
        throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : '';
    } catch (err) {
      if (attempt < retries && (err.message.includes('503') || err.message.includes('fetch failed') || err.message.includes('ECONNREFUSED'))) {
        await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

/** Extrai o primeiro objeto JSON de um texto (tolera ```json ... ``` e texto ao redor). */
export function parseJsonLoose(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}
