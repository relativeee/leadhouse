/**
 * server.js
 * Servidor principal da LeadHouse.
 * Recebe webhooks do WhatsApp, processa com Claude e persiste no Supabase.
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const db = require('./services/supabase');
const { registrar, login, authMiddleware } = require('./services/auth');
const { validarEAjustarLead } = require('./utils/leadScoring');

// Servicos opcionais (dependem de env vars externas)
let extrairMensagem, enviarMensagem, notificarCorretor;
let gerarResposta, extrairDadosLead, gerarResumoMatching;
let salvarLead;

try { ({ extrairMensagem, enviarMensagem, notificarCorretor } = require('./services/whatsapp')); } catch (e) { console.warn('[Init] WhatsApp desabilitado:', e.message); }
try { ({ gerarResposta, extrairDadosLead, gerarResumoMatching } = require('./services/claude')); } catch (e) { console.warn('[Init] Claude desabilitado:', e.message); }
try { ({ salvarLead } = require('./services/sheets')); } catch (e) { console.warn('[Init] Sheets desabilitado:', e.message); }

const app = express();

// ─────────────────────────────────────────────
// Stripe webhook (precisa do raw body — antes do express.json)
// ─────────────────────────────────────────────
let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
} catch (e) { console.warn('[Init] Stripe desabilitado:', e.message); }

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).send('Stripe nao configurado');

  const sig = req.headers['stripe-signature'];
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    event = whSecret
      ? stripe.webhooks.constructEvent(req.body, sig, whSecret)
      : JSON.parse(req.body.toString());
  } catch (err) {
    console.error('[Stripe] webhook signature invalida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const rawEmail = (session.customer_email || session.customer_details?.email || '').toLowerCase();
      const email = rawEmail.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const plan  = session.metadata?.plan || null;

      if (email && plan) {
        const update = { plano: plan };
        if (session.customer) update.stripe_customer_id = session.customer;
        const { data, error } = await db.supabase
          .from('usuarios')
          .update(update)
          .eq('email', email)
          .select('id, email');
        if (error) console.error('[Stripe] erro ao atualizar plano:', error.message);
        else if (!data || data.length === 0) console.error(`[Stripe] nenhum usuario encontrado para ${email} (raw: ${rawEmail})`);
        else console.log(`[Stripe] plano ${plan} ativado para ${email}`);
      }
    }

    // Cliente trocou de plano (upgrade/downgrade) ou cancelou (cancel_at_period_end)
    if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const priceId = sub.items?.data?.[0]?.price?.id;
      const PRICE_TO_PLAN = {
        [process.env.STRIPE_START_PRICE_ID]: 'start',
        [process.env.STRIPE_PRO_PRICE_ID]:   'pro',
        [process.env.STRIPE_ELITE_PRICE_ID]: 'elite',
      };
      const plan = PRICE_TO_PLAN[priceId] || sub.metadata?.plan || null;
      if (plan && sub.customer) {
        // Se foi marcado pra cancelar no fim do periodo, mantem o plano ate la
        const { error } = await db.supabase
          .from('usuarios')
          .update({ plano: plan })
          .eq('stripe_customer_id', sub.customer);
        if (error) console.error('[Stripe] erro update subscription:', error.message);
        else console.log(`[Stripe] plano atualizado para ${plan} (customer ${sub.customer}, cancel_at_period_end=${sub.cancel_at_period_end})`);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      if (sub.customer) {
        await db.supabase.from('usuarios').update({ plano: null }).eq('stripe_customer_id', sub.customer);
        console.log(`[Stripe] assinatura encerrada para customer ${sub.customer}`);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe] erro processando webhook:', err);
    res.status(500).send('Erro interno');
  }
});

app.use(express.json());

// Login
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// Estado em memoria: apenas historico de conversas
// (dados persistentes ficam no Supabase)
// ─────────────────────────────────────────────
const conversas = {};

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
// Auth — Registro, Login, Verificacao
// ─────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ erro: 'Nome, e-mail e senha sao obrigatorios' });
  if (senha.length < 6) return res.status(400).json({ erro: 'Senha deve ter no minimo 6 caracteres' });
  try {
    const result = await registrar(nome, email, senha);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ erro: 'E-mail e senha sao obrigatorios' });
  try {
    const result = await login(email, senha);
    res.json(result);
  } catch (err) {
    res.status(401).json({ erro: err.message });
  }
});

// Esqueci a senha — gera token e envia email via Resend
app.post('/api/auth/forgot', async (req, res) => {
  try {
    const rawEmail = (req.body.email || '').trim().toLowerCase();
    const email = rawEmail.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (!email) return res.status(400).json({ erro: 'E-mail obrigatorio' });

    // Busca usuario (resposta sempre 200 pra nao vazar quem existe)
    const { data: user } = await db.supabase
      .from('usuarios')
      .select('id, nome, email')
      .eq('email', email)
      .maybeSingle();

    if (user) {
      const crypto = require('crypto');
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h

      await db.supabase.from('password_resets').insert({
        user_id: user.id,
        token,
        expires_at: expiresAt,
      });

      const baseUrl = process.env.SITE_URL || `https://${req.headers.host}`;
      const resetUrl = `${baseUrl}/reset.html?token=${token}`;

      if (process.env.RESEND_API_KEY) {
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: 'LeadHouse <onboarding@resend.dev>',
              to: [user.email],
              subject: 'Redefinir sua senha — LeadHouse',
              html: `
                <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#0A0A0A;color:#E0E0E0;border-radius:16px">
                  <p style="margin:0 0 16px"><img src="${baseUrl}/logo.png" alt="LeadHouse" style="height:64px;display:block"></p>
                  <p style="color:#5A5A5A;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 24px">Redefinicao de senha</p>
                  <p style="font-size:15px;line-height:1.6">Ola ${user.nome || ''},</p>
                  <p style="font-size:15px;line-height:1.6">Recebemos um pedido para redefinir a senha da sua conta. Clique no botao abaixo para criar uma nova senha:</p>
                  <p style="margin:32px 0">
                    <a href="${resetUrl}" style="display:inline-block;background:#C9A84C;color:#0A0A0A;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;letter-spacing:1px;text-transform:uppercase;font-size:13px">Redefinir senha</a>
                  </p>
                  <p style="font-size:13px;color:#888;line-height:1.6">Esse link expira em 1 hora. Se voce nao pediu essa redefinicao, ignore este email.</p>
                  <p style="font-size:12px;color:#555;margin-top:32px;border-top:1px solid #222;padding-top:16px">LeadHouse — Gestao imobiliaria inteligente</p>
                </div>
              `,
            }),
          });
        } catch (e) {
          console.error('[Resend] erro ao enviar:', e.message);
        }
      } else {
        console.log(`[Auth] reset link (Resend nao configurado): ${resetUrl}`);
      }
    }

    res.json({ ok: true, mensagem: 'Se o e-mail existir, enviaremos instrucoes em instantes.' });
  } catch (err) {
    console.error('[forgot] erro:', err);
    res.status(500).json({ erro: 'Erro ao processar pedido' });
  }
});

// Reset — troca a senha usando o token
app.post('/api/auth/reset', async (req, res) => {
  try {
    const { token, senha } = req.body;
    if (!token || !senha) return res.status(400).json({ erro: 'Token e senha obrigatorios' });
    if (senha.length < 6) return res.status(400).json({ erro: 'Senha deve ter no minimo 6 caracteres' });

    const { data: reset } = await db.supabase
      .from('password_resets')
      .select('*')
      .eq('token', token)
      .maybeSingle();

    if (!reset) return res.status(400).json({ erro: 'Token invalido' });
    if (reset.used) return res.status(400).json({ erro: 'Token ja utilizado' });
    if (new Date(reset.expires_at) < new Date()) return res.status(400).json({ erro: 'Token expirado' });

    const bcrypt = require('bcryptjs');
    const senha_hash = await bcrypt.hash(senha, 10);

    await db.supabase.from('usuarios').update({ senha_hash }).eq('id', reset.user_id);
    await db.supabase.from('password_resets').update({ used: true }).eq('token', token);

    res.json({ ok: true, mensagem: 'Senha redefinida com sucesso' });
  } catch (err) {
    console.error('[reset] erro:', err);
    res.status(500).json({ erro: 'Erro ao redefinir senha' });
  }
});

// Stripe Customer Portal — gerenciar plano (cancelar, upgrade, downgrade, cartao)
app.post('/api/stripe/portal', authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ erro: 'Stripe nao configurado' });

    const { data: user, error } = await db.supabase
      .from('usuarios')
      .select('id, email, stripe_customer_id')
      .eq('id', req.userId)
      .maybeSingle();
    if (error || !user) return res.status(404).json({ erro: 'Usuario nao encontrado' });
    if (!user.stripe_customer_id) return res.status(400).json({ erro: 'Voce ainda nao possui uma assinatura ativa' });

    const baseUrl = process.env.SITE_URL || `https://${req.headers.host}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: baseUrl + '/',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[portal] erro:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await db.supabase
      .from('usuarios')
      .select('id, nome, email, plano, stripe_customer_id')
      .eq('id', req.userId)
      .maybeSingle();
    if (error || !data) return res.status(404).json({ erro: 'Usuario nao encontrado' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─────────────────────────────────────────────
// Proteger todas as rotas /api (exceto auth e webhook)
// ─────────────────────────────────────────────
app.use('/api/imoveis', authMiddleware);
app.use('/api/leads', authMiddleware);
app.use('/api/leads-manual', authMiddleware);
app.use('/api/visitas', authMiddleware);
app.use('/api/agente', authMiddleware);

// ─────────────────────────────────────────────
// GET /webhook — Verificacao do webhook (Meta)
// ─────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('[Webhook] Verificacao aprovada pela Meta.');
    return res.status(200).send(challenge);
  }

  console.warn('[Webhook] Token de verificacao invalido.');
  return res.sendStatus(403);
});

// ─────────────────────────────────────────────
// POST /webhook — Recebe mensagens do WhatsApp
// ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  if (!extrairMensagem) return;
  const dados = extrairMensagem(req.body);
  if (!dados) return;

  const { telefone, mensagem, messageId } = dados;
  const conversa = getConversa(telefone);

  if (conversa.mensagensProcessadas.has(messageId)) return;
  conversa.mensagensProcessadas.add(messageId);

  console.log(`[Webhook] Nova mensagem de ${telefone}: "${mensagem}"`);
  conversa.historico.push({ role: 'user', content: mensagem });

  if (conversa.historico.length > 20) {
    conversa.historico = conversa.historico.slice(-20);
  }

  try {
    const resposta = await gerarResposta(conversa.historico);
    conversa.historico.push({ role: 'assistant', content: resposta });
    await enviarMensagem(telefone, resposta);

    const leadDataBruto = await extrairDadosLead(conversa.historico);
    const leadData = validarEAjustarLead(leadDataBruto);

    // Salva no Supabase
    await db.upsertLeadWhatsApp(telefone, {
      nome: leadData.nome || '',
      objetivo: leadData.objetivo || '',
      tipo_imovel: leadData.tipo_imovel || '',
      bairro: leadData.bairro || '',
      faixa_valor: leadData.faixa_valor || '',
      pagamento: leadData.pagamento || '',
      prazo: leadData.prazo || '',
      temperatura: leadData.temperatura || 'frio',
      proximo_passo: leadData.proximo_passo || '',
      resumo: leadData.resumo || '',
      total_mensagens: conversa.historico.filter(m => m.role === 'user').length,
    });

    // Salva no Google Sheets (mantido como backup)
    try {
      await salvarLead(telefone, leadData, conversa.historico.filter(m => m.role === 'user').length);
    } catch (_) { /* Sheets opcional */ }

    if (leadData.temperatura === 'quente') {
      await notificarCorretor(leadData, telefone);
    }
  } catch (err) {
    console.error(`[Webhook] Erro ao processar mensagem de ${telefone}:`, err.message);
    try { await enviarMensagem(telefone, 'Desculpe, tive um problema aqui. Pode repetir?'); } catch (_) {}
  }
});

