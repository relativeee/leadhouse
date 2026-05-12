/**
 * services/claude.js
 * Integração com a API da Anthropic (Claude).
 * Responsável por:
 * - Gerar resposta conversacional para o lead
 * - Extrair dados estruturados do lead via JSON
 */

const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('../prompts/systemPrompt');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

// Schemas das tools que a Lia pode acionar.
// O loop de tool_use so eh ativado se o caller passar `toolHandlers` em opcoes.
const TOOL_SCHEMAS = [
  {
    name: 'imoveis',
    description: 'Consulta o banco de imoveis disponiveis do corretor. Use sempre que o lead perguntar sobre imoveis, mencionar criterios (bairro, tipo, valor, quartos), ou citar um imovel especifico. Retorna lista com id, titulo, bairro, tipo, valor, quartos, area, status.',
    input_schema: {
      type: 'object',
      properties: {
        bairro: { type: 'string', description: 'Bairro ou regiao que o lead pediu (ex: Manaira, Tambau). Opcional.' },
        tipo: { type: 'string', description: 'Tipo de imovel (apartamento, casa, comercial, terreno, cobertura). Opcional.' },
        quartos_min: { type: 'integer', description: 'Numero minimo de quartos. Opcional.' },
        valor_max: { type: 'number', description: 'Valor maximo em reais (ex: 600000 para 600 mil). Opcional.' },
        valor_min: { type: 'number', description: 'Valor minimo em reais. Opcional.' },
        nome: { type: 'string', description: 'Busca por nome/titulo do imovel ou edificio (ex: "Solar", "Edificio Ondas"). Opcional.' },
      },
    },
  },
  {
    name: 'enviando_arquivos',
    description: 'Envia a foto principal de um imovel para o lead via WhatsApp. Use apos `imoveis` quando o lead pedir foto ou demonstrar interesse visual. NUNCA chute id_imovel — sempre use um id retornado por `imoveis`.',
    input_schema: {
      type: 'object',
      properties: {
        id_imovel: { type: 'integer', description: 'ID do imovel retornado pela tool `imoveis`.' },
      },
      required: ['id_imovel'],
    },
  },
];

/**
 * Gera resposta da Lia, opcionalmente com tool use (imoveis / enviando_arquivos).
 *
 * @param {Array} historico - Array de {role, content} da conversa
 * @param {string} [contextoExtra] - Contexto adicional (ex: horarios livres, dados ja coletados)
 * @param {Object} [opcoes]
 * @param {string} [opcoes.nomeCorretor]
 * @param {string} [opcoes.tempoResposta]
 * @param {Object} [opcoes.toolHandlers] - { imoveis, enviando_arquivos } — se ausente, sem tools
 * @returns {Promise<{texto: string, toolsExecutadas: Array}>}
 */
