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
 * (reduz risco de ban por automacao detectada).
 */
async function sendText(userId, telefone, texto) {
  const instanceName = instanceNameFor(userId);
  // Pausa humana curta (0.5-1.5s). O `delay: 1200` no body adiciona typing indicator
  // de mais 1.2s no proprio WhatsApp — efeito humano combinado.
  const pause = 500 + Math.random() * 1000;
  await new Promise(r => setTimeout(r, pause));
  const number = String(telefone).replace(/\D/g, '');
  return call(`/message/sendText/${instanceName}`, {
    method: 'POST',
    body: {
      number,
      text: texto,
      delay: 1200, // typing indicator delay
    },
  });
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

  // Se for URL, baixa e converte pra base64 com prefixo data URL.
  // Evolution v2.x exige formato 'data:image/jpeg;base64,...' (nao aceita base64 puro).
  let media = urlOrBase64;
  const isUrl = typeof urlOrBase64 === 'string' && /^https?:\/\//i.test(urlOrBase64);
  if (isUrl) {
    try {
      const b64 = await urlParaBase64(urlOrBase64);
      media = `data:image/jpeg;base64,${b64}`;
      console.log(`[evolution.sendImage] URL convertida pra data URL (${media.length} chars)`);
    } catch (err) {
      console.error(`[evolution.sendImage] falha ao baixar URL ${urlOrBase64}:`, err.message);
      throw err;
    }
  } else if (typeof urlOrBase64 === 'string' && !urlOrBase64.startsWith('data:')) {
    // Caller passou base64 puro — adiciona prefixo
    media = `data:image/jpeg;base64,${urlOrBase64}`;
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
    const r = await call(`/message/sendMedia/${instanceName}`, { method: 'POST', body });
    console.log(`[evolution.sendImage] OK`);
    return r;
  } catch (err) {
    console.error(`[evolution.sendImage] FALHA status=${err.status} msg=${err.message} body=`, err.body);
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
};