// ─────────────────────────────────────────────
// API — Leads WhatsApp (do Supabase)
// ─────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  try {
    const leads = await db.listarLeads('whatsapp', req.userId);
    res.json(leads.map(l => ({
      telefone: l.telefone,
      nome: l.nome || 'Sem nome',
      objetivo: l.objetivo || 'nao informado',
      tipo_imovel: l.tipo_imovel || 'nao informado',
      bairro: l.bairro || 'nao informado',
      faixa_valor: l.faixa_valor || 'nao informado',
      pagamento: l.pagamento || 'nao informado',
      prazo: l.prazo || 'nao informado',
      temperatura: l.temperatura || 'frio',
      proximo_passo: l.proximo_passo || 'nao informado',
      resumo: l.resumo || '',
      totalMensagens: l.total_mensagens || 0,
      ultimaAtualizacao: l.updated_at ? new Date(l.updated_at).toLocaleString('pt-BR', { timeZone: 'America/Recife' }) : '--',
    })));
  } catch (err) {
    console.error('[API] Erro ao listar leads:', err.message);
    res.json([]);
  }
});

// ─────────────────────────────────────────────
// API — Imoveis (Supabase)
// ─────────────────────────────────────────────
app.get('/api/imoveis', async (req, res) => {
  try { res.json(await db.listarImoveis(req.userId)); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/imoveis', async (req, res) => {
  const { titulo, tipo } = req.body;
  if (!titulo || !tipo) return res.status(400).json({ erro: 'Titulo e tipo sao obrigatorios' });
  try {
    const imovel = await db.criarImovel({
      titulo, tipo,
      status: req.body.status || 'disponivel',
      endereco: req.body.endereco || '',
      bairro: req.body.bairro || '',
      cidade: req.body.cidade || '',
      valor: req.body.valor || '',
      quartos: req.body.quartos || '',
      area: req.body.area || '',
      descricao: req.body.descricao || '',
    }, req.userId);
    res.status(201).json(imovel);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/imoveis/:id', async (req, res) => {
  try { res.json(await db.atualizarImovel(parseInt(req.params.id), req.body, req.userId)); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.delete('/api/imoveis/:id', async (req, res) => {
  try { await db.excluirImovel(parseInt(req.params.id), req.userId); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────
// API — Leads manuais (Supabase)
// ─────────────────────────────────────────────
app.get('/api/leads-manual', async (req, res) => {
  try {
    const leads = await db.listarLeads('manual', req.userId);
    res.json(leads.map(l => ({
      id: l.id,
      nome: l.nome,
      telefone: l.telefone,
      email: l.email || '',
      objetivo: l.objetivo || '',
      tipo_imovel: l.tipo_imovel || '',
      bairro: l.bairro || '',
      faixa_valor: l.faixa_valor || '',
      pagamento: l.pagamento || '',
      prazo: l.prazo || '',
      temperatura: l.temperatura || 'frio',
      observacoes: l.observacoes || '',
      origem: 'manual',
      criadoEm: l.created_at ? new Date(l.created_at).toLocaleString('pt-BR', { timeZone: 'America/Recife' }) : '--',
    })));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/leads-manual', async (req, res) => {
  const { nome, telefone } = req.body;
  if (!nome || !telefone) return res.status(400).json({ erro: 'Nome e telefone sao obrigatorios' });
  try {
    const lead = await db.criarLead({
      nome, telefone,
      email: req.body.email || '',
      objetivo: req.body.objetivo || '',
      tipo_imovel: req.body.tipo_imovel || '',
      bairro: req.body.bairro || '',
      faixa_valor: req.body.faixa_valor || '',
      pagamento: req.body.pagamento || '',
      prazo: req.body.prazo || '',
      temperatura: req.body.temperatura || 'frio',
      observacoes: req.body.observacoes || '',
      origem: 'manual',
    }, req.userId);
    res.status(201).json(lead);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/leads-manual/:id', async (req, res) => {
  try { res.json(await db.atualizarLead(parseInt(req.params.id), req.body, req.userId)); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.delete('/api/leads-manual/:id', async (req, res) => {
  try { await db.excluirLead(parseInt(req.params.id), req.userId); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────
// API — Visitas (Supabase)
// ─────────────────────────────────────────────
app.get('/api/visitas', async (req, res) => {
  try { res.json(await db.listarVisitas(req.userId)); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/visitas', async (req, res) => {
  const { lead_nome, data, horario } = req.body;
  if (!lead_nome || !data || !horario) return res.status(400).json({ erro: 'Lead, data e horario sao obrigatorios' });
  try {
    const visita = await db.criarVisita({
      lead_nome,
      lead_telefone: req.body.lead_telefone || '',
      imovel_titulo: req.body.imovel_titulo || '',
      endereco: req.body.endereco || '',
      data, horario,
      corretor: req.body.corretor || '',
      observacoes: req.body.observacoes || '',
      status: req.body.status || 'agendada',
    }, req.userId);
    res.status(201).json(visita);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/visitas/:id', async (req, res) => {
  try { res.json(await db.atualizarVisita(parseInt(req.params.id), req.body, req.userId)); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.delete('/api/visitas/:id', async (req, res) => {
  try { await db.excluirVisita(parseInt(req.params.id), req.userId); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────
// API — Agente IA (resumo matching lead x imovel)
// ─────────────────────────────────────────────
app.post('/api/agente/resumo', async (req, res) => {
  try {
    const [todosLeads, todosImoveis, todasVisitas] = await Promise.all([
      db.listarLeads(null, req.userId),
      db.listarImoveis(req.userId),
      db.listarVisitas(req.userId),
    ]);

    if (!gerarResumoMatching) return res.status(503).json({ erro: 'Agente IA nao configurado. Adicione ANTHROPIC_API_KEY.' });
    const imoveisDisponiveis = todosImoveis.filter(i => i.status === 'disponivel' || i.status === 'reservado');
    const resumo = await gerarResumoMatching(todosLeads, imoveisDisponiveis, todasVisitas);

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
// Start (local) + Export (Vercel)
// ─────────────────────────────────────────────
if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\nLeadHouse rodando na porta ${PORT}`);
    console.log(`  Dashboard: http://localhost:${PORT}`);
    console.log(`  Webhook:   POST /webhook`);
    console.log(`  Health:    GET  /health\n`);
  });
}

module.exports = app;
