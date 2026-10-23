# Debate Checker

Extensão do Chrome que **ouve o áudio de um debate ao vivo na aba**, transcreve, separa as vozes, extrai as afirmações checáveis e manda o **Hermes Agent** pesquisar e dar o veredito (verdadeiro, parcialmente verdadeiro, enganoso, falso ou não verificável), sempre com fontes.

```
Aba do debate ──áudio──▶ Extensão (Chrome) ──WebSocket──▶ Servidor local (Node)
                                                           ├─ Deepgram: transcrição ao vivo + separação de vozes
                                                           ├─ LLM rápido: traduz e extrai afirmações checáveis
                                                           └─ Hermes Agent: pesquisa na web e devolve o veredito com fontes
```

## O que você precisa

- Google Chrome 116 ou mais novo
- Node.js 20.3 ou mais novo
- Chave do **Deepgram** (tem crédito grátis ao criar a conta): https://console.deepgram.com
- Chave de um **LLM compatível com a API da OpenAI** para a extração. Pode ser a do Gemini (Google AI Studio)
- **Hermes Agent** instalado, com um provedor de modelo e busca na web configurados

## 1. Baixar e preparar o servidor

```bash
unzip debate-checker.zip
cd debate-checker/server
npm install
cp .env.example .env     # no Windows: copy .env.example .env
```

Abra o `.env` e preencha `DEEPGRAM_API_KEY`, `LLM_API_KEY` (e confira `LLM_MODEL`) e `HERMES_API_KEY` (passo 2).

## 2. Conectar no seu Hermes

O Hermes tem um API server compatível com OpenAI. O Debate Checker conversa com ele por `POST /v1/chat/completions`.

1. Edite `~/.hermes/.env` e acrescente:

   ```
   API_SERVER_ENABLED=true
   API_SERVER_KEY=troque-por-uma-senha-grande
   ```

2. Se ainda não configurou modelo e ferramentas (busca na web), rode `hermes setup` (ou `hermes setup --portal` se usa o Nous Portal).
3. Suba o gateway: `hermes gateway`. Deve aparecer `API server listening on http://127.0.0.1:8642`.
4. No `server/.env` do Debate Checker, use **a mesma senha** em `HERMES_API_KEY`. `HERMES_BASE_URL` já vem como `http://127.0.0.1:8642/v1`.
5. Teste:

   ```bash
   cd debate-checker/server
   npm run check:hermes
   ```

   Ele testa Deepgram, LLM, Hermes e faz uma checagem de ponta a ponta com uma afirmação de exemplo.

**Recomendações para o Hermes**

- O API server dá acesso ao conjunto completo de ferramentas do agente, inclusive terminal. O prompt do Debate Checker manda o agente usar só busca e leitura de páginas, mas isso é uma instrução, não uma trava. Mantenha o servidor em `127.0.0.1` (padrão) e, se puder, use um **profile dedicado** com ferramentas reduzidas. A documentação do Hermes mostra como criar profiles com porta própria (`hermes profile create ...`, `API_SERVER_PORT=8643` no `.env` do profile, `hermes -p <profile> gateway`). Se usar outra porta, ajuste `HERMES_BASE_URL`.
- O Hermes limita 10 execuções simultâneas por padrão. O Debate Checker usa 3 (`HERMES_CONCURRENCY`).

## 3. Rodar o servidor

```bash
cd debate-checker/server
npm start
```

Deixe esta janela aberta durante o debate.

## 4. Instalar a extensão

1. No Chrome, abra `chrome://extensions`.
2. Ligue o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e escolha a pasta `debate-checker/extension`.
4. Fixe o ícone na barra do Chrome (opcional).

## 5. Usar

1. Abra a aba com a transmissão do debate (YouTube, site da emissora etc.) e dê play.
2. Clique no **ícone da extensão**. O painel lateral abre e a escuta começa. O ícone mostra "ON".
3. Nos primeiros minutos, em **Quem é quem**, toque no nome certo para cada voz (A, B ou mediação). Se as vozes trocarem no meio, use **Trocar A ⇄ B**.
4. Em **Configurações e teste**, coloque o nome dos candidatos e o contexto (ex.: "debate presidencial, 2º turno, 2026"). Isso melhora a checagem.
5. Acompanhe o feed (mais recente em cima). Cada afirmação aparece como "Na fila…", depois "Verificando…" e por fim o veredito com resumo e fontes. O placar no topo soma por candidato.
6. **Exportar** baixa um relatório em Markdown com as afirmações, vereditos e fontes.

O som da aba continua tocando normalmente. Para parar, use **Parar** no painel.

### Testar sem debate

Em **Configurações e teste**, clique em **Iniciar modo teste**, digite uma fala (ex.: "No meu governo o desemprego caiu para 6% em 2025 segundo o IBGE") e clique em **Enviar fala de teste**. Passa por extração e Hermes sem usar o Deepgram.

### Testes automáticos do servidor

```bash
cd debate-checker/server
npm test
```

## Limitações que você precisa conhecer

- **Atraso**: transcrição leva 1 a 3 s, extração 1 a 3 s, e a checagem do Hermes costuma levar de 20 s a mais de 1 min. O veredito chega depois da fala. Afirmações com número ou dado oficial têm prioridade na fila.
- **Quem fala**: a separação de vozes é automática, mas ligar "voz 0" a um candidato é manual (um toque). Pode haver troca no começo ou quando duas pessoas falam ao mesmo tempo. Se identificar errado, a checagem atribui a afirmação à pessoa errada. Reconhecimento automático por impressão de voz é um próximo passo possível.
- **IA erra**: o servidor descarta qualquer veredito sem fonte citada e converte em "não verificável", mas fonte citada não garante veredito certo. Trate o resultado como apoio para você conferir, não como sentença.
- **Não vira rótulo de mentiroso**: critérios iguais para os dois lados, e a ferramenta só checa fatos, não opinião nem promessa.
- Se for divulgar resultados publicamente durante a campanha, confira as regras do TSE sobre conteúdo eleitoral e uso de IA.
- Páginas internas do Chrome (`chrome://`) não podem ser capturadas.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| "Não consegui conectar em ws://127.0.0.1:8787/ws" | O servidor não está rodando: `npm start` na pasta `server`. |
| Erro 401 do Deepgram | Confira `DEEPGRAM_API_KEY`. |
| "Servidor sem HERMES_API_KEY" | Preencha no `server/.env` e reinicie o servidor. |
| "Falha ao consultar o Hermes: HTTP 401" | `HERMES_API_KEY` diferente de `API_SERVER_KEY`. |
| Tudo "não verificável" | O Hermes está sem busca na web configurada. Rode `hermes setup`. |
| Nada transcreve | Confirme que a aba está tocando áudio e que o idioma do painel é o do debate. |
| Erro de captura ao clicar em Iniciar | Clique no ícone da extensão (não no botão do painel) com a aba do debate ativa. |

## Estrutura

```
extension/   manifest, service worker, captura de áudio (offscreen), painel lateral
server/      WebSocket, Deepgram, extração de afirmações, cliente do Hermes, testes
```
