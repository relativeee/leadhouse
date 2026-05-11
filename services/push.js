/**
 * services/push.js
 * Web Push (notificacoes do navegador) via VAPID + web-push.
 *
 * - Cada corretor pode ter N subscriptions (1 por device/browser).
 * - sendPushParaCorretor(userId, payload) itera as subscriptions e envia.
 * - Subscriptions invalidas (410 Gone) sao removidas automaticamente.
 */

const webpush = require('web-push');
const db = require('./supabase');

const PUB_RAW = process.env.VAPID_PUBLIC_KEY;
const PRIV_RAW = process.env.VAPID_PRIVATE_KEY;
const SUBJECT_RAW = process.env.VAPID_SUBJECT || 'mailto:leadhouse.gestaoimobiliaria@gmail.com';

// Aplica trim pra eliminar espaços/quebras que podem ter sido coladas no Vercel
const PUB = (PUB_RAW || '').trim();
const PRIV = (PRIV_RAW || '').trim();
let SUBJECT = (SUBJECT_RAW || '').trim();
// Se o user salvou o subject sem "mailto:", adiciona automaticamente
if (SUBJECT && !/^(mailto:|https?:\/\/)/i.test(SUBJECT)) {
  SUBJECT = 'mailto:' + SUBJECT;
}

let configurado = false;
let erroConfig = null;
if (!PUB) erroConfig = 'VAPID_PUBLIC_KEY ausente';
else if (!PRIV) erroConfig = 'VAPID_PRIVATE_KEY ausente';
else {
  try {
    webpush.setVapidDetails(SUBJECT, PUB, PRIV);
    configurado = true;
    console.log('[push] VAPID configurado · subject=' + SUBJECT.slice(0, 30) + '... · pubKey len=' + PUB.length);
  } catch (err) {
    erroConfig = 'setVapidDetails falhou: ' + err.message;
    console.error('[push]', erroConfig);
  }
}
if (!configurado) console.warn('[push] desabilitado:', erroConfig);

function disponivel() {
  return configurado;
}

function diagnostico() {
  return {
    configurado,
    erro: erroConfig,
    hasPublicKey: !!PUB,
    hasPrivateKey: !!PRIV,
    publicKeyLength: PUB.length,
    privateKeyLength: PRIV.length,
    subject: SUBJECT ? SUBJECT.slice(0, 40) + (SUBJECT.length > 40 ? '...' : '') : null,
  };
}

function publicKey() {
  return PUB || null;
}

async function salvarSubscription(userId, subscription, userAgent) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error('Subscription invalida — endpoint/keys ausentes');
  }
  // Upsert por endpoint (mesmo device re-inscrito atualiza, nao duplica)
  const { data: existente } = await db.supabase
    .from('push_subscriptions')
    .select('id')
    .eq('endpoint', subscription.endpoint)
    .maybeSingle();

  if (existente) {
    const { data, error } = await db.supabase
      .from('push_subscriptions')
      .update({
        usuario_id: userId,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        user_agent: userAgent || null,
        last_used_at: new Date().toISOString(),
      })
      .eq('id', existente.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await db.supabase
    .from('push_subscriptions')
    .insert({
      usuario_id: userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      user_agent: userAgent || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function removerSubscription(endpoint) {
  if (!endpoint) return;
  await db.supabase
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', endpoint);
}

/**
 * Envia notificacao push pra TODAS subscriptions ativas de um corretor.
 * @param {number} userId
 * @param {{ title: string, body: string, url?: string, tag?: string }} payload
 * @returns {Promise<{sent: number, removed: number, errors: number}>}
 */
async function sendPushParaCorretor(userId, payload) {
  if (!configurado) return { sent: 0, removed: 0, errors: 0 };

  const { data: subs, error } = await db.supabase
    .from('push_subscriptions')
    .select('*')
    .eq('usuario_id', userId);

  if (error) {
    console.error('[push] erro buscando subs:', error.message);
    return { sent: 0, removed: 0, errors: 1 };
  }
  if (!subs?.length) return { sent: 0, removed: 0, errors: 0 };

  const body = JSON.stringify({
    title: payload.title || 'LeadHouse',
    body: payload.body || '',
    data: { url: payload.url || '/' },
    tag: payload.tag || 'default',
  });

  let sent = 0, removed = 0, errors = 0;

  await Promise.all(subs.map(async (s) => {
    const subscription = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh, auth: s.auth },
    };
    try {
      await webpush.sendNotification(subscription, body);
      sent++;
      // Atualiza last_used_at (best-effort, sem await pra nao bloquear)
      db.supabase.from('push_subscriptions')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', s.id)
        .then(() => {}, () => {});
    } catch (err) {
      // 410 Gone / 404 = subscription expirada — remove
      if (err.statusCode === 410 || err.statusCode === 404) {
        await removerSubscription(s.endpoint);
        removed++;
      } else {
        errors++;
        console.warn(`[push] sub id=${s.id} falhou:`, err.statusCode, err.body || err.message);
      }
    }
  }));

  return { sent, removed, errors };
}

module.exports = {
  disponivel,
  publicKey,
  diagnostico,
  salvarSubscription,
  removerSubscription,
  sendPushParaCorretor,
};
