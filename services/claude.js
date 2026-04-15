/**
 * services/claude.js
 * Integração com a API da Anthropic (Claude).
 * Responsável por:
 * - Gerar resposta conversacional para o lead
 * - Extrair dados estruturados do lead via JSON
 */

const Anthropic = require('@anthropic-ai/sdk');
const { systemPrompt } = require('../prompts/systemPrompt');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Gera uma resposta curta e natural para o lead.
 * @param {Array} historico - Array de {role, content} da conversa
 * @returns {string} Resposta da IA
 */
async function gerarResposta(historico, contextoExtra) {
  try {
    let system = systemPrompt;
    if (contextoExtra) system += '\n\n' + contextoExtra;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
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
  "resumo": "resumo de 2-3 linhas da conversa"
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
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
  const prompt = `Você é um assistente especializado em mercado imobiliário. Analise os dados abaixo e gere um RESUMO EXECUTIVO claro e organizado.

## LEADS (clientes buscando imóvel):
${leads.length === 0 ? 'Nenhum lead cadastrado.' : leads.map((l, i) => `${i + 1}. ${l.nome || 'Sem nome'} | Tel: ${l.telefone} | Quer: ${l.objetivo || '?'} | Tipo: ${l.tipo_imovel || '?'} | Bairro: ${l.bairro || '?'} | Faixa: ${l.faixa_valor || '?'} | Pagamento: ${l.pagamento || '?'} | Prazo: ${l.prazo || '?'} | Temperatura: ${l.temperatura || '?'} | Resumo: ${l.resumo || l.observacoes || ''}`).join('\n')}

## IMÓVEIS DISPONÍVEIS:
${imoveis.length === 0 ? 'Nenhum imóvel cadastrado.' : imoveis.map((im, i) => `${i + 1}. "${im.titulo}" | Tipo: ${im.tipo} | Bairro: ${im.bairro || '?'} | Cidade: ${im.cidade || '?'} | Valor: R$ ${im.valor || '?'} | Quartos: ${im.quartos || '?'} | Área: ${im.area || '?'}m² | Status: ${im.status} | Desc: ${im.descricao || ''}`).join('\n')}

## VISITAS JÁ AGENDADAS:
${visitas.length === 0 ? 'Nenhuma visita agendada.' : visitas.map((v, i) => `${i + 1}. ${v.lead_nome} → ${v.imovel_titulo || 'imóvel não especificado'} | Data: ${v.data} ${v.horario} | Status: ${v.status}`).join('\n')}

---

Gere o seguinte relatório em formato estruturado (use markdown):

### 1. MATCHES (Cliente ↔ Imóvel)
Para cada lead, analise se algum imóvel disponível combina com o que ele procura (tipo, bairro, faixa de valor). Liste os matches encontrados com nível de compatibilidade (alta/média/baixa) e justificativa curta.

### 2. LEADS SEM MATCH
Leads que não têm nenhum imóvel compatível no catálogo. Sugira que tipo de imóvel deveria ser buscado/cadastrado para atendê-los.

### 3. IMÓVEIS SEM INTERESSE
Imóveis que nenhum lead atual demonstrou interesse. Sugira ações (ex: divulgação, ajuste de preço).

### 4. AÇÕES RECOMENDADAS
Lista priorizada das próximas ações que o corretor deveria tomar, com base na temperatura dos leads e urgência.

### 5. VISÃO GERAL
Um parágrafo resumindo a situação atual da carteira: quantos leads quentes precisam de atenção, oportunidades de fechamento, gargalos.

Seja direto, objetivo e use linguagem profissional de mercado imobiliário. Responda em português.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
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
