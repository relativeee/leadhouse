/**
 * server.js
 * Servidor principal da LeadHaus AI.
 * Recebe webhooks do WhatsApp, processa com Claude e salva no Sheets.
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const { extrairMensagem, enviarMensagem, notificarCorretor } = require('./services/whatsapp');
const { gerarResposta, extrairDadosLead, gerarResumoMatching } = require('./services/claude');
const { salvarLead } = require('./services/sheets');
const { validarEAjustarLead } = require('./utils/leadScoring');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// Estado em memória
// Em produção, substituir por Redis ou banco.
// ─────────────────────────────────────────────
const conversas = {}; // { [telefone]: { historico: [], mensagensProcessadas: Set } }
const imoveis = [];   // Cadastro de imóveis
const leadsManual = []; // Leads cadastrados manualmente
const visitas = [];   // Agenda de visitas
let nextId = { imovel: 1, lead: 1, visita: 1 };

function getConversa(telefone) {
  if (!conversas[telefone]) {
    conversas[telefone] = {
      historico: [],
      mensagensProcessadas: new Set(),
    };
  }
  return conversas[telefone];
}

// ─────────────────────────────────────────────
// GET /webhook — Verificação do webhook (Meta)
// ─────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('[Webhook] Verificação aprovada pela Meta.');
    return res.status(200).send(challenge);
  }

  console.warn('[Webhook] Token de verificação inválido.');
  return res.sendStatus(403);
});

// ─────────────────────────────────────────────
// POST /webhook — Recebe mensagens do WhatsApp
// ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Responde imediatamente para evitar timeout do WhatsApp
  res.sendStatus(200);

  const dados = extrairMensagem(req.body);
  if (!dados) return;

  const { telefone, mensagem, messageId } = dados;
  const conversa = getConversa(telefone);

  // Ignora mensagens duplicadas
  if (conversa.mensagensProcessadas.has(messageId)) {
    console.log(`[Webhook] Mensagem duplicada ignorada: ${messageId}`);
    return;
  }
  conversa.mensagensProcessadas.add(messageId);

  console.log(`[Webhook] Nova mensagem de ${telefone}: "${mensagem}"`);

  // Adiciona mensagem do lead ao histórico
  conversa.historico.push({ role: 'user', content: mensagem });

  // Mantém histórico com no máximo 20 mensagens (10 trocas) para não exceder tokens
  if (conversa.historico.length > 20) {
    conversa.historico = conversa.historico.slice(-20);
  }

  try {
    // 1. Gera resposta conversacional
    const resposta = await gerarResposta(conversa.historico);
    console.log(`[Claude] Resposta gerada para ${telefone}: "${resposta}"`);

    // 2. Adiciona resposta da IA ao histórico
    conversa.historico.push({ role: 'assistant', content: resposta });

    // 3. Envia resposta para o lead
    await enviarMensagem(telefone, resposta);

    // 4. Extrai dados estruturados do lead (a cada mensagem, sempre atualiza)
    const leadDataBruto = await extrairDadosLead(conversa.historico);
    const leadData = validarEAjustarLead(leadDataBruto);
    console.log(`[Lead] Dados extraídos para ${telefone}:`, JSON.stringify(leadData));

    // Salva dados no estado em memória (para o dashboard)
    conversa.leadData = leadData;
    conversa.ultimaAtualizacao = new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' });

    // 5. Salva no Google Sheets
    await salvarLead(telefone, leadData, conversa.historico.filter(m => m.role === 'user').length);

    // 6. Notifica corretor se lead for quente
    if (leadData.temperatura === 'quente') {
      console.log(`[Lead] 🔥 Lead quente identificado: ${telefone}`);
      await notificarCorretor(leadData, telefone);
    }

  } catch (err) {
    console.error(`[Webhook] Erro ao processar mensagem de ${telefone}:`, err.message);
    // Tenta avisar o lead de forma genérica em caso de erro crítico
    try {
      await enviarMensagem(telefone, 'Desculpe, tive um problema aqui. Pode repetir?');
    } catch (_) {
      // Silencia erro secundário
    }
  }
});

// ─────────────────────────────────────────────
// API — Lista de leads (para o dashboard)
// ─────────────────────────────────────────────
app.get('/api/leads', (req, res) => {
  const leadsArray = Object.entries(conversas).map(([telefone, conversa]) => {
    const dados = conversa.leadData || {};
    return {
      telefone,
      nome: dados.nome || 'Sem nome',
      objetivo: dados.objetivo || 'nao informado',
      tipo_imovel: dados.tipo_imovel || 'nao informado',
      bairro: dados.bairro || 'nao informado',
      faixa_valor: dados.faixa_valor || 'nao informado',
      pagamento: dados.pagamento || 'nao informado',
      prazo: dados.prazo || 'nao informado',
      temperatura: dados.temperatura || 'frio',
      proximo_passo: dados.proximo_passo || 'nao informado',
      resumo: dados.resumo || '',
      totalMensagens: conversa.historico.filter(m => m.role === 'user').length,
      ultimaAtualizacao: conversa.ultimaAtualizacao || '--',
    };
  });
  res.json(leadsArray);
});

// ─────────────────────────────────────────────
// API — Imóveis (CRUD)
// ─────────────────────────────────────────────
app.get('/api/imoveis', (req, res) => {
  res.json(imoveis);
});

app.post('/api/imoveis', (req, res) => {
  const { titulo, tipo, endereco, bairro, cidade, valor, quartos, area, descricao, status } = req.body;
  if (!titulo || !tipo) return res.status(400).json({ erro: 'Titulo e tipo sao obrigatorios' });
  const imovel = {
    id: nextId.imovel++,
    titulo, tipo, endereco: endereco || '', bairro: bairro || '', cidade: cidade || '',
    valor: valor || '', quartos: quartos || '', area: area || '', descricao: descricao || '',
    status: status || 'disponivel',
    criadoEm: new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' }),
  };
  imoveis.push(imovel);
  res.status(201).json(imovel);
});

app.put('/api/imoveis/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = imoveis.findIndex(i => i.id === id);
  if (idx === -1) return res.status(404).json({ erro: 'Imovel nao encontrado' });
  Object.assign(imoveis[idx], req.body, { id });
  res.json(imoveis[idx]);
});

app.delete('/api/imoveis/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = imoveis.findIndex(i => i.id === id);
  if (idx === -1) return res.status(404).json({ erro: 'Imovel nao encontrado' });
  imoveis.splice(idx, 1);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// API — Leads manuais (CRUD)
// ─────────────────────────────────────────────
app.get('/api/leads-manual', (req, res) => {
  res.json(leadsManual);
});

app.post('/api/leads-manual', (req, res) => {
  const { nome, telefone, email, objetivo, tipo_imovel, bairro, faixa_valor, pagamento, prazo, temperatura, observacoes } = req.body;
  if (!nome || !telefone) return res.status(400).json({ erro: 'Nome e telefone sao obrigatorios' });
  const lead = {
    id: nextId.lead++,
    nome, telefone, email: email || '', objetivo: objetivo || '', tipo_imovel: tipo_imovel || '',
    bairro: bairro || '', faixa_valor: faixa_valor || '', pagamento: pagamento || '',
    prazo: prazo || '', temperatura: temperatura || 'frio', observacoes: observacoes || '',
    origem: 'manual',
    criadoEm: new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' }),
  };
  leadsManual.push(lead);
  res.status(201).json(lead);
});

app.put('/api/leads-manual/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = leadsManual.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ erro: 'Lead nao encontrado' });
  Object.assign(leadsManual[idx], req.body, { id });
  res.json(leadsManual[idx]);
});

app.delete('/api/leads-manual/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = leadsManual.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ erro: 'Lead nao encontrado' });
  leadsManual.splice(idx, 1);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// API — Visitas (CRUD)
// ─────────────────────────────────────────────
app.get('/api/visitas', (req, res) => {
  res.json(visitas);
});

app.post('/api/visitas', (req, res) => {
  const { lead_nome, lead_telefone, imovel_titulo, endereco, data, horario, corretor, observacoes, status } = req.body;
  if (!lead_nome || !data || !horario) return res.status(400).json({ erro: 'Lead, data e horario sao obrigatorios' });
  const visita = {
    id: nextId.visita++,
    lead_nome, lead_telefone: lead_telefone || '', imovel_titulo: imovel_titulo || '',
    endereco: endereco || '', data, horario, corretor: corretor || '',
    observacoes: observacoes || '', status: status || 'agendada',
    criadoEm: new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' }),
  };
  visitas.push(visita);
  res.status(201).json(visita);
});

app.put('/api/visitas/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = visitas.findIndex(v => v.id === id);
  if (idx === -1) return res.status(404).json({ erro: 'Visita nao encontrada' });
  Object.assign(visitas[idx], req.body, { id });
  res.json(visitas[idx]);
});

app.delete('/api/visitas/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = visitas.findIndex(v => v.id === id);
  if (idx === -1) return res.status(404).json({ erro: 'Visita nao encontrada' });
  visitas.splice(idx, 1);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// API — Agente IA (resumo matching lead ↔ imóvel)
// ─────────────────────────────────────────────
app.post('/api/agente/resumo', async (req, res) => {
  try {
    // Junta leads do WhatsApp + manuais
    const leadsWpp = Object.entries(conversas).map(([telefone, conversa]) => {
      const dados = conversa.leadData || {};
      return {
        nome: dados.nome || 'Sem nome',
        telefone,
        objetivo: dados.objetivo || '',
        tipo_imovel: dados.tipo_imovel || '',
        bairro: dados.bairro || '',
        faixa_valor: dados.faixa_valor || '',
        pagamento: dados.pagamento || '',
        prazo: dados.prazo || '',
        temperatura: dados.temperatura || 'frio',
        resumo: dados.resumo || '',
        origem: 'whatsapp',
      };
    });

    const todosLeads = [...leadsWpp, ...leadsManual.map(l => ({ ...l, origem: 'manual' }))];
    const imoveisDisponiveis = imoveis.filter(i => i.status === 'disponivel' || i.status === 'reservado');

    const resumo = await gerarResumoMatching(todosLeads, imoveisDisponiveis, visitas);

    res.json({ resumo, geradoEm: new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' }) });
  } catch (err) {
    console.error('[Agente] Erro ao gerar resumo:', err.message);
    res.status(500).json({ erro: 'Erro ao gerar resumo. Verifique a chave da API.' });
  }
});

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 LeadHaus AI rodando na porta ${PORT}`);
  console.log(`   Webhook: POST /webhook`);
  console.log(`   Health:  GET  /health\n`);
});
