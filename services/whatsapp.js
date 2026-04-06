/**
 * services/whatsapp.js
 * Responsável por enviar mensagens via WhatsApp Cloud API (Meta).
 * Também contém helpers para normalizar o payload recebido.
 */

const axios = require('axios');

const WHATSAPP_API_URL = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`;

/**
 * Envia uma mensagem de texto para um número de telefone.
 * @param {string} telefone - Número no formato internacional (ex: 5583999999999)
 * @param {string} mensagem - Texto a ser enviado
 */
async function enviarMensagem(telefone, mensagem) {
  try {
    const payload = {
      messaging_product: 'whatsapp',
      to: telefone,
      type: 'text',
      text: { body: mensagem },
    };

    const response = await axios.post(WHATSAPP_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    console.log(`[WhatsApp] Mensagem enviada para ${telefone}`);
    return response.data;
  } catch (err) {
    const detalhe = err.response?.data || err.message;
    console.error('[WhatsApp] Erro ao enviar mensagem:', JSON.stringify(detalhe));
    throw err;
  }
}

/**
 * Extrai dados relevantes do payload recebido pelo webhook.
 * @param {Object} body - Body do POST do webhook
 * @returns {{ telefone, mensagem, messageId } | null}
 */
function extrairMensagem(body) {
  try {
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return null;

    const msg = messages[0];

    // Por enquanto suporta apenas mensagens de texto
    if (msg.type !== 'text') {
      console.log(`[WhatsApp] Tipo de mensagem não suportado: ${msg.type}`);
      return null;
    }

    return {
      telefone: msg.from,
      mensagem: msg.text.body,
      messageId: msg.id,
    };
  } catch (err) {
    console.error('[WhatsApp] Erro ao extrair mensagem do payload:', err.message);
    return null;
  }
}

/**
 * Envia notificação para o corretor via WhatsApp.
 * @param {Object} leadData - Dados estruturados do lead
 * @param {string} telefoneLead - Telefone do lead
 */
async function notificarCorretor(leadData, telefoneLead) {
  const telefoneCorretor = process.env.CORRETOR_TELEFONE;
  if (!telefoneCorretor) {
    console.warn('[WhatsApp] CORRETOR_TELEFONE não configurado. Notificação ignorada.');
    return;
  }

  const mensagem =
    `🔥 *Lead QUENTE identificado!*\n\n` +
    `👤 Nome: ${leadData.nome}\n` +
    `🎯 Objetivo: ${leadData.objetivo}\n` +
    `🏠 Imóvel: ${leadData.tipo_imovel}\n` +
    `📍 Bairro: ${leadData.bairro}\n` +
    `💰 Faixa: ${leadData.faixa_valor}\n` +
    `💳 Pagamento: ${leadData.pagamento}\n` +
    `⏱ Prazo: ${leadData.prazo}\n\n` +
    `📋 Resumo: ${leadData.resumo}\n\n` +
    `✅ Próximo passo: ${leadData.proximo_passo}\n\n` +
    `📞 Telefone do lead: ${telefoneLead}`;

  await enviarMensagem(telefoneCorretor, mensagem);
  console.log('[WhatsApp] Corretor notificado sobre lead quente.');
}

module.exports = { enviarMensagem, extrairMensagem, notificarCorretor };
