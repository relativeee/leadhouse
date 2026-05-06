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
 * Envia imagem com legenda. `urlOrBase64` pode ser URL publica ou string base64.
 * Inclui pequena pausa antes pra parecer humano.
 */
async function sendImage(userId, telefone, urlOrBase64, caption = '') {
  const instanceName = instanceNameFor(userId);
  // Pausa curta antes (envio de midia ja tem typing implicito no app)
  await new Promise(r => setTimeout(r, 500 + Math.random() * 800));
  const number = String(telefone).replace(/\D/g, '');
  return call(`/message/sendMedia/${instanceName}`, {
    method: 'POST',
    body: {
      number,
      mediatype: 'image',
      media: urlOrBase64,
      caption: caption || undefined,
      fileName: 'imovel.jpg',
    },
  });
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
