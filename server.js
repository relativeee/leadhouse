/**
 * server.js
 * Servidor principal da LeadHouse.
 * Recebe webhooks do WhatsApp, processa com Claude e persiste no Supabase.
 */

require('dotenv').config();

// Sentry — inicializa ANTES de require('express') pra capturar erros early
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || (process.env.VERCEL_ENV || 'production'),
      release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
      tracesSampleRate: 0.1,
      // Nao envia req body por padrao (privacidade)
      sendDefaultPii: false,
    });
    console.log('[Sentry] inicializado');
  } catch (e) {
    console.warn('[Sentry] erro ao inicializar:', e.message);
    Sentry = null;
  }
}

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const db = require('./services/supabase');
const { registrar, login, authMiddleware } = require('./services/auth');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('FATAL: JWT_SECRET nao definido no .env'); process.exit(1); }
const { validarEAjustarLead } = require('./utils/leadScoring');

// Servicos opcionais (dependem de env vars externas)
let extrairMensagem, enviarMensagem, enviarImagem, notificarCorretor, notificarNovoLead;
let gerarResposta, extrairDadosLead, gerarResumoMatching;
let salvarLead;

try { ({ extrairMensagem, enviarMensagem, enviarImagem, notificarCorretor, notificarNovoLead } = require('./services/whatsapp')); } catch (e) { console.warn('[Init] WhatsApp desabilitado:', e.message); }
try { ({ gerarResposta, extrairDadosLead, gerarResumoMatching } = require('./services/claude')); } catch (e) { console.warn('[Init] Claude desabilitado:', e.message); }
try { ({ salvarLead } = require('./services/sheets')); } catch (e) { console.warn('[Init] Sheets desabilitado:', e.message); }

let emails = null;
try { emails = require('./services/emails'); } catch (e) { console.warn('[Init] emails service indisponivel:', e.message); }

let evolution = null;
try { evolution = require('./services/evolution'); } catch (e) { console.warn('[Init] evolution service indisponivel:', e.message); }

let criarToolHandlers = null;
try { ({ criarToolHandlers } = require('./services/liaTools')); } catch (e) { console.warn('[Init] liaTools indisponivel:', e.message); }

let pushService = null;
try { pushService = require('./services/push'); } catch (e) { console.warn('[Init] push service indisponivel:', e.message); }

const app = express();

// Vercel coloca um proxy na frente — precisamos confiar pra rate-limit e
// req.ip funcionarem com o header X-Forwarded-For corretamente.
app.set('trust proxy', 1);

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
          .select('id, email, nome');
        if (error) console.error('[Stripe] erro ao atualizar plano:', error.message);
        else if (!data || data.length === 0) console.error(`[Stripe] nenhum usuario encontrado para ${email} (raw: ${rawEmail})`);
        else {
          console.log(`[Stripe] plano ${plan} ativado para ${email}`);
          if (emails?.sendPaymentSuccess) {
            emails.sendPaymentSuccess({ to: data[0].email, nome: data[0].nome, plano: plan }).catch(e => console.error('[email] payment_success:', e.message));
          }
        }
      }
    }

    // Pagamento falhou (cobranca recorrente)
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      if (invoice.customer && emails?.sendPaymentFailed) {
        const { data: u } = await db.supabase.from('usuarios').select('email, nome').eq('stripe_customer_id', invoice.customer).maybeSingle();
        if (u) emails.sendPaymentFailed({ to: u.email, nome: u.nome }).catch(e => console.error('[email] payment_failed:', e.message));
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
        const { error } = await db.supabase
          .from('usuarios')
          .update({ plano: plan })
          .eq('stripe_customer_id', sub.customer);
        if (error) console.error('[Stripe] erro update subscription:', error.message);
        else console.log(`[Stripe] plano atualizado para ${plan} (customer ${sub.customer}, cancel_at_period_end=${sub.cancel_at_period_end})`);

        // Email de cancelamento agendado (cancela no fim do periodo)
        if (sub.cancel_at_period_end && emails?.sendSubscriptionCanceled) {
          const { data: u } = await db.supabase.from('usuarios').select('email, nome').eq('stripe_customer_id', sub.customer).maybeSingle();
          if (u) {
            const fimAcesso = sub.current_period_end ? sub.current_period_end * 1000 : null;
            emails.sendSubscriptionCanceled({ to: u.email, nome: u.nome, fimAcesso }).catch(e => console.error('[email] canceled:', e.message));
          }
        }
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

// Parseia string de valor ("até 500 mil", "R$ 400.000", "entre 300 e 600 mil")
// e retorna { min, max, target } em reais, ou null se nao parsear.
function parseValorLead(str) {
  if (!str) return null;
  let s = String(str).toLowerCase();
  if (s.includes('não informado') || s.includes('nao informado')) return null;
  // "entre 300 e 600 mil" -> "entre 300 mil e 600 mil"
  s = s.replace(/(\d[\d.,]*)\s+(e|a|até|ate|ou)\s+(\d[\d.,]*)\s*(milh[aã]o|milhoes|milhões|mi\b|mil|k)\b/gi, '$1 $4 $2 $3 $4');
  const re = /(\d[\d.,]*)\s*(milh[aã]o|milhoes|milhões|mi\b|mil|k)?/gi;
  const nums = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    let n = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
    if (isNaN(n)) continue;
    const u = (m[2] || '').toLowerCase();
    if (u.startsWith('milh') || u === 'mi') n *= 1000000;
    else if (u === 'mil' || u === 'k') n *= 1000;
    if (n > 0) nums.push(n);
  }
  if (nums.length === 0) return null;
  if (nums.length === 1) {
    const v = nums[0];
    return { min: v * 0.7, max: v * 1.3, target: v };
  }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return { min, max, target: (min + max) / 2 };
}

// Distancia absoluta entre valor do imovel e alvo do lead (pra ranqueamento).
function distanciaValor(valorImovelStr, alvo) {
  const parsed = parseValorLead(valorImovelStr);
  if (!parsed) return Number.POSITIVE_INFINITY;
  return Math.abs(parsed.target - alvo.target);
}

// Helper anti-repeticao + anti-saudacao. Monta bloco de contexto pra Lia.
// Robusto: combina o extractor (leadData) com regex fallback no historico
// bruto, pra cobrir caso o extractor falhe em msgs curtas tipo "pra comprar".
// Tambem detecta se Lia ja se apresentou e proibe repetir saudacao —
// os exemplos few-shot do system prompt confundem o modelo nesse ponto.
function buildAntiRepetContext(historico, leadData) {
  let ctx = '';
  const jaApresentou = (historico || []).some(m => m.role === 'assistant');
  if (jaApresentou) {
    ctx += `\n[REGRA ABSOLUTA — VOCÊ JÁ SE APRESENTOU]\nVocê JÁ disse "Oi! Aqui é a Lia, assistente do(a)..." nesta conversa. É PROIBIDO repetir saudação, se apresentar de novo ou começar com "Oi"/"Olá"/"Aqui é a Lia". Entre DIRETO no assunto.`;
  }

  const naoInformado = v => !v || v === 'não informado' || v === 'nao informado';
  const ld = leadData || {};
  const txtUser = (historico || [])
    .filter(m => m.role === 'user')
    .map(m => String(m.content || '').toLowerCase())
    .join(' ');

  let objetivo = ld.objetivo;
  if (naoInformado(objetivo)) {
    if (/\b(comprar|comprando|compra|adquirir)\b/.test(txtUser)) objetivo = 'comprar';
    else if (/\b(alugar|alugando|aluguel|locar|loca[cç][aã]o)\b/.test(txtUser)) objetivo = 'alugar';
    else if (/\b(investir|investimento)\b/.test(txtUser)) objetivo = 'investir';
  }
  let tipo = ld.tipo_imovel;
  if (naoInformado(tipo)) {
    if (/\b(apartamento|ap[eê]|apto)\b/.test(txtUser)) tipo = 'apartamento';
    else if (/\bcasa\b/.test(txtUser)) tipo = 'casa';
    else if (/\b(comercial|loja|sala)\b/.test(txtUser)) tipo = 'comercial';
    else if (/\bterreno\b/.test(txtUser)) tipo = 'terreno';
    else if (/\bcobertura\b/.test(txtUser)) tipo = 'cobertura';
  }

  const coletados = [];
  if (!naoInformado(ld.nome)) coletados.push(`nome: ${ld.nome}`);
  if (!naoInformado(objetivo)) coletados.push(`intenção: ${objetivo}`);
  if (!naoInformado(tipo)) coletados.push(`tipo de imóvel: ${tipo}`);
  if (!naoInformado(ld.bairro)) coletados.push(`bairro/região: ${ld.bairro}`);
  if (!naoInformado(ld.faixa_valor)) coletados.push(`faixa de valor: ${ld.faixa_valor}`);
  if (!naoInformado(ld.pagamento)) coletados.push(`forma de pagamento: ${ld.pagamento}`);
  if (!naoInformado(ld.prazo)) coletados.push(`prazo: ${ld.prazo}`);

  if (coletados.length) {
    ctx += `\n[DADOS JÁ COLETADOS — PROIBIDO PERGUNTAR DE NOVO]\n${coletados.join('\n')}\n\nVocê NÃO PODE perguntar nada acima. Se fizer, o cliente desiste. Use os dados pra avançar — pergunte SÓ sobre o que falta das 7 informações-chave.`;
  }

  return ctx;
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
// Usa scope NAO-SENSITIVE do Google: 'calendar.app.created' so permite ao app
// criar/ler/editar os eventos que ELE PROPRIO criou — nao precisa verificacao
// Google e qualquer corretor pode conectar sem ser test user. Em troca, nao
// conseguimos ler outros eventos do calendario do corretor (mas tambem nao
// precisamos — calcularHorariosLivres usa nosso DB local, nao o GCal).
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
].join(' ');