async function gerarResposta(historico, contextoExtra, opcoes = {}) {
  try {
    // contextoExtra vai como estadoConversa (INJETADO NO TOPO do system).
    // Anti-saudacao + dados-coletados precisam ter primazia sobre os few-shot
    // exemplos da secao 12 do prompt — modelo copia o "Oi! Aqui e a Lia..." de
    // todos os exemplos se a regra ficar enterrada no final do system.
    const system = buildSystemPrompt({ ...opcoes, estadoConversa: contextoExtra });

    const { toolHandlers } = opcoes;
    const useTools = !!toolHandlers;
    const tools = useTools ? TOOL_SCHEMAS : undefined;

    const messages = historico.map(m => ({ role: m.role, content: m.content }));
    const toolsExecutadas = [];
    const MAX_ITER = 5;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 600,
        system,
        messages,
        ...(tools ? { tools } : {}),
      });

      // Se parou por end_turn ou nao tem tool_use, extrai texto e retorna
      if (response.stop_reason !== 'tool_use') {
        const textBlock = response.content.find(b => b.type === 'text');
        const texto = (textBlock?.text || '').trim();
        return { texto, toolsExecutadas };
      }

      // tool_use: executa cada tool, monta tool_result e continua o loop
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const block of toolUseBlocks) {
        const handler = toolHandlers[block.name];
        let resultPayload;
        try {
          if (!handler) {
            resultPayload = { erro: `tool ${block.name} nao disponivel` };
          } else {
            resultPayload = await handler(block.input || {});
          }
        } catch (err) {
          console.error(`[Claude.tool] ${block.name} falhou:`, err.message);
          resultPayload = { erro: err.message || 'falha na execucao' };
        }
        toolsExecutadas.push({ nome: block.name, input: block.input, resultado: resultPayload });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: typeof resultPayload === 'string' ? resultPayload : JSON.stringify(resultPayload),
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }

    // Estouro de iteracoes — fallback
    console.warn('[Claude] tool_use loop estourou MAX_ITER, retornando fallback');
    return { texto: 'Desculpe, tive um problema aqui. Pode repetir?', toolsExecutadas };
  } catch (err) {
    console.error('[Claude] Erro ao gerar resposta:', err.message);
    throw err;
  }
}

/**
 * Extrai dados estruturados do lead a partir do histórico de conversa.
 * @param {Array} historico - Array de {role, content}
 * @returns {Object} Dados estruturados do lead
 */
async function extrairDadosLead(historico) {
  // Injeta a data atual pra evitar o modelo chutar ano (bug observado:
  // visita criada em 2024 quando o ano real era 2026).
  const agora = new Date();
  const hojeBR = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Recife', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' });
  const hojeISO = agora.toLocaleDateString('en-CA', { timeZone: 'America/Recife' }); // YYYY-MM-DD

  const promptExtracao = `# CONTEXTO TEMPORAL OBRIGATÓRIO
Hoje é ${hojeBR} (${hojeISO}). Use ESSE ano (${agora.getFullYear()}) ao gerar qualquer data. NUNCA escreva data de ano passado ou de mais de 1 ano no futuro.

Com base na conversa abaixo, extraia os dados do lead e retorne SOMENTE um JSON válido, sem nenhum texto adicional, sem markdown, sem explicações.

Conversa:
${historico.map(m => `${m.role === 'user' ? 'Lead' : 'Assistente'}: ${m.content}`).join('\n')}

Retorne exatamente neste formato JSON:
{
  "nome": "nome do lead ou 'não informado'",
  "objetivo": "comprar | alugar | investir | não informado",
  "tipo_imovel": "apartamento | casa | comercial | terreno | não informado",
  "bairro": "bairro/região ou 'não informado'",
  "faixa_valor": "valor ou faixa ou 'não informado'",
  "pagamento": "financiamento | à vista | FGTS | misto | não informado",
  "prazo": "prazo estimado ou 'não informado'",
  "temperatura": "quente | morno | frio",
  "proximo_passo": "ação recomendada para o corretor",
  "resumo": "resumo de 2-3 linhas da conversa",
  "visita_agendada": {
    "confirmada": true ou false (true APENAS se o lead aceitou um horário específico E a Lia confirmou),
    "data": "YYYY-MM-DD a partir de ${hojeISO} (HOJE OU FUTURO, NUNCA passado), ou 'não'",
    "horario": "HH:MM ou 'não'",
    "imovel_titulo": "título do imóvel se mencionado, ou 'não especificado'"
  }
}`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: promptExtracao }],
    });

    const texto = response.content[0].text.trim();

    // Remove possíveis blocos de markdown caso apareçam
    const jsonLimpo = texto.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    return JSON.parse(jsonLimpo);
  } catch (err) {
    console.error('[Claude] Erro ao extrair dados do lead:', err.message);
    // Retorna estrutura padrão em caso de falha
    return {
      nome: 'não informado',
      objetivo: 'não informado',
      tipo_imovel: 'não informado',
      bairro: 'não informado',
      faixa_valor: 'não informado',
      pagamento: 'não informado',
      prazo: 'não informado',
      temperatura: 'frio',
      proximo_passo: 'Verificar conversa manualmente',
      resumo: 'Erro na extração automática. Revisar conversa.',
      visita_agendada: { confirmada: false, data: 'não', horario: 'não', imovel_titulo: 'não especificado' },
    };
  }
}

