/**
 * server.js
 * Servidor principal da LeadHouse.
 * Recebe webhooks do WhatsApp, processa com Claude e persiste no Supabase.
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./services/supabase');
const { registrar, login, authMiddleware } = require('./services/auth');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('FATAL: JWT_SECRET nao definido no .env'); process.exit(1); }
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
    if (!whSecret) {
      console.error('[Stripe] STRIPE_WEBHOOK_SECRET nao configurado — rejeitando evento');
      return res.status(403).send('Webhook secret nao configurado');
    }
    event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
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

app.use(express.json({ limit: '5mb' }));

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // desabilitado pra não quebrar inline scripts
  crossOriginEmbedderPolicy: false,
}));

// Rate limiting nos endpoints de auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20, // max 20 tentativas por IP
  message: { erro: 'Muitas tentativas. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot', authLimiter);
app.use('/api/auth/reset', authLimiter);

// Rate limiting geral nas APIs (100 req/min por IP)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { erro: 'Limite de requisicoes atingido. Aguarde um momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

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
const CONVERSA_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function getConversa(telefone) {
  if (!conversas[telefone]) {
    conversas[telefone] = {
      historico: [],
      mensagensProcessadas: new Set(),
      ultimaAtividade: Date.now(),
    };
  }
  conversas[telefone].ultimaAtividade = Date.now();
  return conversas[telefone];
}

// Limpa conversas inativas a cada hora
setInterval(() => {
  const agora = Date.now();
  for (const tel of Object.keys(conversas)) {
    if (agora - conversas[tel].ultimaAtividade > CONVERSA_TTL_MS) {
      delete conversas[tel];
    }
  }
}, 60 * 60 * 1000);

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

// Login com Google
function googleLoginRedirectUri(req) {
  const base = process.env.SITE_URL || `https://${req.headers.host}`;
  return `${base}/api/auth/google/callback`;
}

app.get('/api/auth/google/login', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).send('Google nao configurado');
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleLoginRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error || !code) return res.redirect('/login?error=google_denied');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleLoginRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) return res.redirect('/login?error=google_token');

    const uiRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await uiRes.json();
    if (!profile.email) return res.redirect('/login?error=google_email');

    // Busca usuario existente pelo email
    const { data: existente } = await db.supabase
      .from('usuarios')
      .select('id, nome, email, plano')
      .eq('email', profile.email.toLowerCase())
      .maybeSingle();

    let user;
    if (existente) {
      user = existente;
    } else {
      // Cria conta nova automaticamente
      const bcrypt = require('bcryptjs');
      const randomPass = require('crypto').randomBytes(32).toString('hex');
      const senha_hash = await bcrypt.hash(randomPass, 10);
      const { data: novo, error: dbErr } = await db.supabase
        .from('usuarios')
        .insert({
          nome: profile.name || profile.email.split('@')[0],
          email: profile.email.toLowerCase(),
          senha_hash,
          google_email: profile.email,
        })
        .select('id, nome, email, plano')
        .single();
      if (dbErr) return res.redirect('/login?error=google_create');
      user = novo;
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    // Redireciona pro login com token via query param (frontend salva e redireciona)
    res.redirect(`/login?google_token=${token}&google_user=${encodeURIComponent(JSON.stringify({ id: user.id, nome: user.nome, email: user.email, plano: user.plano }))}`);
  } catch (err) {
    console.error('[google login] erro:', err);
    res.redirect('/login?error=google_server');
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
              from: 'LeadHouse <noreply@leadhouses.com.br>',
              to: [user.email],
              subject: 'Redefinir sua senha — LeadHouse',
              html: `
                <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#0A0A0A;color:#E0E0E0;border-radius:16px">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 16px"><tr><td style="text-align:center">
                    <span style="display:inline-block;width:56px;height:56px;line-height:56px;border-radius:14px;background:#1a1a1a;border:1px solid #2a2a2a;text-align:center;font-size:30px">🏠</span>
                  </td></tr></table>
                  <h1 style="font-family:Georgia,serif;color:#C9A84C;font-size:26px;margin:0 0 4px;text-align:center;letter-spacing:1px">LeadHouse</h1>
                  <p style="color:#5A5A5A;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 28px;text-align:center">Redefinicao de senha</p>
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

    const { error: errUpdate } = await db.supabase.from('usuarios').update({ senha_hash }).eq('id', reset.user_id);
    if (errUpdate) throw new Error('Erro ao atualizar senha: ' + errUpdate.message);

    const { error: errToken } = await db.supabase.from('password_resets').update({ used: true }).eq('token', token);
    if (errToken) console.error('[reset] erro ao invalidar token:', errToken.message);

    res.json({ ok: true, mensagem: 'Senha redefinida com sucesso' });
  } catch (err) {
    console.error('[reset] erro:', err);
    res.status(500).json({ erro: 'Erro ao redefinir senha' });
  }
});

// Atualizar dados da conta (nome e/ou senha)
app.put('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { nome, senha_atual, senha_nova } = req.body;
    const updates = {};

    if (nome && nome.trim().length >= 2) {
      updates.nome = nome.trim();
    }

    if (senha_nova) {
      if (!senha_atual) return res.status(400).json({ erro: 'Informe a senha atual' });
      if (senha_nova.length < 6) return res.status(400).json({ erro: 'Nova senha deve ter no minimo 6 caracteres' });

      const { data: user } = await db.supabase
        .from('usuarios')
        .select('senha_hash')
        .eq('id', req.userId)
        .maybeSingle();
      if (!user) return res.status(404).json({ erro: 'Usuario nao encontrado' });

      const bcrypt = require('bcryptjs');
      const ok = await bcrypt.compare(senha_atual, user.senha_hash);
      if (!ok) return res.status(401).json({ erro: 'Senha atual incorreta' });

      updates.senha_hash = await bcrypt.hash(senha_nova, 10);
    }

    // Horário de trabalho
    if (req.body.horario_trabalho) {
      updates.horario_trabalho = req.body.horario_trabalho;
    }
    // Bloqueios de horário
    if (req.body.bloqueios_json !== undefined) {
      updates.bloqueios_json = req.body.bloqueios_json;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ erro: 'Nenhum campo para atualizar' });
    }

    const { error } = await db.supabase.from('usuarios').update(updates).eq('id', req.userId);
    if (error) return res.status(500).json({ erro: error.message });

    res.json({ ok: true, mensagem: 'Conta atualizada' });
  } catch (err) {
    console.error('[updateMe] erro:', err);
    res.status(500).json({ erro: 'Erro ao atualizar conta' });
  }
});

// ─────────────────────────────────────────────
// Google Calendar — OAuth + criacao de eventos
// ─────────────────────────────────────────────
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
].join(' ');

function googleRedirectUri(req) {
  const base = process.env.SITE_URL || `https://${req.headers.host}`;
  return `${base}/api/google/callback`;
}

// Inicia o fluxo OAuth — gera link e redireciona
// Aceita token via query param (?token=...) porque o navegador nao envia headers em redirect
app.get('/api/google/auth', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).send('Google nao configurado');
  const token = req.query.token;
  if (!token) return res.status(401).send('Token nao fornecido');
  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).send('Token invalido'); }

  // assina o userId no state pra recuperar no callback
  const state = jwt.sign({ uid: decoded.id }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Callback do Google — troca code por tokens e salva refresh_token
app.get('/api/google/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect('/?google=error');
    if (!code || !state) return res.status(400).send('Faltou code ou state');

    let payload;
    try { payload = jwt.verify(state, JWT_SECRET); }
    catch { return res.status(400).send('State invalido'); }
    const userId = payload.uid;

    // Troca code por tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('[google] erro tokens:', tokens);
      return res.redirect('/?google=error');
    }

    // Pega o email da conta
    let google_email = null;
    try {
      const uiRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const ui = await uiRes.json();
      google_email = ui.email || null;
    } catch {}

    if (!tokens.refresh_token) {
      console.warn('[google] sem refresh_token — usuario ja autorizou antes');
    }

    const update = { google_email };
    if (tokens.refresh_token) update.google_refresh_token = tokens.refresh_token;

    const { error: dbErr } = await db.supabase
      .from('usuarios')
      .update(update)
      .eq('id', userId);
    if (dbErr) {
      console.error('[google] erro salvando token:', dbErr.message);
      return res.redirect('/?google=error');
    }

    res.redirect('/?google=ok');
  } catch (err) {
    console.error('[google callback] erro:', err);
    res.redirect('/?google=error');
  }
});

// Desconectar Google
app.post('/api/google/disconnect', authMiddleware, async (req, res) => {
  try {
    await db.supabase
      .from('usuarios')
      .update({ google_refresh_token: null, google_email: null })
      .eq('id', req.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Helper: pega access_token a partir do refresh_token salvo
async function googleAccessToken(refresh_token) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Erro ao renovar token Google');
  return data.access_token;
}

// Helper: cria evento no GCal do usuario
async function criarEventoGCal(userId, visita) {
  try {
    const { data: user } = await db.supabase
      .from('usuarios')
      .select('google_refresh_token')
      .eq('id', userId)
      .maybeSingle();
    if (!user?.google_refresh_token) return null;

    const access_token = await googleAccessToken(user.google_refresh_token);

    // Normaliza data — aceita "2026-04-12" ou "12/04/2026"
    let dataIso = visita.data;
    if (dataIso && dataIso.includes('/')) {
      const [d, m, y] = dataIso.split('/');
      dataIso = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    }
    // Normaliza horario — aceita "14:30" ou "14:30:00"
    let horaIso = (visita.horario || '00:00').slice(0, 5); // pega so HH:MM
    if (!/^\d{2}:\d{2}$/.test(horaIso)) {
      console.error('[google] horario invalido:', visita.horario);
      return null;
    }
    const startIso = `${dataIso}T${horaIso}:00`;
    // Soma 1h direto na string (mantem fuso local sem conversoes)
    const [hh, mm] = horaIso.split(':').map(Number);
    const endHour = String((hh + 1) % 24).padStart(2, '0');
    let endDateStr = dataIso;
    if (hh + 1 >= 24) {
      const d = new Date(dataIso + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      endDateStr = d.toISOString().slice(0, 10);
    }
    const endIso = `${endDateStr}T${endHour}:${String(mm).padStart(2,'0')}:00`;

    const event = {
      summary: `Visita: ${visita.lead_nome}${visita.imovel_titulo ? ' — ' + visita.imovel_titulo : ''}`,
      description: [
        visita.lead_telefone ? `Telefone: ${visita.lead_telefone}` : null,
        visita.endereco ? `Endereco: ${visita.endereco}` : null,
        visita.observacoes ? `Obs: ${visita.observacoes}` : null,
        '',
        'Agendado pelo LeadHouse',
      ].filter(Boolean).join('\n'),
      location: visita.endereco || undefined,
      start: { dateTime: startIso, timeZone: 'America/Sao_Paulo' },
      end:   { dateTime: endIso,   timeZone: 'America/Sao_Paulo' },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 10 },
        ],
      },
    };

    const evRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    });
    const evData = await evRes.json();
    if (!evRes.ok) {
      console.error('[google] erro criando evento:', evData);
      return null;
    }
    console.log(`[google] evento criado: ${evData.id} para usuario ${userId}`);
    return evData.id;
  } catch (err) {
    console.error('[google] criarEventoGCal:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Stripe — gerenciamento de plano in-app
// ─────────────────────────────────────────────
const STRIPE_PRICES = {
  start: process.env.STRIPE_START_PRICE_ID,
  pro:   process.env.STRIPE_PRO_PRICE_ID,
  elite: process.env.STRIPE_ELITE_PRICE_ID,
};

// Helper: pega assinatura ativa do customer
async function getActiveSubscription(customerId) {
  if (!stripe || !customerId) return null;
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 5,
  });
  // pega a primeira ativa ou trialing ou em past_due
  return subs.data.find(s => ['active', 'trialing', 'past_due'].includes(s.status)) || null;
}

// GET status detalhado da assinatura
app.get('/api/stripe/subscription', authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ erro: 'Stripe nao configurado' });
    const { data: user } = await db.supabase
      .from('usuarios')
      .select('plano, stripe_customer_id')
      .eq('id', req.userId)
      .maybeSingle();
    if (!user) return res.status(404).json({ erro: 'Usuario nao encontrado' });

    if (!user.stripe_customer_id) {
      return res.json({ plano: user.plano, has_subscription: false });
    }

    const sub = await getActiveSubscription(user.stripe_customer_id);
    if (!sub) {
      return res.json({ plano: user.plano, has_subscription: false });
    }

    res.json({
      plano: user.plano,
      has_subscription: true,
      status: sub.status,
      cancel_at_period_end: sub.cancel_at_period_end,
      current_period_end: sub.current_period_end,
      price_id: sub.items.data[0]?.price?.id,
    });
  } catch (err) {
    console.error('[stripe sub]', err.message);
    res.status(500).json({ erro: 'Erro ao consultar assinatura' });
  }
});

// Trocar plano (upgrade ou downgrade)
app.post('/api/stripe/change-plan', authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ erro: 'Stripe nao configurado' });
    const { plan } = req.body;
    if (!STRIPE_PRICES[plan]) return res.status(400).json({ erro: 'Plano invalido' });

    const { data: user } = await db.supabase
      .from('usuarios')
      .select('id, email, stripe_customer_id, plano')
      .eq('id', req.userId)
      .maybeSingle();
    if (!user) return res.status(404).json({ erro: 'Usuario nao encontrado' });
    if (!user.stripe_customer_id) return res.status(400).json({ erro: 'Voce ainda nao possui uma assinatura. Assine um plano primeiro.' });

    const sub = await getActiveSubscription(user.stripe_customer_id);
    if (!sub) return res.status(400).json({ erro: 'Nenhuma assinatura ativa encontrada' });

    const itemId = sub.items.data[0].id;
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: itemId, price: STRIPE_PRICES[plan] }],
      proration_behavior: 'always_invoice', // cobra a diferenca imediatamente
      cancel_at_period_end: false, // se estava cancelando, reativa
      metadata: { plan },
    });

    // Atualiza local imediatamente (webhook tambem vai disparar)
    await db.supabase.from('usuarios').update({ plano: plan }).eq('id', req.userId);

    res.json({ ok: true, plano: plan });
  } catch (err) {
    console.error('[stripe change-plan]', err.message);
    res.status(500).json({ erro: 'Erro ao alterar plano' });
  }
});

// Cancelar (no fim do periodo)
app.post('/api/stripe/cancel', authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ erro: 'Stripe nao configurado' });
    const { data: user } = await db.supabase
      .from('usuarios')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .maybeSingle();
    if (!user?.stripe_customer_id) return res.status(400).json({ erro: 'Sem assinatura' });

    const sub = await getActiveSubscription(user.stripe_customer_id);
    if (!sub) return res.status(400).json({ erro: 'Nenhuma assinatura ativa' });

    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
    res.json({ ok: true, cancel_at_period_end: true });
  } catch (err) {
    console.error('[stripe cancel]', err.message);
    res.status(500).json({ erro: 'Erro ao cancelar assinatura' });
  }
});

// Reativar (desfaz cancel_at_period_end)
app.post('/api/stripe/resume', authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ erro: 'Stripe nao configurado' });
    const { data: user } = await db.supabase
      .from('usuarios')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .maybeSingle();
    if (!user?.stripe_customer_id) return res.status(400).json({ erro: 'Sem assinatura' });

    const sub = await getActiveSubscription(user.stripe_customer_id);
    if (!sub) return res.status(400).json({ erro: 'Nenhuma assinatura ativa' });

    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
    res.json({ ok: true, cancel_at_period_end: false });
  } catch (err) {
    console.error('[stripe resume]', err.message);
    res.status(500).json({ erro: 'Erro ao reativar assinatura' });
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
    res.status(500).json({ erro: 'Erro ao abrir portal de pagamento' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await db.supabase
      .from('usuarios')
      .select('id, nome, email, plano, stripe_customer_id, google_email, google_refresh_token, horario_trabalho, bloqueios_json, is_admin')
      .eq('id', req.userId)
      .maybeSingle();
    if (error || !data) return res.status(404).json({ erro: 'Usuario nao encontrado' });
    // Não expor o refresh token real ao frontend — só um booleano
    const { google_refresh_token, ...safeData } = data;
    safeData.google_refresh_token = !!google_refresh_token;
    res.json(safeData);
  } catch (err) {
    console.error('[auth/me]', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// ADMIN — Painel do proprietário
// ─────────────────────────────────────────────
async function adminOnly(req, res, next) {
  try {
    const { data: user } = await db.supabase
      .from('usuarios')
      .select('is_admin')
      .eq('id', req.userId)
      .maybeSingle();
    if (!user?.is_admin) return res.status(403).json({ erro: 'Acesso restrito' });
    next();
  } catch (err) {
    console.error('[Admin] erro ao verificar permissao:', err.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

// Lista todos os usuarios
app.get('/api/admin/usuarios', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data, error } = await db.supabase
      .from('usuarios')
      .select('id, nome, email, plano, stripe_customer_id, google_email, is_admin, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Métricas gerais
app.get('/api/admin/metricas', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data: usuarios } = await db.supabase.from('usuarios').select('id, plano, created_at');
    const { data: leads } = await db.supabase.from('leads').select('id, created_at');
    const { data: imoveis } = await db.supabase.from('imoveis').select('id');
    const { data: visitas } = await db.supabase.from('visitas').select('id');

    const planos = { start: 0, pro: 0, elite: 0, sem: 0 };
    (usuarios || []).forEach(u => {
      if (u.plano && planos[u.plano] !== undefined) planos[u.plano]++;
      else planos.sem++;
    });

    // Receita estimada mensal
    const precos = { start: 49.99, pro: 149.99, elite: 249.99 };
    const receita = planos.start * precos.start + planos.pro * precos.pro + planos.elite * precos.elite;

    res.json({
      totalUsuarios: (usuarios || []).length,
      totalLeads: (leads || []).length,
      totalImoveis: (imoveis || []).length,
      totalVisitas: (visitas || []).length,
      planos,
      receitaMensal: receita.toFixed(2),
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Ver dados de um usuario especifico
app.get('/api/admin/usuarios/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data: user } = await db.supabase
      .from('usuarios')
      .select('id, nome, email, plano, stripe_customer_id, google_email, is_admin, created_at, horario_trabalho')
      .eq('id', parseInt(req.params.id))
      .maybeSingle();
    if (!user) return res.status(404).json({ erro: 'Usuario nao encontrado' });

    const { data: leads } = await db.supabase.from('leads').select('id, nome, telefone, temperatura, estagio, created_at').eq('usuario_id', user.id);
    const { data: imoveis } = await db.supabase.from('imoveis').select('id, titulo, status, created_at').eq('usuario_id', user.id);
    const { data: visitas } = await db.supabase.from('visitas').select('id, lead_nome, data, status, created_at').eq('usuario_id', user.id);

    res.json({ user, leads: leads || [], imoveis: imoveis || [], visitas: visitas || [] });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Proteger todas as rotas /api (exceto auth e webhook)
// ─────────────────────────────────────────────
// Limites por plano
const PLAN_LIMITS = {
  start: { maxLeads: 15, maxImoveis: 5, hasAI: false },
  pro:   { maxLeads: Infinity, maxImoveis: Infinity, hasAI: true },
  elite: { maxLeads: Infinity, maxImoveis: Infinity, hasAI: true },
};
function getPlanLimits(plano) {
  return PLAN_LIMITS[(plano || '').toLowerCase()] || null;
}

// Middleware: bloqueia rotas se usuario nao tem plano ativo
async function requirePlan(req, res, next) {
  try {
    const { data: user } = await db.supabase
      .from('usuarios')
      .select('plano, is_admin')
      .eq('id', req.userId)
      .maybeSingle();
    // Admin tem acesso total sem plano
    if (user?.is_admin) {
      req.userPlan = user.plano || 'elite';
      req.userLimits = getPlanLimits('elite');
      req.isAdmin = true;
      return next();
    }
    if (!user?.plano) return res.status(402).json({ erro: 'Plano necessario', code: 'NO_PLAN' });
    req.userPlan = user.plano;
    req.userLimits = getPlanLimits(user.plano);
    next();
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
}

// Middleware: requer feature de IA (Pro+)
function requireAI(req, res, next) {
  if (!req.userLimits?.hasAI) {
    return res.status(403).json({ erro: 'Agente IA disponivel apenas no plano Pro ou Elite', code: 'NEED_UPGRADE', requiredPlan: 'pro' });
  }
  next();
}

app.use('/api/imoveis', authMiddleware, requirePlan);
app.use('/api/leads', authMiddleware, requirePlan);
app.use('/api/leads-manual', authMiddleware, requirePlan);
app.use('/api/visitas', authMiddleware, requirePlan);
app.use('/api/agente', authMiddleware, requirePlan, requireAI);

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
// Calcula horários livres do corretor
// ─────────────────────────────────────────────
async function calcularHorariosLivres(userId) {
  try {
    const { data: user } = await db.supabase
      .from('usuarios')
      .select('horario_trabalho, bloqueios_json')
      .eq('id', userId)
      .maybeSingle();
    if (!user?.horario_trabalho) return null;

    const ht = user.horario_trabalho;
    const bloqueios = user.bloqueios_json || [];
    const dias = ht.dias || [1,2,3,4,5,6];
    const duracao = ht.duracao || 60;
    const especial = ht.especial || {};

    // Busca visitas dos próximos 7 dias
    const visitas = await db.listarVisitas(userId);
    const hoje = new Date();
    hoje.setHours(0,0,0,0);

    const slots = [];
    for (let d = 0; d < 7; d++) {
      const dia = new Date(hoje);
      dia.setDate(dia.getDate() + d);
      const diaSemana = dia.getDay();
      if (!dias.includes(diaSemana)) continue;

      const dataStr = dia.toISOString().slice(0, 10);
      const hDia = especial[diaSemana] || { inicio: ht.inicio || '08:00', fim: ht.fim || '18:00' };
      const [hI, mI] = hDia.inicio.split(':').map(Number);
      const [hF, mF] = hDia.fim.split(':').map(Number);
      const inicioMin = hI * 60 + mI;
      const fimMin = hF * 60 + mF;

      // Visitas já agendadas nesse dia
      const ocupados = visitas
        .filter(v => {
          let vData = v.data || '';
          if (vData.includes('/')) { const [dd,mm,yy] = vData.split('/'); vData = `${yy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`; }
          return vData === dataStr && v.status !== 'cancelada';
        })
        .map(v => {
          const [h, m] = (v.horario || '00:00').split(':').map(Number);
          return h * 60 + m;
        });

      const diasSem = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
      const livres = [];
      for (let t = inicioMin; t + duracao <= fimMin; t += duracao) {
        const hh = String(Math.floor(t/60)).padStart(2,'0');
        const mm = String(t%60).padStart(2,'0');
        const bloqueado = bloqueios.some(b => b.data === dataStr && b.hora === `${hh}:${mm}`);
        if (!bloqueado && !ocupados.some(o => Math.abs(o - t) < duracao)) {
          livres.push(`${hh}:${mm}`);
        }
      }
      if (livres.length > 0) {
        const label = d === 0 ? 'Hoje' : d === 1 ? 'Amanhã' : `${diasSem[diaSemana]} (${dataStr.slice(8,10)}/${dataStr.slice(5,7)})`;
        slots.push(`${label}: ${livres.join(', ')}`);
      }
    }
    return slots.length > 0 ? slots.join('\n') : null;
  } catch(e) { console.error('[slots]', e.message); return null; }
}

// ─────────────────────────────────────────────
// Rotas temporárias — registrar numero na Cloud API
// Remover depois do primeiro uso
// ─────────────────────────────────────────────

// Subscreve a WABA ao app (necessario pra receber webhooks)
app.get('/api/whatsapp/subscribe-app', async (req, res) => {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const wabaId = req.query.waba_id || '1695308474808789';
    if (!token) return res.status(400).json({ erro: 'WHATSAPP_TOKEN nao configurado' });

    const response = await fetch(`https://graph.facebook.com/v19.0/${wabaId}/subscribed_apps`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await response.json();
    return res.status(response.status).json({ statusHttp: response.status, data, wabaId });
  } catch (err) {
    console.error('[subscribe-app]', err);
    return res.status(500).json({ erro: err.message });
  }
});

// Lista apps subscritos numa WABA
app.get('/api/whatsapp/list-subscribed', async (req, res) => {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const wabaId = req.query.waba_id || '1695308474808789';
    if (!token) return res.status(400).json({ erro: 'WHATSAPP_TOKEN nao configurado' });

    const response = await fetch(`https://graph.facebook.com/v19.0/${wabaId}/subscribed_apps`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await response.json();
    return res.status(response.status).json({ statusHttp: response.status, data, wabaId });
  } catch (err) {
    console.error('[list-subscribed]', err);
    return res.status(500).json({ erro: err.message });
  }
});

app.get('/api/whatsapp/register', async (req, res) => {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    const pin = req.query.pin || '123456';

    if (!token || !phoneId) return res.status(400).json({ erro: 'WHATSAPP_TOKEN ou WHATSAPP_PHONE_ID nao configurado' });

    const response = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/register`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });

    const data = await response.json();
    return res.status(response.status).json({ statusHttp: response.status, data, pin });
  } catch (err) {
    console.error('[register]', err);
    return res.status(500).json({ erro: err.message });
  }
});

// Pede novo código de verificação por SMS
app.get('/api/whatsapp/request-code', async (req, res) => {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    const method = req.query.method || 'SMS'; // SMS ou VOICE

    const response = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/request_code`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code_method: method, language: 'pt_BR' }),
    });

    const data = await response.json();
    return res.status(response.status).json({ statusHttp: response.status, data });
  } catch (err) {
    console.error('[request-code]', err);
    return res.status(500).json({ erro: err.message });
  }
});

// Confirma o código recebido por SMS
app.get('/api/whatsapp/verify-code', async (req, res) => {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    const code = req.query.code;

    if (!code) return res.status(400).json({ erro: 'Passe ?code=XXXXXX na URL' });

    const response = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/verify_code`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code }),
    });

    const data = await response.json();
    return res.status(response.status).json({ statusHttp: response.status, data });
  } catch (err) {
    console.error('[verify-code]', err);
    return res.status(500).json({ erro: err.message });
  }
});

app.post('/webhook', async (req, res) => {
  // Em serverless, processamos ANTES do sendStatus pra evitar que o runtime corte a function
  if (!extrairMensagem) return res.sendStatus(200);
  const dados = extrairMensagem(req.body);
  if (!dados) return res.sendStatus(200);

  const { telefone, mensagem, messageId } = dados;
  const conversa = getConversa(telefone);

  if (conversa.mensagensProcessadas.has(messageId)) return res.sendStatus(200);
  conversa.mensagensProcessadas.add(messageId);

  console.log(`[Webhook] Nova mensagem de ${telefone}: "${mensagem}"`);
  conversa.historico.push({ role: 'user', content: mensagem });

  if (conversa.historico.length > 20) {
    conversa.historico = conversa.historico.slice(-20);
  }

  // Descobre a qual usuario atribuir (lead existente OU admin como fallback)
  let userIdDestino = null;
  const { data: leadExistente } = await db.supabase
    .from('leads')
    .select('usuario_id')
    .eq('telefone', telefone)
    .eq('origem', 'whatsapp')
    .maybeSingle();
  if (leadExistente?.usuario_id) {
    userIdDestino = leadExistente.usuario_id;
  } else {
    // Fallback: atribui ao primeiro admin do sistema
    const { data: admin } = await db.supabase
      .from('usuarios')
      .select('id')
      .eq('is_admin', true)
      .limit(1)
      .maybeSingle();
    userIdDestino = admin?.id || null;
  }

  // Bloco 1: Resposta da IA (CRÍTICO — se falhar, manda mensagem de erro)
  let respostaEnviada = false;
  try {
    let contextoHorarios = '';
    if (userIdDestino) {
      const slotsLivres = await calcularHorariosLivres(userIdDestino);
      if (slotsLivres) {
        contextoHorarios = `\n[HORÁRIOS DISPONÍVEIS PARA VISITAS]\nQuando o cliente quiser agendar uma visita, sugira estes horários:\n${slotsLivres}\n\nSempre ofereça 2-3 opções ao cliente. Se nenhum horário servir, diga que vai consultar o corretor.`;
      }
    }

    const resposta = await gerarResposta(conversa.historico, contextoHorarios || undefined);
    conversa.historico.push({ role: 'assistant', content: resposta });
    await enviarMensagem(telefone, resposta);
    respostaEnviada = true;
  } catch (err) {
    console.error(`[Webhook] Erro ao gerar/enviar resposta para ${telefone}:`, err.message);
    if (!respostaEnviada) {
      try { await enviarMensagem(telefone, 'Desculpe, tive um problema aqui. Pode repetir?'); } catch (_) {}
    }
    res.sendStatus(200);
    return;
  }

  // Bloco 2: Extração de dados e persistência (NÃO crítico — falha silenciosamente)
  try {
    const leadDataBruto = await extrairDadosLead(conversa.historico);
    const leadData = validarEAjustarLead(leadDataBruto);

    if (!userIdDestino) {
      console.error(`[Webhook] Nenhum usuario admin encontrado para atribuir lead ${telefone}`);
    } else {
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
        historico_json: JSON.stringify(conversa.historico.slice(-30)),
      }, userIdDestino);
    }

    try {
      await salvarLead(telefone, leadData, conversa.historico.filter(m => m.role === 'user').length);
    } catch (_) { /* Sheets opcional */ }

    if (notificarCorretor && leadData.temperatura === 'quente') {
      await notificarCorretor(leadData, telefone);
    }
  } catch (err) {
    console.error(`[Webhook] Erro ao extrair/salvar lead ${telefone}:`, err.message);
    // Não envia mensagem de erro — a IA já respondeu
  }

  res.sendStatus(200);
});