function googleRedirectUri(req) {
  const base = process.env.SITE_URL || `https://${req.headers.host}`;
  return `${base}/api/google/callback`;
}

// Inicia o fluxo OAuth — frontend POSTa com Bearer header e recebe a URL pra navegar.
// Antes era GET com ?token=<JWT>, mas isso vazava o JWT em logs/historico.
app.post('/api/google/auth-init', authMiddleware, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ erro: 'Google nao configurado' });
  // Quando admin impersona, conectar Google deve afetar o impersonado (req.userId), nao o admin
  const state = jwt.sign({ uid: req.userId }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
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

// ─────────────────────────────────────────────
// WHATSAPP PESSOAL via Evolution API (cada corretor escaneia QR)
// ─────────────────────────────────────────────
app.post('/api/whatsapp-personal/connect', authMiddleware, async (req, res) => {
  if (!evolution) return res.status(503).json({ erro: 'Evolution API nao configurada' });
  try {
    const result = await evolution.createInstance(req.userId);
    await db.supabase.from('usuarios').update({
      evolution_instance_name: result.instanceName,
      evolution_instance_status: 'connecting',
    }).eq('id', req.userId);
    res.json({ instanceName: result.instanceName, qrcode: result.qrcode, pairingCode: result.pairingCode });
  } catch (err) {
    console.error('[whatsapp-personal/connect]', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.get('/api/whatsapp-personal/qr', authMiddleware, async (req, res) => {
  if (!evolution) return res.status(503).json({ erro: 'Evolution API nao configurada' });
  try {
    const data = await evolution.getQRCode(req.userId);
    if (!data) return res.status(404).json({ erro: 'Sem instancia ativa' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get('/api/whatsapp-personal/status', authMiddleware, async (req, res) => {
  if (!evolution) return res.json({ state: 'not_configured' });
  try {
    const { data: u } = await db.supabase.from('usuarios').select('evolution_instance_name, evolution_instance_status, evolution_phone_number').eq('id', req.userId).maybeSingle();
    if (!u?.evolution_instance_name) return res.json({ state: 'never_connected' });
    const live = await evolution.getStatus(req.userId);
    // Sincroniza DB com estado real
    if (live.state === 'open' && u.evolution_instance_status !== 'connected') {
      await db.supabase.from('usuarios').update({ evolution_instance_status: 'connected', evolution_connected_at: new Date().toISOString() }).eq('id', req.userId);
    }
    res.json({ state: live.state, phoneNumber: u.evolution_phone_number, instanceName: u.evolution_instance_name });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/whatsapp-personal/disconnect', authMiddleware, async (req, res) => {
  if (!evolution) return res.status(503).json({ erro: 'Evolution API nao configurada' });
  try {
    await evolution.deleteInstance(req.userId);
    await db.supabase.from('usuarios').update({
      evolution_instance_name: null,
      evolution_instance_status: 'disconnected',
      evolution_phone_number: null,
      evolution_connected_at: null,
    }).eq('id', req.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─────────────────────────────────────────────
// Push Notifications (Web Push API)
// ─────────────────────────────────────────────
// GET /api/push/key — frontend pega a public VAPID key pra subscribe()
app.get('/api/push/key', (req, res) => {
  if (!pushService?.disponivel()) {
    const diag = pushService?.diagnostico?.() || { erro: 'pushService nao carregou' };
    return res.status(503).json({ erro: 'Push desabilitado', diagnostico: diag });
  }
  res.json({ publicKey: pushService.publicKey() });
});

// GET /api/push/debug — diagnostico publico (so booleans, nao expõe keys)
app.get('/api/push/debug', (req, res) => {
  if (!pushService) return res.json({ moduleLoaded: false });
  res.json({ moduleLoaded: true, ...pushService.diagnostico() });
});

// POST /api/push/subscribe — salva a subscription do device do corretor
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  if (!pushService?.disponivel()) return res.status(503).json({ erro: 'Push desabilitado' });
  try {
    const sub = req.body?.subscription;
    if (!sub) return res.status(400).json({ erro: 'subscription ausente' });
    const ua = req.headers['user-agent'] || null;
    await pushService.salvarSubscription(req.userId, sub, ua);
    res.json({ ok: true });
  } catch (err) {
    console.error('[push.subscribe]', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/push/unsubscribe — remove subscription (corretor desativou push)
app.post('/api/push/unsubscribe', authMiddleware, async (req, res) => {
  try {
    await pushService?.removerSubscription(req.body?.endpoint);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// GET /api/push/my-subs — quantas subscriptions o usuario tem salvas (autenticado)
app.get('/api/push/my-subs', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await db.supabase
      .from('push_subscriptions')
      .select('id, endpoint, user_agent, created_at, last_used_at')
      .eq('usuario_id', req.userId);
    if (error) return res.status(500).json({ erro: error.message, code: error.code, hint: error.hint });
    res.json({
      userId: req.userId,
      total: data?.length || 0,
      subs: (data || []).map(s => ({
        id: s.id,
        endpointHost: (() => { try { return new URL(s.endpoint).hostname; } catch { return '?'; } })(),
        endpointTail: (s.endpoint || '').slice(-16),
        userAgent: (s.user_agent || '').slice(0, 60),
        created_at: s.created_at,
        last_used_at: s.last_used_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/push/test — envia push de teste pro proprio corretor (debug/UX)
app.post('/api/push/test', authMiddleware, async (req, res) => {
  if (!pushService?.disponivel()) return res.status(503).json({ erro: 'Push desabilitado' });
  try {
    const r = await pushService.sendPushParaCorretor(req.userId, {
      title: '✅ Notificações ativadas',
      body: 'Você vai ser avisado aqui sempre que um lead novo chegar ou a Lia agendar uma visita.',
      url: '/',
      tag: 'test',
    });
    res.json(r);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Webhook que a Evolution chama quando algo acontece (mensagem recebida, conexao mudou, etc.)
app.post('/webhook/evolution', async (req, res) => {
  // IMPORTANTE: NAO chamar res.json() no comeco. Em serverless do Vercel a funcao
  // pode ser morta logo apos a resposta — precisamos terminar tudo antes de responder.
  try {
    const event = req.body?.event;
    const instanceName = req.body?.instance;
    if (!event || !instanceName) return res.json({ received: true });

    // Identifica o usuario dono dessa instancia
    const { data: user } = await db.supabase
      .from('usuarios')
      .select('id, nome, email, evolution_phone_number')
      .eq('evolution_instance_name', instanceName)
      .maybeSingle();
    if (!user) {
      console.warn('[evolution webhook] instancia sem dono:', instanceName);
      return res.json({ received: true });
    }

    if (event === 'connection.update' || event === 'CONNECTION_UPDATE') {
      const state = req.body?.data?.state;
      const me = req.body?.data?.wuid || req.body?.data?.user?.id || null;
      const phoneNumber = me ? me.split('@')[0] : null;
      const updates = { evolution_instance_status: state === 'open' ? 'connected' : (state || 'disconnected') };
      if (phoneNumber) updates.evolution_phone_number = phoneNumber;
      if (state === 'open') updates.evolution_connected_at = new Date().toISOString();
      await db.supabase.from('usuarios').update(updates).eq('id', user.id);
      return res.json({ received: true });
    }

    if (event === 'messages.upsert' || event === 'MESSAGES_UPSERT') {
      const msg = req.body?.data;
      if (!msg || msg.key?.fromMe) return res.json({ received: true });
      const remoteJid = msg.key?.remoteJid || '';
      if (remoteJid.endsWith('@g.us')) return res.json({ received: true });
      const telefone = remoteJid.split('@')[0];
      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!texto.trim()) return res.json({ received: true });

      // Dedup por messageId
      const messageId = msg.key?.id;
      const conversa = getConversa(telefone);
      if (messageId && conversa.mensagensProcessadas.has(messageId)) return res.json({ received: true });
      if (messageId) conversa.mensagensProcessadas.add(messageId);

      // SERVERLESS: SEMPRE recarrega do DB antes de processar.
      // O Vercel cria multiplas instances da funcao — o conversa.historico em
      // memoria de uma instance pode estar STALE (mais antigo que o DB). Se nao
      // recarregar, instance A processa msg 1, instance B salva msg 1-2-3,
      // instance A reusa cache antigo (so msg 1) e a Lia "esquece" 2 e 3.
      // Custo: +1 SELECT por mensagem (~50ms), inevitavel em serverless.
      try {
        const { data: leadAnterior } = await db.supabase
          .from('leads')
          .select('historico_json')
          .eq('telefone', telefone)
          .eq('usuario_id', user.id)
          .eq('origem', 'whatsapp')
          .maybeSingle();
        if (leadAnterior?.historico_json) {
          const parsed = JSON.parse(leadAnterior.historico_json);
          // Formato novo: { v: 2, messages: [...], imoveisEnviados: [...] }
          // Formato antigo (compat): [...] direto
          if (Array.isArray(parsed)) {
            conversa.historico = parsed;
          } else if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.messages)) conversa.historico = parsed.messages;
            if (Array.isArray(parsed.imoveisEnviados)) {
              conversa.imoveisEnviados = new Set(parsed.imoveisEnviados);
            }
          }
        } else {
          // Sem registro no DB — eh lead novo (1a mensagem mesmo). Reseta o
          // historico in-memory que pode estar stale de outra conversa.
          conversa.historico = [];
          conversa.imoveisEnviados = new Set();
        }
      } catch (e) {
        console.warn(`[evolution] falha ao carregar historico de ${telefone}:`, e.message);
      }

      console.log(`[evolution] msg user=${user.id} de=${telefone}: "${texto}" (hist=${conversa.historico.length})`);
      conversa.historico.push({ role: 'user', content: texto });
      // 40 mensagens = ~20 trocas. Conversa de qualificacao chega facil em 10-15 trocas
      // antes de oferecer visita; manter contexto evita Lia repetir perguntas.
      if (conversa.historico.length > 40) conversa.historico = conversa.historico.slice(-40);

      // Cache de imoveis ja oferecidos nesse contato (vem do DB se carregou)
      if (!conversa.imoveisEnviados) conversa.imoveisEnviados = new Set();

      // Bloco PRE-RESPOSTA: extrai dados pra decidir se tem imovel pra oferecer
      // (resultado tambem reaproveitado no Bloco 4 — economiza 1 chamada Claude ~3s)
      let contextoImoveis = '';
      let imovelParaEnviar = null;
      let imovelEhAlternativo = false;
      let leadDataExtraida = null;
      try {
        if (extrairDadosLead && validarEAjustarLead) {
          const bruto = await extrairDadosLead(conversa.historico);
          const leadData = validarEAjustarLead(bruto);
          leadDataExtraida = leadData;
          const bairroLead = (leadData.bairro || '').trim();
          if (bairroLead && bairroLead !== 'não informado') {
            const tipoLead = (leadData.tipo_imovel || '').trim().toLowerCase();
            const valorAlvo = parseValorLead(leadData.faixa_valor);

            // 1) Tenta no bairro exato
            const { data: imoveisBairro } = await db.supabase
              .from('imoveis')
              .select('*')
              .eq('usuario_id', user.id)
              .eq('status', 'disponivel')
              .ilike('bairro', `%${bairroLead}%`);

            let candidatos = (imoveisBairro || []).filter(i => i.foto_url && !conversa.imoveisEnviados.has(i.id));
            if (tipoLead && tipoLead !== 'não informado') {
              const porTipo = candidatos.filter(i => (i.tipo || '').toLowerCase().includes(tipoLead));
              if (porTipo.length > 0) candidatos = porTipo;
            }

            if (candidatos.length === 1) {
              imovelParaEnviar = candidatos[0];
            } else if (candidatos.length >= 2) {
              contextoImoveis = `\n[VÁRIOS IMÓVEIS DISPONÍVEIS]\nTem ${candidatos.length} imóveis disponíveis em ${bairroLead}. Antes de oferecer opções, pergunte ao cliente detalhes pra refinar — faixa de valor e quantos quartos. Não envie opções agora, só faça 1 pergunta pra estreitar.`;
            } else {
              // 2) Fallback: nada no bairro exato — busca alternativo
              const { data: imoveisTodos } = await db.supabase
                .from('imoveis')
                .select('*')
                .eq('usuario_id', user.id)
                .eq('status', 'disponivel');

              let alternativos = (imoveisTodos || []).filter(i => i.foto_url && !conversa.imoveisEnviados.has(i.id));
              if (tipoLead && tipoLead !== 'não informado') {
                const porTipo = alternativos.filter(i => (i.tipo || '').toLowerCase().includes(tipoLead));
                if (porTipo.length > 0) alternativos = porTipo;
              }
              if (valorAlvo && alternativos.length > 1) {
                alternativos = alternativos
                  .map(i => ({ i, d: distanciaValor(i.valor, valorAlvo) }))
                  .sort((a, b) => a.d - b.d)
                  .map(x => x.i);
              }
              if (alternativos.length > 0) {
                imovelParaEnviar = alternativos[0];
                imovelEhAlternativo = true;
              }
            }

            if (imovelParaEnviar) {
              const detalhes = [imovelParaEnviar.titulo, imovelParaEnviar.bairro];
              if (imovelParaEnviar.valor) detalhes.push(`R$ ${imovelParaEnviar.valor}`);
              if (imovelParaEnviar.quartos) detalhes.push(`${imovelParaEnviar.quartos} quartos`);
              if (imovelEhAlternativo) {
                contextoImoveis = `\n[IMÓVEL ALTERNATIVO PRA OFERECER]\nNão temos imóvel disponível no bairro "${bairroLead}" no momento. Logo após sua próxima mensagem, o sistema vai enviar automaticamente a foto de um imóvel parecido: ${detalhes.join(' · ')}. Na sua resposta, seja honesta: diga que nesse bairro específico não tem no momento, mas tem esse outro com características parecidas em ${imovelParaEnviar.bairro}, e que vai mandar a foto pra ele ver. Pergunte se o bairro ${imovelParaEnviar.bairro} também pode interessar. Não descreva a foto — ela vai junto.`;
              } else {
                contextoImoveis = `\n[IMÓVEL PRA OFERECER]\nLogo após sua próxima mensagem, o sistema vai enviar automaticamente uma foto do imóvel: ${detalhes.join(' · ')}. Na sua resposta, mencione que tem esse imóvel em ${bairroLead} e está mandando a foto pra ele ver. Pergunte se gostou ou se quer mais detalhes. Não descreva a foto em texto — ela vai junto.`;
              }
            }
          }
        }
      } catch (err) {
        console.error(`[evolution] erro pre-resposta (busca imovel):`, err.message);
      }

      // Bloco 1: Lia gera resposta
      let resposta;
      try {
        if (!gerarResposta || !evolution) {
          console.warn('[evolution] Lia ou evolution service indisponivel');
          return res.json({ received: true });
        }

        // Monta contextoExtra com:
        // 1. Dados ja coletados (pra Lia NAO repetir perguntas — instrucao explicita)
        // 2. Horarios livres (pra oferecer slot real)
        // 3. Imoveis pra oferecer
        let contextoExtra = '';

        // Bloco anti-repeticao + anti-saudacao (combina extractor + regex fallback).
        // Excluindo a mensagem do usuario que acabou de chegar — o helper detecta
        // "ja apresentou" pela presenca de assistant msgs, que conta corretamente.
        contextoExtra += buildAntiRepetContext(conversa.historico, leadDataExtraida);

        try {
          const slotsLivres = await calcularHorariosLivres(user.id);
          if (slotsLivres) {
            contextoExtra += `\n[HORÁRIOS DISPONÍVEIS PARA VISITAS]\nQuando o cliente quiser agendar uma visita, sugira estes horários:\n${slotsLivres}\n\nSempre ofereça 2-3 opções ao cliente. Se nenhum horário servir, diga que vai consultar o corretor.`;
          }
        } catch (e) {
          console.warn(`[evolution] erro calcularHorariosLivres:`, e.message);
        }
        if (contextoImoveis) contextoExtra += contextoImoveis;

        const primeiroNome = (user.nome || '').trim().split(/\s+/)[0] || 'seu corretor';

        // Tool handlers (imoveis + enviando_arquivos) — Lia decide quando acionar.
        // sendImage usa evolution.sendImage com o instance do corretor.
        const toolHandlers = criarToolHandlers ? criarToolHandlers({
          userId: user.id,
          telefone,
          conversa,
          db,
          sendImage: (tel, urlOuB64, caption) => evolution.sendImage(user.id, tel, urlOuB64, caption),
        }) : undefined;

        const respLia = await gerarResposta(conversa.historico, contextoExtra || undefined, {
          nomeCorretor: primeiroNome,
          toolHandlers,
        });
        resposta = respLia.texto;
        if (respLia.toolsExecutadas?.length) {
          console.log(`[evolution] tools acionadas:`, respLia.toolsExecutadas.map(t => `${t.nome}(${JSON.stringify(t.input)})`).join(', '));
        }
        conversa.historico.push({ role: 'assistant', content: resposta });
      } catch (err) {
        console.error(`[evolution] erro ao gerar resposta pra ${telefone}:`, err.message);
        try { await evolution.sendText(user.id, telefone, 'Desculpe, tive um problema aqui. Pode repetir?'); } catch {}
        return res.json({ received: true });
      }

      // Bloco 2: SALVA HISTORICO ANTES de mandar — garante persistencia mesmo se Evolution falhar
      // ou se o Vercel matar a funcao depois. Aba Comunicacoes le dessa coluna.
      const totalMsgsUser = conversa.historico.filter(m => m.role === 'user').length;
      // Formato novo: serializa historico + imoveis ja oferecidos (evita re-mandar mesma foto em cold starts)
      const buildHistoricoJson = () => JSON.stringify({
        v: 2,
        messages: conversa.historico.slice(-40),
        imoveisEnviados: Array.from(conversa.imoveisEnviados || []),
      });
      let isNovoLead = false;
      try {
        // Detecta lead novo: se totalMsgsUser === 1, e a primeira mensagem desse contato
        // (apos cold start, historico_json ja teria mais mensagens).
        isNovoLead = totalMsgsUser === 1;
        await db.upsertLeadWhatsApp(telefone, {
          nome: msg.pushName || '',
          temperatura: 'frio',
          total_mensagens: totalMsgsUser,
          historico_json: buildHistoricoJson(),
        }, user.id);
      } catch (err) {
        console.error(`[evolution] erro ao salvar historico ${telefone}:`, err.message);
      }

      // Push notification pro corretor — dispara em TODA mensagem do cliente.
      // 1a mensagem: "🔥 entrou em contato" (lead novo, urgencia).
      // Demais: "💬 [Nome]" — apenas atualizacao.
      // Tag por telefone faz a notif do mesmo lead SUBSTITUIR a anterior,
      // evitando empilhar 10 push numa conversa rapida.
      if (pushService?.disponivel()) {
        const nomeLead = msg.pushName || 'Lead';
        const previa = texto.length > 80 ? texto.slice(0, 77) + '...' : texto;
        const title = isNovoLead
          ? `🔥 ${nomeLead} entrou em contato`
          : `💬 ${nomeLead}`;
        pushService.sendPushParaCorretor(user.id, {
          title,
          body: previa,
          url: '/?tab=comunicacoes',
          tag: `lead-${telefone}`,
        }).catch(e => console.error('[push msg evolution]', e.message));
      }

      // Bloco 3: Envia resposta via Evolution
      try {
        await evolution.sendText(user.id, telefone, resposta);
      } catch (err) {
        console.error(`[evolution] erro ao enviar via Evolution pra ${telefone}:`, err.message);
      }

      // Bloco 3b: Fallback de foto — se Lia NAO acionou enviando_arquivos via tool,
      // mas o pre-resposta achou um imovel compativel, manda foto + caption.
      // (Tool ja adiciona o id em conversa.imoveisEnviados — o check abaixo evita duplicata.)
      if (imovelParaEnviar && evolution.sendImage && !conversa.imoveisEnviados.has(imovelParaEnviar.id)) {
        try {
          const capParts = [imovelParaEnviar.titulo];
          if (imovelParaEnviar.bairro) capParts.push(imovelParaEnviar.bairro);
          if (imovelParaEnviar.valor) capParts.push(`R$ ${imovelParaEnviar.valor}`);
          if (imovelParaEnviar.quartos) capParts.push(`${imovelParaEnviar.quartos} quartos`);
          if (imovelParaEnviar.vagas) capParts.push(`${imovelParaEnviar.vagas} vagas`);
          if (imovelParaEnviar.area) capParts.push(`${imovelParaEnviar.area}m²`);
          const caption = capParts.join(' · ');
          await evolution.sendImage(user.id, telefone, imovelParaEnviar.foto_url, caption);
          conversa.imoveisEnviados.add(imovelParaEnviar.id);
        } catch (err) {
          console.error(`[evolution] erro ao enviar foto do imovel ${imovelParaEnviar.id}:`, err.message);
        }
      }

      // Bloco 4: Enriquece lead com leadData ja extraida no pre-resposta (sem novo Claude call).
      // Se a extracao falhou la, pula esse bloco — historico ja foi salvo no Bloco 2.
      try {
        if (leadDataExtraida) {
          const ld = leadDataExtraida;
          await db.upsertLeadWhatsApp(telefone, {
            nome: ld.nome || msg.pushName || '',
            objetivo: ld.objetivo || '',
            tipo_imovel: ld.tipo_imovel || '',
            bairro: ld.bairro || '',
            faixa_valor: ld.faixa_valor || '',
            pagamento: ld.pagamento || '',
            prazo: ld.prazo || '',
            temperatura: ld.temperatura || 'frio',
            proximo_passo: ld.proximo_passo || '',
            resumo: ld.resumo || '',
            total_mensagens: totalMsgsUser,
            historico_json: buildHistoricoJson(),
          }, user.id);
        }
      } catch (err) {
        console.error(`[evolution] erro upsert enriquecido ${telefone}:`, err.message);
      }

      // Bloco 5: Cria visita automaticamente se Lia agendou (visita_agendada.confirmada)
      try {
        const va = leadDataExtraida?.visita_agendada;
        if (
          va && va.confirmada === true &&
          va.data && va.data !== 'não' && /^\d{4}-\d{2}-\d{2}$/.test(va.data) &&
          va.horario && va.horario !== 'não' && /^\d{2}:\d{2}$/.test(va.horario)
        ) {
          // Evita duplicar
          const { data: jaExiste } = await db.supabase
            .from('visitas')
            .select('id')
            .eq('usuario_id', user.id)
            .eq('lead_telefone', telefone)
            .eq('data', va.data)
            .eq('horario', va.horario)
            .maybeSingle();
          if (!jaExiste) {
            const novaVisita = await db.criarVisita({
              lead_nome: leadDataExtraida.nome && leadDataExtraida.nome !== 'não informado' ? leadDataExtraida.nome : (msg.pushName || 'Lead WhatsApp'),
              lead_telefone: telefone,
              imovel_titulo: va.imovel_titulo && va.imovel_titulo !== 'não especificado' ? va.imovel_titulo : '',
              endereco: '',
              data: va.data,
              horario: va.horario,
              corretor: user.nome || '',
              observacoes: 'Agendada automaticamente pela Lia via WhatsApp',
              status: 'agendada',
            }, user.id);
            console.log(`[evolution] visita agendada automaticamente: ${telefone} em ${va.data} ${va.horario}`);
            // Cria evento no Google Calendar do corretor (se conectado)
            criarEventoGCal(user.id, novaVisita).catch(e => console.error('[gcal evolution]', e.message));
            // Push notification pro corretor: visita agendada pela Lia
            if (pushService?.disponivel()) {
              const nomeLead = novaVisita.lead_nome || 'Lead';
              const dataBr = va.data.split('-').reverse().join('/');
              pushService.sendPushParaCorretor(user.id, {
                title: '📅 Lia agendou uma visita',
                body: `${nomeLead} — ${dataBr} às ${va.horario}${novaVisita.imovel_titulo ? ' · ' + novaVisita.imovel_titulo : ''}`,
                url: '/?tab=visitas',
                tag: `visita-${novaVisita.id}`,
              }).catch(e => console.error('[push visita evolution]', e.message));
            }
          }
        }
      } catch (err) {
        console.error(`[evolution] erro criar visita ${telefone}:`, err.message);
      }

      return res.json({ received: true });
    }
    // Evento desconhecido (qrcode_updated, etc) — apenas confirma recebimento
    return res.json({ received: true });
  } catch (err) {
    console.error('[evolution webhook] erro:', err.message);
    if (Sentry) Sentry.captureException(err);
    if (!res.headersSent) res.status(500).json({ erro: 'erro interno' });
  }
});

// ─────────────────────────────────────────────
// WHATSAPP — status (corretor "conectado" se tem conversas)
// ─────────────────────────────────────────────
app.get('/api/whatsapp/status', authMiddleware, async (req, res) => {
  try {
    const { count } = await db.supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', req.userId)
      .eq('origem', 'whatsapp');
    res.json({ connected: (count || 0) > 0, leadsCount: count || 0 });
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
      .select('id, nome, email, plano, stripe_customer_id, google_email, google_refresh_token, horario_trabalho, bloqueios_json, is_admin, trial_expires_at')
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
  // Sempre consulta DB pra revogacao ser imediata (nao confia no JWT cache de 7 dias).
  // Custo: +1 query somente em rotas /api/admin/*, raras.
  try {
    const realId = req.realUserId || req.userId;
    const { data: user } = await db.supabase
      .from('usuarios')
      .select('is_admin')
      .eq('id', realId)
      .maybeSingle();
    if (!user?.is_admin) return res.status(403).json({ erro: 'Acesso restrito' });
    req.isAdmin = true;
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

// Audit log de impersonation (admin ve tudo que foi feito atuando como outros)
app.get('/api/admin/audit', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data, error } = await db.supabase
      .from('admin_audit_log')
      .select('id, real_user_id, acting_as_user_id, method, path, ip, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────
// CRON — trial expirando (Vercel Cron diario 13:00 UTC = 10:00 Fortaleza)
// ─────────────────────────────────────────────
app.get('/api/cron/trial-expiring', async (req, res) => {
  // Auth dupla: (a) CRON_SECRET via Bearer (Vercel injeta automaticamente se setado),
  // OU (b) User-Agent vercel-cron/* quando CRON_SECRET nao esta configurado.
  // (b) eh fallback aceito pelo proprio Vercel quando CRON_SECRET ausente.
  const expected = (process.env.CRON_SECRET || '').trim();
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const isVercelCron = ua.includes('vercel-cron');
  const authOk = (expected && provided === expected) || (!expected && isVercelCron);
  if (!authOk) {
    return res.status(401).json({ erro: 'Acesso negado' });
  }
  if (!emails) return res.json({ enviados: 0, motivo: 'emails service indisponivel' });

  try {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // Janela de 1 dia centrada nos marcos 3 dias e 1 dia restantes
    const ranges = [
      { dias: 3, since: new Date(now + 3 * day - 12 * 60 * 60 * 1000).toISOString(), until: new Date(now + 3 * day + 12 * 60 * 60 * 1000).toISOString() },
      { dias: 1, since: new Date(now + 1 * day - 12 * 60 * 60 * 1000).toISOString(), until: new Date(now + 1 * day + 12 * 60 * 60 * 1000).toISOString() },
    ];
    let total = 0;
    for (const r of ranges) {
      const { data: users } = await db.supabase
        .from('usuarios')
        .select('email, nome')
        .eq('plano', 'trial')
        .gte('trial_expires_at', r.since)
        .lt('trial_expires_at', r.until);
      for (const u of users || []) {
        await emails.sendTrialExpiring({ to: u.email, nome: u.nome, diasRestantes: r.dias }).catch(e => console.error('[cron] trial email:', e.message));
        total++;
      }
    }
    res.json({ enviados: total });
  } catch (err) {
    console.error('[cron trial-expiring]', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Resumo do audit log autenticado por shared secret (usado por routines/cron externos).
// Compare timing-safe pra evitar leak via timing.
app.get('/api/admin/audit-summary', async (req, res) => {
  try {
    const secret = process.env.ADMIN_AUDIT_SECRET;
    if (!secret) return res.status(503).json({ erro: 'Endpoint nao configurado' });
    const provided = String(req.query.key || '');
    if (provided.length !== secret.length) return res.status(401).json({ erro: 'Acesso negado' });
    const secretBuf = Buffer.from(secret, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');
    if (!crypto.timingSafeEqual(secretBuf, providedBuf)) {
      return res.status(401).json({ erro: 'Acesso negado' });
    }

    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await db.supabase
      .from('admin_audit_log')
      .select('id, real_user_id, acting_as_user_id, method, path, ip, user_agent, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Resolve nomes dos usuarios envolvidos
    const userIds = [...new Set((data || []).flatMap(r => [r.real_user_id, r.acting_as_user_id]))];
    let userMap = {};
    if (userIds.length) {
      const { data: users } = await db.supabase
        .from('usuarios')
        .select('id, nome, email')
        .in('id', userIds);
      userMap = Object.fromEntries((users || []).map(u => [u.id, { nome: u.nome, email: u.email }]));
    }

    res.json({
      since,
      days,
      total: data?.length || 0,
      events: (data || []).map(r => ({
        ...r,
        real_user: userMap[r.real_user_id] || null,
        acting_as_user: userMap[r.acting_as_user_id] || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
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

// Excluir usuario (admin only). Cancela Stripe, derruba instancia Evolution,
// apaga dados em ordem de dependencia e por fim o registro do usuario.
// Body: { senha: "<senha do admin>" } — autentica a acao.
app.delete('/api/admin/usuarios/:id', authMiddleware, adminOnly, async (req, res) => {
  const senha = req.body?.senha;
  if (!senha || typeof senha !== 'string') {
    return res.status(400).json({ erro: 'Envie { "senha": "..." } no body' });
  }
  const targetId = parseInt(req.params.id, 10);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    return res.status(400).json({ erro: 'ID invalido' });
  }
  // Nao permitir excluir a si mesmo nem outros admins (evita lockout)
  if (targetId === req.realUserId) {
    return res.status(403).json({ erro: 'Nao pode excluir sua propria conta por aqui' });
  }
  try {
    // Verifica senha do admin (autenticacao da acao destrutiva)
    const { data: admin } = await db.supabase
      .from('usuarios')
      .select('senha_hash')
      .eq('id', req.realUserId)
      .maybeSingle();
    if (!admin?.senha_hash) {
      return res.status(401).json({ erro: 'Admin nao tem senha configurada' });
    }
    const bcrypt = require('bcryptjs');
    const senhaOk = await bcrypt.compare(senha, admin.senha_hash);
    if (!senhaOk) {
      return res.status(401).json({ erro: 'Senha incorreta' });
    }

    const { data: alvo } = await db.supabase
      .from('usuarios')
      .select('id, email, is_admin, stripe_customer_id, evolution_instance_name')
      .eq('id', targetId)
      .maybeSingle();
    if (!alvo) return res.status(404).json({ erro: 'Usuario nao encontrado' });
    if (alvo.is_admin) {
      return res.status(403).json({ erro: 'Nao e possivel excluir outro admin pelo painel' });
    }

    // Cancela Stripe se existir
    if (stripe && alvo.stripe_customer_id) {
      try {
        const subs = await stripe.subscriptions.list({ customer: alvo.stripe_customer_id, status: 'active' });
        for (const sub of subs.data) await stripe.subscriptions.cancel(sub.id);
      } catch (e) { console.error('[admin/excluir] Stripe:', e.message); }
    }

    // Derruba instancia Evolution se existir
    if (evolution && alvo.evolution_instance_name) {
      try { await evolution.deleteInstance(targetId); } catch (e) { console.error('[admin/excluir] Evolution:', e.message); }
    }

    // Apaga dependentes primeiro
    await db.supabase.from('leads').delete().eq('usuario_id', targetId);
    await db.supabase.from('imoveis').delete().eq('usuario_id', targetId);
    await db.supabase.from('visitas').delete().eq('usuario_id', targetId);
    await db.supabase.from('password_resets').delete().eq('user_id', targetId);
    await db.supabase.from('usuarios').delete().eq('id', targetId);

    console.log(`[admin/excluir] admin=${req.realUserId} (${req.realUserEmail}) excluiu user=${targetId} (${alvo.email})`);

    res.json({ ok: true, deletedId: targetId, deletedEmail: alvo.email });
  } catch (err) {
    console.error('[admin/excluir]', err.message);
    res.status(500).json({ erro: err.message });
  }
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
    // Admin (mesmo impersonando) tem acesso total sem restricao de plano
    if (req.isAdmin) {
      req.userPlan = 'elite';
      req.userLimits = getPlanLimits('elite');
      return next();
    }
    // Fallback pra tokens antigos sem is_admin claim: cheque o usuario real (nao o impersonado)
    const realId = req.realUserId || req.userId;
    if (realId !== req.userId) {
      const { data: realUser } = await db.supabase
        .from('usuarios')
        .select('is_admin')
        .eq('id', realId)
        .maybeSingle();
      if (realUser?.is_admin) {
        req.userPlan = 'elite';
        req.userLimits = getPlanLimits('elite');
        req.isAdmin = true;
        return next();
      }
    }
    const { data: user } = await db.supabase
      .from('usuarios')
      .select('plano, is_admin, trial_expires_at')
      .eq('id', req.userId)
      .maybeSingle();
    if (user?.is_admin) {
      req.userPlan = user.plano || 'elite';
      req.userLimits = getPlanLimits('elite');
      req.isAdmin = true;
      return next();
    }
    // Trial ativo: trata como pro (acesso completo + IA)
    if (user?.plano === 'trial') {
      const expiresAt = user.trial_expires_at ? new Date(user.trial_expires_at).getTime() : 0;
      if (expiresAt > Date.now()) {
        req.userPlan = 'trial';
        req.userLimits = getPlanLimits('pro');
        req.isTrial = true;
        return next();
      }
      // Trial expirou
      return res.status(402).json({ erro: 'Trial expirado', code: 'TRIAL_EXPIRED' });
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
        const nomeDia = d === 0 ? 'Hoje' : d === 1 ? 'Amanhã' : diasSem[diaSemana];
        slots.push(`${dataStr} (${nomeDia}): ${livres.join(', ')}`);
      }
    }
    return slots.length > 0 ? slots.join('\n') : null;
  } catch(e) { console.error('[slots]', e.message); return null; }
}

app.post('/webhook', async (req, res) => {
  // Em serverless, processamos ANTES do sendStatus pra evitar que o runtime corte a function
  if (!extrairMensagem) return res.sendStatus(200);
  const dados = extrairMensagem(req.body);
  if (!dados) return res.sendStatus(200);

  const { telefone, mensagem, messageId } = dados;
  const conversa = getConversa(telefone);

  if (conversa.mensagensProcessadas.has(messageId)) return res.sendStatus(200);
  conversa.mensagensProcessadas.add(messageId);

  // SERVERLESS: SEMPRE recarrega do DB. Vercel reusa instances entre cold
  // starts — confiar no conversa.historico em memoria gera "stale state"
  // (instance A com cache antigo nao ve mensagens salvas pela instance B).
  // Custo: +1 SELECT por mensagem (~50ms), inevitavel em serverless.
  try {
    const { data: leadAnterior } = await db.supabase
      .from('leads')
      .select('historico_json')
      .eq('telefone', telefone)
      .eq('origem', 'whatsapp')
      .maybeSingle();
    if (leadAnterior?.historico_json) {
      const parsed = JSON.parse(leadAnterior.historico_json);
      // Compat: array (formato antigo) OU objeto { messages, imoveisEnviados } (novo)
      if (Array.isArray(parsed) && parsed.length) {
        conversa.historico = parsed;
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)) {
        conversa.historico = parsed.messages;
      }
    } else {
      // Sem registro no DB — lead novo. Reseta in-memory que pode estar stale.
      conversa.historico = [];
    }
  } catch (e) {
    console.warn(`[Webhook] Falha ao carregar historico do Supabase para ${telefone}:`, e.message);
  }

  console.log(`[Webhook] Nova mensagem de ${telefone}: "${mensagem}" (historico: ${conversa.historico.length})`);
  conversa.historico.push({ role: 'user', content: mensagem });

  if (conversa.historico.length > 20) {
    conversa.historico = conversa.historico.slice(-20);
  }

  // Descobre a qual usuario atribuir (lead existente OU admin como fallback)
  let userIdDestino = null;
  const { data: leadExistente } = await db.supabase
    .from('leads')
    .select('id, usuario_id')
    .eq('telefone', telefone)
    .eq('origem', 'whatsapp')
    .maybeSingle();
  const isLeadNovo = !leadExistente;
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

  // Busca o nome do corretor pra injetar no prompt da Lia
  // Usa primeiro nome — soa mais natural no WhatsApp brasileiro
  let nomeCorretor = null;
  if (userIdDestino) {
    const { data: corretor } = await db.supabase
      .from('usuarios')
      .select('nome')
      .eq('id', userIdDestino)
      .maybeSingle();
    if (corretor?.nome) nomeCorretor = corretor.nome.trim().split(/\s+/)[0] || null;
  }

  // Extração pré-resposta: permite Lia saber quais imoveis oferecer
  if (!conversa.imoveisEnviados) conversa.imoveisEnviados = new Set();
  let leadData = null;
  let contextoImoveis = '';
  let imovelParaEnviar = null;
  let imovelEhAlternativo = false;
  try {
    const leadDataBruto = await extrairDadosLead(conversa.historico);
    leadData = validarEAjustarLead(leadDataBruto);

    const bairroLead = (leadData.bairro || '').trim();
    if (userIdDestino && bairroLead && bairroLead !== 'não informado') {
      const tipoLead = (leadData.tipo_imovel || '').trim().toLowerCase();
      const valorAlvo = parseValorLead(leadData.faixa_valor);

      // 1) Tentativa no bairro exato
      const { data: imoveisBairro } = await db.supabase
        .from('imoveis')
        .select('*')
        .eq('usuario_id', userIdDestino)
        .eq('status', 'disponivel')
        .ilike('bairro', `%${bairroLead}%`);

      let candidatos = (imoveisBairro || []).filter(i => i.foto_url && !conversa.imoveisEnviados.has(i.id));
      if (tipoLead && tipoLead !== 'não informado') {
        const porTipo = candidatos.filter(i => (i.tipo || '').toLowerCase().includes(tipoLead));
        if (porTipo.length > 0) candidatos = porTipo;
      }

      if (candidatos.length === 1) {
        imovelParaEnviar = candidatos[0];
      } else if (candidatos.length >= 2) {
        contextoImoveis = `\n[VÁRIOS IMÓVEIS DISPONÍVEIS]\nTem ${candidatos.length} imóveis disponíveis em ${bairroLead}. Antes de oferecer opções, pergunte ao cliente detalhes pra refinar — faixa de valor e quantos quartos. Não envie opções agora, só faça 1 pergunta pra estreitar.`;
      } else {
        // 2) Fallback: nenhum no bairro exato — busca alternativo com caracteristicas proximas
        const { data: imoveisTodos } = await db.supabase
          .from('imoveis')
          .select('*')
          .eq('usuario_id', userIdDestino)
          .eq('status', 'disponivel');

        let alternativos = (imoveisTodos || []).filter(i => i.foto_url && !conversa.imoveisEnviados.has(i.id));
        if (tipoLead && tipoLead !== 'não informado') {
          const porTipo = alternativos.filter(i => (i.tipo || '').toLowerCase().includes(tipoLead));
          if (porTipo.length > 0) alternativos = porTipo;
        }
        if (valorAlvo && alternativos.length > 1) {
          alternativos = alternativos
            .map(i => ({ i, d: distanciaValor(i.valor, valorAlvo) }))
            .sort((a, b) => a.d - b.d)
            .map(x => x.i);
        }
        if (alternativos.length > 0) {
          imovelParaEnviar = alternativos[0];
          imovelEhAlternativo = true;
        }
      }

      if (imovelParaEnviar) {
        const detalhes = [imovelParaEnviar.titulo, imovelParaEnviar.bairro];
        if (imovelParaEnviar.valor) detalhes.push(`R$ ${imovelParaEnviar.valor}`);
        if (imovelParaEnviar.quartos) detalhes.push(`${imovelParaEnviar.quartos} quartos`);
        if (imovelEhAlternativo) {
          contextoImoveis = `\n[IMÓVEL ALTERNATIVO PRA OFERECER]\nNão temos imóvel disponível no bairro "${bairroLead}" no momento. Logo após sua próxima mensagem, o sistema vai enviar automaticamente a foto de um imóvel parecido: ${detalhes.join(' · ')}. Na sua resposta, seja honesta: diga que nesse bairro específico não tem no momento, mas tem esse outro com características parecidas em ${imovelParaEnviar.bairro}, e que vai mandar a foto pra ele ver. Pergunte se o bairro ${imovelParaEnviar.bairro} também pode interessar. Não descreva a foto — ela vai junto.`;
        } else {
          contextoImoveis = `\n[IMÓVEL PRA OFERECER]\nLogo após sua próxima mensagem, o sistema vai enviar automaticamente uma foto do imóvel: ${detalhes.join(' · ')}. Na sua resposta, mencione que tem esse imóvel em ${bairroLead} e está mandando a foto pra ele ver. Pergunte se gostou ou se quer mais detalhes. Não descreva a foto em texto — ela vai junto.`;
        }
      }
    }
  } catch (err) {
    console.error(`[Webhook] Erro na extração pré-resposta:`, err.message);
  }

  // Bloco 1: Resposta da IA (CRÍTICO — se falhar, manda mensagem de erro)
  let respostaEnviada = false;
  try {
    let contextoExtra = '';
    // Anti-repeticao + anti-saudacao (idem evolution webhook).
    contextoExtra += buildAntiRepetContext(conversa.historico, leadData);
    if (userIdDestino) {
      const slotsLivres = await calcularHorariosLivres(userIdDestino);
      if (slotsLivres) {
        contextoExtra += `\n[HORÁRIOS DISPONÍVEIS PARA VISITAS]\nQuando o cliente quiser agendar uma visita, sugira estes horários:\n${slotsLivres}\n\nSempre ofereça 2-3 opções ao cliente. Se nenhum horário servir, diga que vai consultar o corretor.`;
      }
    }
    contextoExtra += contextoImoveis;

    // Tool handlers (imoveis + enviando_arquivos) — sendImage usa enviarImagem da Meta API.
    // Requer userIdDestino conhecido (sem ele nao tem dono dos imoveis pra consultar).
    const toolHandlers = (criarToolHandlers && userIdDestino) ? criarToolHandlers({
      userId: userIdDestino,
      telefone,
      conversa,
      db,
      sendImage: (tel, urlOuB64, caption) => enviarImagem(tel, urlOuB64, caption),
    }) : undefined;

    const respLia = await gerarResposta(conversa.historico, contextoExtra || undefined, {
      nomeCorretor,
      toolHandlers,
    });
    const resposta = respLia.texto;
    if (respLia.toolsExecutadas?.length) {
      console.log(`[meta] tools acionadas:`, respLia.toolsExecutadas.map(t => `${t.nome}(${JSON.stringify(t.input)})`).join(', '));
    }
    conversa.historico.push({ role: 'assistant', content: resposta });

    // RACE CONDITION FIX: SALVA historico ANTES de enviar a msg pro user.
    // Senao: user recebe resposta da Lia, responde em <2s, novo webhook fira
    // ANTES do save terminar — turn N+1 le historico stale do DB e a Lia
    // "esquece" a conversa. Save eh idempotente (upsert).
    if (userIdDestino) {
      try {
        await db.upsertLeadWhatsApp(telefone, {
          total_mensagens: conversa.historico.filter(m => m.role === 'user').length,
          historico_json: JSON.stringify(conversa.historico.slice(-40)),
        }, userIdDestino);
      } catch (e) {
        console.error(`[Webhook] Falha save EARLY historico ${telefone}:`, e.message);
      }
    }

    await enviarMensagem(telefone, resposta);
    respostaEnviada = true;

    // Envia foto do imovel logo apos o texto (nao critico) — SKIP se Lia ja enviou via tool.
    if (imovelParaEnviar && enviarImagem && !conversa.imoveisEnviados.has(imovelParaEnviar.id)) {
      try {
        const capParts = [imovelParaEnviar.titulo];
        if (imovelParaEnviar.valor) capParts.push(`R$ ${imovelParaEnviar.valor}`);
        if (imovelParaEnviar.quartos) capParts.push(`${imovelParaEnviar.quartos} quartos`);
        if (imovelParaEnviar.area) capParts.push(`${imovelParaEnviar.area}m²`);
        await enviarImagem(telefone, imovelParaEnviar.foto_url, capParts.join(' · '));
        conversa.imoveisEnviados.add(imovelParaEnviar.id);
      } catch (e) {
        console.error(`[Webhook] Erro ao enviar imagem do imovel ${imovelParaEnviar.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error(`[Webhook] Erro ao gerar/enviar resposta para ${telefone}:`, err.message);
    if (!respostaEnviada) {
      try { await enviarMensagem(telefone, 'Desculpe, tive um problema aqui. Pode repetir?'); } catch (_) {}
    }
    res.sendStatus(200);
    return;
  }

  // Bloco 2: Persistencia (NAO critico — falha silenciosamente). Reusa leadData extraida acima.
  try {
    if (!leadData) {
      const leadDataBruto = await extrairDadosLead(conversa.historico);
      leadData = validarEAjustarLead(leadDataBruto);
    }

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
        historico_json: JSON.stringify(conversa.historico.slice(-40)),
      }, userIdDestino);

      // Notifica corretor sobre novo lead (so na primeira mensagem)
      if (isLeadNovo && notificarNovoLead) {
        notificarNovoLead(telefone, mensagem).catch(e => console.error('[Webhook] notificarNovoLead falhou:', e.message));
      }
    }

    try {
      await salvarLead(telefone, leadData, conversa.historico.filter(m => m.role === 'user').length);
    } catch (_) { /* Sheets opcional */ }

    // Cria visita se a Lia agendou com o lead
    const va = leadData.visita_agendada;
    if (
      userIdDestino && va && va.confirmada === true &&
      va.data && va.data !== 'não' && /^\d{4}-\d{2}-\d{2}$/.test(va.data) &&
      va.horario && va.horario !== 'não' && /^\d{2}:\d{2}$/.test(va.horario)
    ) {
      try {
        const { data: jaExiste } = await db.supabase
          .from('visitas')
          .select('id')
          .eq('usuario_id', userIdDestino)
          .eq('lead_telefone', telefone)
          .eq('data', va.data)
          .eq('horario', va.horario)
          .maybeSingle();
        if (!jaExiste) {
          const novaVisita = await db.criarVisita({
            lead_nome: leadData.nome && leadData.nome !== 'não informado' ? leadData.nome : 'Lead WhatsApp',
            lead_telefone: telefone,
            imovel_titulo: va.imovel_titulo && va.imovel_titulo !== 'não especificado' ? va.imovel_titulo : '',
            endereco: '',
            data: va.data,
            horario: va.horario,
            corretor: nomeCorretor || '',
            observacoes: 'Agendada automaticamente pela Lia via WhatsApp',
            status: 'agendada',
          }, userIdDestino);
          console.log(`[Webhook] Visita agendada automaticamente: ${telefone} em ${va.data} ${va.horario}`);
          // Cria evento no Google Calendar do corretor (se conectado)
          criarEventoGCal(userIdDestino, novaVisita).catch(e => console.error('[gcal meta]', e.message));
          // Push notification pro corretor: visita agendada pela Lia
          if (pushService?.disponivel()) {
            const dataBr = va.data.split('-').reverse().join('/');
            pushService.sendPushParaCorretor(userIdDestino, {
              title: '📅 Lia agendou uma visita',
              body: `${novaVisita.lead_nome} — ${dataBr} às ${va.horario}${novaVisita.imovel_titulo ? ' · ' + novaVisita.imovel_titulo : ''}`,
              url: '/?tab=visitas',
              tag: `visita-${novaVisita.id}`,
            }).catch(e => console.error('[push visita meta]', e.message));
          }
        }
      } catch (e) {
        console.error(`[Webhook] Erro ao criar visita automatica:`, e.message);
      }
    }

    if (notificarCorretor && leadData.temperatura === 'quente') {
      await notificarCorretor(leadData, telefone);
    }
    // Push notification pro corretor — toda mensagem do cliente via Meta WABA.
    // 1a mensagem: "🔥 entrou em contato". Demais: "💬 [Nome]" + previa.
    // Tag por telefone substitui notificacao anterior do mesmo lead.
    if (userIdDestino && pushService?.disponivel()) {
      const nomeLead = leadData.nome && leadData.nome !== 'não informado' ? leadData.nome : 'Lead';
      const previa = mensagem.length > 80 ? mensagem.slice(0, 77) + '...' : mensagem;
      const title = isLeadNovo
        ? `🔥 ${nomeLead} entrou em contato`
        : `💬 ${nomeLead}`;
      pushService.sendPushParaCorretor(userIdDestino, {
        title,
        body: previa,
        url: '/?tab=comunicacoes',
        tag: `lead-${telefone}`,
      }).catch(e => console.error('[push msg meta]', e.message));
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
      try {
        const parsed = JSON.parse(lead.historico_json);
        // Compat: array OU objeto { messages, imoveisEnviados }
        if (Array.isArray(parsed)) historico = parsed;
        else if (parsed && Array.isArray(parsed.messages)) historico = parsed.messages;
      } catch {}
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
      vagas: req.body.vagas || '',
      area: req.body.area || '',
      descricao: req.body.descricao || '',
    };
    if (req.body.foto_url) imovelData.foto_url = req.body.foto_url;
    if (Array.isArray(req.body.fotos_extras)) {
      imovelData.fotos_extras = req.body.fotos_extras.filter(f => typeof f === 'string' && f).slice(0, 2);
    }
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
// Importacao CSV de leads
// ─────────────────────────────────────────────
function parseCsvLine(line, sep) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === sep) { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  // Remove BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  // Detecta separador (; ou ,)
  const sep = (lines[0].split(';').length > lines[0].split(',').length) ? ';' : ',';
  const headers = parseCsvLine(lines[0], sep).map(h => h.trim().toLowerCase());
  const rows = lines.slice(1).map(line => {
    const vals = parseCsvLine(line, sep);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
    return obj;
  });
  return { headers, rows };
}

const LEAD_TEMPLATE_HEADERS = ['nome','telefone','email','objetivo','tipo_imovel','bairro','faixa_valor','pagamento','prazo','temperatura','observacoes'];

app.get('/api/leads/template.csv', authMiddleware, (req, res) => {
  const exemplo = ['Maria Silva','83999998888','maria@email.com','comprar','apartamento','Manaira','500-700 mil','financiado','3 meses','morno','Procura 2 quartos com vaga'];
  const csv = '﻿' + LEAD_TEMPLATE_HEADERS.join(';') + '\n' + exemplo.join(';') + '\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="leadhouse-template-leads.csv"');
  res.send(csv);
});

app.post('/api/leads/importar', authMiddleware, requirePlan, async (req, res) => {
  try {
    const csvText = String(req.body?.csv || '');
    if (!csvText.trim()) return res.status(400).json({ erro: 'CSV vazio' });
    const { headers, rows } = parseCsv(csvText);
    if (!rows.length) return res.status(400).json({ erro: 'Nenhuma linha encontrada apos o header' });
    if (!headers.includes('telefone') && !headers.includes('nome')) {
      return res.status(400).json({ erro: 'CSV precisa ter ao menos as colunas "nome" e "telefone"' });
    }

    // Verifica limite do plano (admin/trial bypassam)
    if (!req.isAdmin && req.userPlan !== 'trial') {
      const max = req.userLimits?.maxLeads;
      if (Number.isFinite(max) && max !== Infinity) {
        const { count } = await db.supabase.from('leads').select('id', { count: 'exact', head: true }).eq('usuario_id', req.userId);
        if ((count || 0) + rows.length > max) {
          return res.status(403).json({ erro: `Limite de ${max} leads excedido. Faca upgrade pra importar.`, code: 'LIMIT_REACHED' });
        }
      }
    }

    // Normaliza temperatura
    const temps = new Set(['frio','morno','quente']);
    const validRows = [];
    const erros = [];
    rows.forEach((r, idx) => {
      const tel = String(r.telefone || '').replace(/\D/g, '');
      if (!tel) { erros.push({ linha: idx + 2, motivo: 'telefone vazio' }); return; }
      const temp = (r.temperatura || 'frio').toLowerCase();
      validRows.push({
        usuario_id: req.userId,
        nome: r.nome || '',
        telefone: tel,
        email: r.email || '',
        objetivo: r.objetivo || '',
        tipo_imovel: r.tipo_imovel || '',
        bairro: r.bairro || '',
        faixa_valor: r.faixa_valor || '',
        pagamento: r.pagamento || '',
        prazo: r.prazo || '',
        temperatura: temps.has(temp) ? temp : 'frio',
        observacoes: r.observacoes || '',
        origem: 'csv',
      });
    });

    if (!validRows.length) return res.status(400).json({ erro: 'Nenhuma linha valida pra importar', erros });

    const { data, error } = await db.supabase.from('leads').insert(validRows).select('id');
    if (error) throw error;
    res.json({ importados: data?.length || 0, ignorados: erros.length, erros });
  } catch (err) {
    console.error('[importar leads]', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ─────────────────────────────────────────────
// LGPD — exportar dados / deletar conta
// ─────────────────────────────────────────────
function toCsvRow(values) {
  return values.map(v => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n;]/.test(s) ? `"${s}"` : s;
  }).join(';');
}
function rowsToCsv(headers, rows) {
  const lines = [toCsvRow(headers)];
  for (const r of rows) lines.push(toCsvRow(headers.map(h => r[h])));
  return '﻿' + lines.join('\n'); // BOM pra Excel abrir UTF-8 correto
}

app.get('/api/exportar/leads.csv', authMiddleware, async (req, res) => {
  try {
    const { data } = await db.supabase
      .from('leads')
      .select('id, nome, telefone, email, objetivo, tipo_imovel, bairro, faixa_valor, pagamento, prazo, temperatura, proximo_passo, resumo, observacoes, origem, total_mensagens, created_at')
      .eq('usuario_id', req.userId)
      .order('created_at', { ascending: false });
    const headers = ['id','nome','telefone','email','objetivo','tipo_imovel','bairro','faixa_valor','pagamento','prazo','temperatura','proximo_passo','resumo','observacoes','origem','total_mensagens','created_at'];
    const csv = rowsToCsv(headers, data || []);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leadhouse-leads-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/exportar/imoveis.csv', authMiddleware, async (req, res) => {
  try {
    const { data } = await db.supabase
      .from('imoveis')
      .select('id, titulo, tipo, status, endereco, bairro, cidade, valor, quartos, vagas, area, descricao, created_at')
      .eq('usuario_id', req.userId)
      .order('created_at', { ascending: false });
    const headers = ['id','titulo','tipo','status','endereco','bairro','cidade','valor','quartos','vagas','area','descricao','created_at'];
    const csv = rowsToCsv(headers, data || []);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leadhouse-imoveis-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/exportar/visitas.csv', authMiddleware, async (req, res) => {
  try {
    const { data } = await db.supabase
      .from('visitas')
      .select('id, lead_nome, lead_telefone, imovel_titulo, endereco, data, horario, corretor, observacoes, status, created_at')
      .eq('usuario_id', req.userId)
      .order('data', { ascending: false });
    const headers = ['id','lead_nome','lead_telefone','imovel_titulo','endereco','data','horario','corretor','observacoes','status','created_at'];
    const csv = rowsToCsv(headers, data || []);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leadhouse-visitas-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Exportacao LGPD completa em JSON: tudo que temos do usuario num arquivo so
app.get('/api/exportar/todos.json', authMiddleware, async (req, res) => {
  try {
    const [{ data: user }, { data: leads }, { data: imoveis }, { data: visitas }] = await Promise.all([
      db.supabase.from('usuarios').select('id, nome, email, plano, trial_expires_at, google_email, horario_trabalho, created_at').eq('id', req.userId).maybeSingle(),
      db.supabase.from('leads').select('*').eq('usuario_id', req.userId),
      db.supabase.from('imoveis').select('*').eq('usuario_id', req.userId),
      db.supabase.from('visitas').select('*').eq('usuario_id', req.userId),
    ]);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leadhouse-meus-dados-${new Date().toISOString().slice(0,10)}.json"`);
    res.json({
      exportado_em: new Date().toISOString(),
      conta: user || null,
      leads: leads || [],
      imoveis: imoveis || [],
      visitas: visitas || [],
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// LGPD: usuario pode deletar a propria conta + todos os dados associados.
// Requer confirmacao via body { confirmar: 'EXCLUIR' } pra evitar acidente.
app.post('/api/conta/excluir', authMiddleware, async (req, res) => {
  if (req.body?.confirmar !== 'EXCLUIR') {
    return res.status(400).json({ erro: 'Envie { "confirmar": "EXCLUIR" } no body' });
  }
  if (req.isImpersonating) {
    return res.status(403).json({ erro: 'Nao pode excluir conta enquanto impersonando' });
  }
  try {
    // Cancela assinatura no Stripe se existir, antes de apagar
    const { data: u } = await db.supabase.from('usuarios').select('stripe_customer_id').eq('id', req.userId).maybeSingle();
    if (stripe && u?.stripe_customer_id) {
      try {
        const subs = await stripe.subscriptions.list({ customer: u.stripe_customer_id, status: 'active' });
        for (const sub of subs.data) await stripe.subscriptions.cancel(sub.id);
      } catch (e) { console.error('[conta/excluir] erro ao cancelar Stripe:', e.message); }
    }
    // Apaga dados em ordem (FKs nao sao explicitas mas seguro deletar dependentes primeiro)
    await db.supabase.from('leads').delete().eq('usuario_id', req.userId);
    await db.supabase.from('imoveis').delete().eq('usuario_id', req.userId);
    await db.supabase.from('visitas').delete().eq('usuario_id', req.userId);
    await db.supabase.from('password_resets').delete().eq('user_id', req.userId);
    await db.supabase.from('usuarios').delete().eq('id', req.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[conta/excluir]', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ─────────────────────────────────────────────
// Health check — status do app + integracoes
// ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const checks = {
    app: 'ok',
    db: 'unknown',
    stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'not_configured',
    resend: process.env.RESEND_API_KEY ? 'configured' : 'not_configured',
    whatsapp: process.env.WHATSAPP_PHONE_ID ? 'configured' : 'not_configured',
    claude: process.env.ANTHROPIC_API_KEY ? 'configured' : 'not_configured',
    google: process.env.GOOGLE_CLIENT_ID ? 'configured' : 'not_configured',
    sentry: Sentry ? 'initialized' : (process.env.SENTRY_DSN ? 'env_set_but_not_init' : 'not_configured'),
  };
  // Testa conexao com Supabase (timeout curto)
  try {
    const t0 = Date.now();
    const { error } = await db.supabase.from('usuarios').select('id', { count: 'exact', head: true }).limit(1);
    checks.db = error ? 'error' : 'ok';
    checks.db_latency_ms = Date.now() - t0;
  } catch (e) { checks.db = 'error'; }

  const allOk = checks.db === 'ok';
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});
app.get('/api/health', (req, res) => res.redirect('/health'));

// ─────────────────────────────────────────────
// 404 — depois de TODAS as rotas (deve ser ultimo handler antes do export)
// ─────────────────────────────────────────────
app.use((req, res) => {
  // API endpoints retornam JSON, browser visits retornam HTML
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook')) {
    return res.status(404).json({ erro: 'Endpoint nao encontrado', path: req.path });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Error handler global — captura qualquer Error nao tratado nas rotas
app.use(async (err, req, res, next) => {
  console.error('[unhandled]', err.message, err.stack);
  if (Sentry) {
    Sentry.captureException(err, { tags: { path: req.path, method: req.method } });
    // Flush antes de responder — Vercel serverless mata a funcao apos o response,
    // sem flush os eventos ficam na queue e nunca chegam no Sentry.
    try { await Sentry.flush(2000); } catch {}
  }
  if (res.headersSent) return next(err);
  res.status(500).json({ erro: 'Erro interno do servidor' });
});

// Captura erros nao-handled fora do request lifecycle
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  if (Sentry) Sentry.captureException(reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  if (Sentry) Sentry.captureException(err);
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
