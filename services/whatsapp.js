/**
 * services/whatsapp.js
 * Responsável por enviar mensagens via WhatsApp Cloud API (Meta).
 * Também contém helpers para normalizar o payload recebido.
 */

const axios = require('axios');
const FormData = require('form-data');

const WHATSAPP_API_URL = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
const WHATSAPP_MEDIA_URL = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/media`;

// Faz upload de uma imagem (data URI base64 ou URL publica) pro endpoint /media
// da Meta e retorna o media_id. Use esse id em { image: { id: ... } } pra mandar.
// Detecta o MIME real olhando os primeiros bytes (magic numbers).
// Necessario porque o data URI pode ter MIME mentindo (ex: declarar jpeg
// mas conter PNG real, ou vice-versa).
function detectarMime(buffer) {
  if (buffer.length < 4) return null;
  const b = buffer;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

async function uploadImagemParaWhatsApp(dataUriOuUrl) {
  let buffer;
  let mimeDeclarado;

  if (dataUriOuUrl.startsWith('data:')) {
    const m = dataUriOuUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!m) throw new Error('Data URI invalida');
    mimeDeclarado = m[1];
    // Strip whitespace/newlines defensively
    const b64Limpo = m[2].replace(/\s+/g, '');
    buffer = Buffer.from(b64Limpo, 'base64');
  } else {
    const res = await axios.get(dataUriOuUrl, { responseType: 'arraybuffer' });
    mimeDeclarado = res.headers['content-type'] || 'image/jpeg';
    buffer = Buffer.from(res.data);
  }

  const mimeReal = detectarMime(buffer);
  const mimeFinal = mimeReal || mimeDeclarado;
  const ext = mimeFinal.split('/')[1] || 'jpg';

  console.log(`[WhatsApp] Upload imagem: bytes=${buffer.length}, mime_declarado=${mimeDeclarado}, mime_real=${mimeReal || 'desconhecido'}, primeiro_byte=0x${buffer[0]?.toString(16) || '??'}`);

  if (buffer.length === 0) throw new Error('Buffer vazio (data URI invalido?)');
  if (buffer.length > 5 * 1024 * 1024) throw new Error(`Imagem muito grande: ${(buffer.length/1024/1024).toFixed(1)}MB (max 5MB)`);
  if (!mimeReal) console.warn(`[WhatsApp] AVISO: nao foi possivel verificar MIME por magic number, usando declarado (${mimeDeclarado})`);

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeFinal);
  form.append('file', buffer, {
    filename: `imagem.${ext}`,
    contentType: mimeFinal,
  });

  const res = await axios.post(WHATSAPP_MEDIA_URL, form, {
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      ...form.getHeaders(),
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  if (!res.data?.id) throw new Error('Meta nao retornou media_id');
  console.log(`[WhatsApp] Upload OK: media_id=${res.data.id}`);
  return res.data.id;
}

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
 * Envia uma imagem com legenda via WhatsApp Cloud API.
 * Aceita tanto data URI (base64) quanto URL HTTPS publica.
 * Internamente: faz upload pro endpoint /media e envia com media_id
 * (evita que a Meta precise baixar a URL).
 */
async function enviarImagem(telefone, imagemSrc, caption) {
  try {
    const mediaId = await uploadImagemParaWhatsApp(imagemSrc);
    const payload = {
      messaging_product: 'whatsapp',
      to: telefone,
      type: 'image',
      image: caption ? { id: mediaId, caption } : { id: mediaId },
    };
    const response = await axios.post(WHATSAPP_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`[WhatsApp] Imagem enviada para ${telefone}: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (err) {
    const detalhe = err.response?.data || err.message;
    console.error('[WhatsApp] Erro ao enviar imagem:', JSON.stringify(detalhe));
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

/**
 * Notifica o corretor que um novo lead acabou de iniciar conversa pelo WhatsApp.
 * Mensagem mais leve que notificarCorretor — chega antes da qualificacao completa.
 */
async function notificarNovoLead(telefoneLead, primeiraMensagem) {
  const telefoneCorretor = process.env.CORRETOR_TELEFONE;
  if (!telefoneCorretor) {
    console.warn('[WhatsApp] CORRETOR_TELEFONE nao configurado. Notificacao de novo lead ignorada.');
    return;
  }
  const trecho = (primeiraMensagem || '').slice(0, 200);
  const msg =
    `🆕 *Novo lead no WhatsApp!*\n\n` +
    `📞 Telefone: ${telefoneLead}\n` +
    (trecho ? `💬 Primeira mensagem: "${trecho}"\n\n` : '\n') +
    `A Lia ja esta qualificando. Acompanhe pelo LeadHouse.`;
  try {
    await enviarMensagem(telefoneCorretor, msg);
    console.log('[WhatsApp] Corretor notificado de novo lead.');
  } catch (e) {
    console.error('[WhatsApp] Falha ao notificar novo lead:', e.message);
  }
}

module.exports = { enviarMensagem, enviarImagem, extrairMensagem, notificarCorretor, notificarNovoLead };