// ─────────────────────────────────────────────
// API — Leads WhatsApp (do Supabase)
// ─────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  try {
    const leads = await db.listarLeads('whatsapp', req.userId);
    res.json(leads.map(l => ({
      id: l.id,
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
      imovel_id: l.imovel_id || null,
      estagio: l.estagio || 'novo',
      totalMensagens: l.total_mensagens || 0,
      ultimaAtualizacao: l.updated_at ? new Date(l.updated_at).toLocaleString('pt-BR', { timeZone: 'America/Recife' }) : '--',
    })));
  } catch (err) {
    console.error('[API] Erro ao listar leads:', err.message);
    res.json([]);
  }
});

app.get('/api/leads/:telefone/conversa', async (req, res) => {
  try {
    const lead = await db.buscarLeadPorTelefone(req.params.telefone, req.userId);
    if (!lead) return res.status(404).json({ erro: 'Lead nao encontrado' });
    let historico = [];
    if (lead.historico_json) {
      try { historico = JSON.parse(lead.historico_json); } catch {}
    }
    // Fallback: se o lead está em memória, usa o histórico da memória
    if (!historico.length && conversas[req.params.telefone]) {
      historico = conversas[req.params.telefone].historico || [];
    }
    res.json({ telefone: lead.telefone, nome: lead.nome, historico });
  } catch (err) { res.status(500).json({ erro: err.message }); }
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
    // Checa limite do plano
    if (req.userLimits && req.userLimits.maxImoveis !== Infinity) {
      const atuais = await db.listarImoveis(req.userId);
      if (atuais.length >= req.userLimits.maxImoveis) {
        return res.status(403).json({
          erro: `Limite de ${req.userLimits.maxImoveis} imóveis atingido. Faça upgrade para o plano Pro para cadastrar imóveis ilimitados.`,
          code: 'LIMIT_REACHED',
          requiredPlan: 'pro',
        });
      }
    }
    const imovelData = {
      titulo, tipo,
      status: req.body.status || 'disponivel',
      endereco: req.body.endereco || '',
      bairro: req.body.bairro || '',
      cidade: req.body.cidade || '',
      valor: req.body.valor || '',
      quartos: req.body.quartos || '',
      area: req.body.area || '',
      descricao: req.body.descricao || '',
    };
    if (req.body.foto_url) imovelData.foto_url = req.body.foto_url;
    const imovel = await db.criarImovel(imovelData, req.userId);
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
      imovel_id: l.imovel_id || null,
      estagio: l.estagio || 'novo',
      origem: 'manual',
      criadoEm: l.created_at ? new Date(l.created_at).toLocaleString('pt-BR', { timeZone: 'America/Recife' }) : '--',
    })));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/leads-manual', async (req, res) => {
  const { nome, telefone } = req.body;
  if (!nome || !telefone) return res.status(400).json({ erro: 'Nome e telefone sao obrigatorios' });
  try {
    // Checa limite do plano (conta leads de todas as origens)
    if (req.userLimits && req.userLimits.maxLeads !== Infinity) {
      const todos = await db.listarLeads(null, req.userId);
      if (todos.length >= req.userLimits.maxLeads) {
        return res.status(403).json({
          erro: `Limite de ${req.userLimits.maxLeads} leads atingido. Faça upgrade para o plano Pro para leads ilimitados.`,
          code: 'LIMIT_REACHED',
          requiredPlan: 'pro',
        });
      }
    }
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
      imovel_id: req.body.imovel_id || null,
      estagio: req.body.estagio || 'novo',
      origem: 'manual',
    }, req.userId);
    res.status(201).json(lead);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/leads-manual/:id', async (req, res) => {
  try { res.json(await db.atualizarLead(parseInt(req.params.id), req.body, req.userId)); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// Atualiza estagio de qualquer lead (por ID)
app.put('/api/leads/:id/estagio', async (req, res) => {
  const { estagio } = req.body;
  if (!estagio) return res.status(400).json({ erro: 'Estagio obrigatorio' });
  try { res.json(await db.atualizarLead(parseInt(req.params.id), { estagio }, req.userId)); }
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

    // Cria evento no Google Calendar (se conectado) — em background
    criarEventoGCal(req.userId, visita).catch(e => console.error('[gcal bg]', e.message));

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
