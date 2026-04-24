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

/**
 * Gera uma resposta curta e natural para o lead.
 * @param {Array} historico - Array de {role, content} da conversa
 * @param {string} [contextoExtra] - Contexto adicional (ex: horarios livres)
 * @param {{nomeCorretor?: string, tempoResposta?: string}} [opcoes]
 * @returns {string} Resposta da IA
 */
async function gerarResposta(historico, contextoExtra, opcoes = {}) {
  try {
    let system = buildSystemPrompt(opcoes);
    if (contextoExtra) system += '\n\n' + contextoExtra;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system,
      messages: historico,
    });

    return response.content[0].text.trim();
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
  const promptExtracao = `Com base na conversa abaixo, extraia os dados do lead e retorne SOMENTE um JSON válido, sem nenhum texto adicional, sem markdown, sem explicações.

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
    "data": "YYYY-MM-DD ou 'não'",
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