/**
 * Gera um resumo inteligente cruzando leads com imóveis disponíveis.
 * Identifica qual cliente está interessado em qual imóvel.
 * @param {Array} leads - Lista de leads (WhatsApp + manuais)
 * @param {Array} imoveis - Lista de imóveis cadastrados
 * @param {Array} visitas - Lista de visitas agendadas
 * @returns {string} Resumo em markdown
 */
async function gerarResumoMatching(leads, imoveis, visitas) {
  // Caso sem dados: resposta curta e acionável
  if (leads.length === 0 && imoveis.length === 0) {
    return `## 👋 Vamos começar!

Seu painel ainda está vazio. Para a IA gerar uma análise útil, você precisa de pelo menos:

- **1 lead cadastrado** (manual ou via WhatsApp)
- **1 imóvel cadastrado**

### Próximos passos
1. Cadastre seus primeiros imóveis em **Imóveis → Novo imóvel**
2. Adicione leads em **Cadastro de Leads**
3. Volte aqui e clique em **Gerar Análise**`;
  }

  const prompt = `Você é um consultor sênior de mercado imobiliário. Gere uma análise CURTA, DIRETA e ACIONÁVEL para um corretor autônomo.

DADOS:

LEADS (${leads.length}):
${leads.length === 0 ? 'Nenhum.' : leads.map((l, i) => `${i + 1}. ${l.nome || 'Sem nome'} | ${l.telefone} | Quer: ${l.objetivo || '?'} ${l.tipo_imovel || '?'} em ${l.bairro || '?'} | R$ ${l.faixa_valor || '?'} | ${l.temperatura || '?'}`).join('\n')}

IMÓVEIS (${imoveis.length}):
${imoveis.length === 0 ? 'Nenhum.' : imoveis.map((im, i) => `${i + 1}. "${im.titulo}" | ${im.tipo} em ${im.bairro || '?'} | R$ ${im.valor || '?'} | ${im.quartos || '?'}Q | ${im.status}`).join('\n')}

VISITAS AGENDADAS (${visitas.length}):
${visitas.length === 0 ? 'Nenhuma.' : visitas.map((v, i) => `${i + 1}. ${v.lead_nome} → ${v.imovel_titulo || '?'} em ${v.data}`).join('\n')}

---

INSTRUÇÕES DE FORMATO (SIGA EXATAMENTE):

- Máximo 300 palavras no total.
- NÃO use tabelas. NÃO use separadores (---).
- Use apenas títulos \`##\` e listas com \`-\`.
- Linguagem simples, como se falasse com um amigo corretor.
- Priorize AÇÕES, não descrições.
- Se uma seção não tem nada relevante, OMITA ela inteira (não escreva "Nenhum").

ESTRUTURA SUGERIDA:

## 🎯 Matches encontrados
Liste só os matches reais (lead ↔ imóvel). Formato: **Nome do lead** → **Imóvel** (compatibilidade: alta/média). Uma linha cada.

## 🔥 Prioridades da semana
Até 3 ações concretas que você deve fazer AGORA. Comece cada linha com um verbo (Ligar, Agendar, Cadastrar).

## 💡 Dica rápida
Uma única observação curta sobre a carteira. Uma frase só.

Responda em português brasileiro.`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content[0].text.trim();
  } catch (err) {
    console.error('[Claude] Erro ao gerar resumo de matching:', err.message);
    throw err;
  }
}

module.exports = { gerarResposta, extrairDadosLead, gerarResumoMatching };
