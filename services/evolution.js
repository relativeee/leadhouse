/**
 * services/evolution.js
 * Wrapper da Evolution API (WhatsApp via Baileys).
 *
 * Cada corretor tem 1 instancia identificada por `evolution_instance_name`
 * (ex: "leadhouse-user-10"). A Evolution gerencia a sessao do WhatsApp
 * dele e nos manda webhooks de mensagens recebidas.
 */

const BASE = process.env.EVOLUTION_URL;
const KEY  = process.env.EVOLUTION_API_KEY;
const APP_URL = process.env.SITE_URL || 'https://app.leadhouses.com.br';

if (!BASE || !KEY) {
  console.warn('[evolution] EVOLUTION_URL/EVOLUTION_API_KEY ausentes — service desabilitado');
}

function instanceNameFor(userId) {
  return `leadhouse-user-${userId}`;
}

async function call(path, opts = {}) {
  if (!BASE || !KEY) throw new Error('Evolution nao configurada');
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || 'GET',
    headers: {
      'apikey': KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `Evolution ${path} ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Retry com backoff exponencial pra erros transientes (5xx, 408, 429, network).
// 4xx (auth, bad request) NAO retentamos — retry nao vai resolver.
async function withRetry(fn, label, maxAttempts = 3) {
  const delaysMs = [0, 1000, 3000];
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (delaysMs[attempt - 1] > 0) {
      await new Promise(r => setTimeout(r, delaysMs[attempt - 1]));
    }
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e.status;
      const transient = !status || status >= 500 || status === 408 || status === 429;
      const isLast = attempt === maxAttempts;
      console.warn(`[evolution.${label}] tentativa ${attempt}/${maxAttempts} falhou: ${e.message} (status=${status || 'no-status'}, transient=${transient})`);
      if (!transient || isLast) throw e;
    }
  }
  throw lastErr;
}

// Notifica corretor via push quando envio falhou definitivamente. Lazy-require
// pra evitar dependencia circular evolution <-> push.
async function notificarCorretorFalha(userId, telefone, tipo) {
  try {
    const push = require('./push');
    if (!push?.sendPushParaCorretor) return;
    await push.sendPushParaCorretor(userId, {
      title: '⚠️ Falha ao enviar mensagem',
      body: `Não consegui ${tipo === 'image' ? 'enviar a foto' : 'responder'} pro lead ${telefone}. Abra o LeadHouse e responda manualmente.`,
      url: '/?tab=comunicacoes',
      tag: `falha-${telefone}`,
    });
  } catch (e) {
    console.error('[evolution.notificarCorretorFalha]', e.message);
  }
}

// Healthcheck leve — confirma que a Evolution responde + apikey valida.
// Usado pelo /health do LeadHouse pro Uptime Robot saber se a infra ta de pe.
async function healthCheck(timeoutMs = 3000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/instance/fetchInstances`, {
      method: 'GET',
      headers: { apikey: KEY },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Evolution health ${res.status}`);
    return { ok: true };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Cria instancia + retorna QR code base64. Se ja existe, deleta antes pra
 * gerar QR novo (caso o anterior tenha expirado).
 */
async function createInstance(userId) {
  const instanceName = instanceNameFor(userId);

  // Se ja existe, deleta primeiro pra gerar QR limpo
  try {
    await call(`/instance/delete/${instanceName}`, { method: 'DELETE' });
  } catch (e) { /* nao existia, tudo bem */ }

  const data = await call('/instance/create', {
    method: 'POST',
    body: {
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      webhook: {
        url: `${APP_URL}/webhook/evolution`,
        byEvents: false,
        base64: false,
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
      },
    },
  });

  return {
    instanceName,
    qrcode: data.qrcode?.base64 || null, // data:image/png;base64,...
    pairingCode: data.qrcode?.pairingCode || null,
  };
}

async function getQRCode(userId) {
  const instanceName = instanceNameFor(userId);
  try {
    const data = await call(`/instance/connect/${instanceName}`);
    return {
      instanceName,
      qrcode: data.base64 || data.qrcode?.base64 || null,
      pairingCode: data.pairingCode || data.qrcode?.pairingCode || null,
      status: data.instance?.state || 'connecting',
    };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function getStatus(userId) {
  const instanceName = instanceNameFor(userId);
  try {
    const data = await call(`/instance/connectionState/${instanceName}`);
    return {
      instanceName,
      state: data.instance?.state || 'unknown', // 'open' = conectado
    };
  } catch (e) {
    if (e.status === 404) return { instanceName, state: 'not_found' };
    throw e;
  }
}

async function deleteInstance(userId) {
  const instanceName = instanceNameFor(userId);
  try {
    // Tenta logout primeiro (encerra sessao WhatsApp limpamente)
    await call(`/instance/logout/${instanceName}`, { method: 'DELETE' }).catch(() => {});
    await call(`/instance/delete/${instanceName}`, { method: 'DELETE' });
    return true;
  } catch (e) {
    if (e.status === 404) return true;
    throw e;
  }
}

/**
 * Envia mensagem de texto. Inclui pausa randomica antes pra parecer humano
 * (reduz risco de ban por automacao detectada). Retry automatico em erros
 * transientes (5xx/timeout). Push notif pro corretor se falhar todas.
 */
async function sendText(userId, telefone, texto) {
  const instanceName = instanceNameFor(userId);
  // Pausa humana curta (0.5-1.5s). O `delay: 1200` no body adiciona typing indicator
  // de mais 1.2s no proprio WhatsApp — efeito humano combinado.
  const pause = 500 + Math.random() * 1000;
  await new Promise(r => setTimeout(r, pause));
  const number = String(telefone).replace(/\D/g, '');
  try {
    return await withRetry(() => call(`/message/sendText/${instanceName}`, {
      method: 'POST',
      body: { number, text: texto, delay: 1200 },
    }), 'sendText');
  } catch (err) {
    await notificarCorretorFalha(userId, telefone, 'text');
    throw err;
  }
}

/**
 * Baixa uma URL e converte pra base64 puro (sem prefixo `data:`).
 * Necessario porque algumas instalacoes do Evolution nao conseguem buscar URLs
 * (CORS, tokens, etc) — mandar base64 elimina essa dependencia de rede.
 */
async function urlParaBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch da imagem falhou: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString('base64');
}

/**
 * Envia imagem com legenda. Aceita URL ou base64 — se for URL, baixa primeiro
 * e converte (mais confiavel que deixar Evolution baixar).
 */
async function sendImage(userId, telefone, urlOrBase64, caption = '') {
  const instanceName = instanceNameFor(userId);
  await new Promise(r => setTimeout(r, 500 + Math.random() * 800));
  const number = String(telefone).replace(/\D/g, '');

  // Evolution v2.x valida `media` com isURL || isBase64 (validator.js).
  // - URL: deve ser http/https e nao retornar erro pro Evolution baixar
  // - base64: PURO, sem prefixo 'data:image/...,'
  // Vamos baixar a URL nos mesmos e mandar base64 puro (mais confiavel
  // que deixar Evolution baixar em redes restritas).
  let media = urlOrBase64;
  const isUrl = typeof urlOrBase64 === 'string' && /^https?:\/\//i.test(urlOrBase64);
  if (isUrl) {
    try {
      // base64 puro, sem prefixo data:
      media = await urlParaBase64(urlOrBase64);
      console.log(`[evolution.sendImage] URL convertida pra base64 puro (${media.length} chars)`);
    } catch (err) {
      console.error(`[evolution.sendImage] falha ao baixar URL ${urlOrBase64}:`, err.message);
      throw err;
    }
  } else if (typeof urlOrBase64 === 'string' && urlOrBase64.startsWith('data:')) {
    // Caller passou data URL — extrai so a parte base64
    const idx = urlOrBase64.indexOf('base64,');
    if (idx >= 0) media = urlOrBase64.slice(idx + 7);
  }

  const body = {
    number,
    mediatype: 'image',
    mimetype: 'image/jpeg',
    media,
    caption: caption || undefined,
    fileName: 'imovel.jpg',
  };
  console.log(`[evolution.sendImage] instance=${instanceName} to=${number} mode=${isUrl ? 'base64-from-url' : 'direct'}`);
  try {
    const r = await withRetry(
      () => call(`/message/sendMedia/${instanceName}`, { method: 'POST', body }),
      'sendImage'
    );
    console.log(`[evolution.sendImage] OK`);
    return r;
  } catch (err) {
    console.error(`[evolution.sendImage] FALHA FINAL status=${err.status} msg=${err.message} body=`, err.body);
    await notificarCorretorFalha(userId, telefone, 'image');
    throw err;
  }
}

module.exports = {
  instanceNameFor,
  createInstance,
  getQRCode,
  getStatus,
  deleteInstance,
  sendText,
  sendImage,
  healthCheck,
};
