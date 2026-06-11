/**
 * services/hotmart.js
 * Helpers pra validar webhooks Hotmart e mapear eventos -> acao no LeadHouse.
 *
 * Hotmart webhook payload v2.0.0:
 * {
 *   id: 'uuid-do-evento',
 *   creation_date: timestamp,
 *   event: 'PURCHASE_APPROVED' | 'PURCHASE_REFUNDED' | ...,
 *   version: '2.0.0',
 *   data: {
 *     product: { id, name, ucode },
 *     buyer: { email, name, document, checkout_phone },
 *     purchase: { transaction, status, price, payment, ... },
 *     subscription: { subscriber: { code }, plan: { name, id }, status },
 *   },
 *   hottok: 'shared-secret'
 * }
 */

// Hotmart v2 envia o hottok no body do payload. Validamos comparando com env.
function validarHottok(body) {
  const expected = (process.env.HOTMART_HOTTOK || '').trim();
  if (!expected) return false; // env nao setada -> rejeita tudo (defesa)
  const got = (body?.hottok || '').toString().trim();
  return got === expected && got.length > 0;
}

// product_id Hotmart -> plano LeadHouse (start | pro | elite).
function planoDoProductId(productId) {
  const id = String(productId || '');
  const map = {
    [String(process.env.HOTMART_START_PRODUCT_ID || '')]: 'start',
    [String(process.env.HOTMART_PRO_PRODUCT_ID   || '')]: 'pro',
    [String(process.env.HOTMART_ELITE_PRODUCT_ID || '')]: 'elite',
  };
  delete map['']; // remove chave vazia se alguma env nao tiver valor
  return map[id] || null;
}

// event Hotmart -> acao a tomar
// PURCHASE_APPROVED, PURCHASE_COMPLETE -> ativar plano
// PURCHASE_REFUNDED, PURCHASE_CHARGEBACK, PURCHASE_CANCELED -> revogar
// SUBSCRIPTION_CANCELLATION -> revogar
// PURCHASE_DELAYED -> falha_cobranca (notifica)
// SWITCH_PLAN -> trocar_plano
function acaoDoEvento(event) {
  const e = String(event || '').toUpperCase();
  if (e === 'PURCHASE_APPROVED' || e === 'PURCHASE_COMPLETE') return 'ativar';
  if (e === 'PURCHASE_REFUNDED' || e === 'PURCHASE_CHARGEBACK'
      || e === 'PURCHASE_CANCELED' || e === 'SUBSCRIPTION_CANCELLATION') return 'revogar';
  if (e === 'PURCHASE_DELAYED' || e === 'PURCHASE_BILLET_PRINTED') return 'falha_cobranca';
  if (e === 'SWITCH_PLAN') return 'trocar_plano';
  return null;
}

// Extrai dados normalizados do payload pra uso interno
function extrairDadosCompra(body) {
  const d = body?.data || {};
  const email = (d.buyer?.email || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  return {
    eventId: body?.id,
    event: body?.event,
    email,
    nome: d.buyer?.name || null,
    productId: d.product?.id,
    transactionId: d.purchase?.transaction || null,
    subscriberCode: d.subscription?.subscriber?.code || null,
    valor: d.purchase?.price?.value || null,
  };
}

module.exports = {
  validarHottok,
  planoDoProductId,
  acaoDoEvento,
  extrairDadosCompra,
};
