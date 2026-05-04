/**
 * services/emails.js
 * Centraliza envio de emails transacionais via Resend.
 * Todos os templates seguem o mesmo wrapper visual da LeadHouse.
 */

const FROM = 'LeadHouse <noreply@leadhouses.com.br>';
const SITE_URL = process.env.SITE_URL || 'https://app.leadhouses.com.br';
const SUPPORT_EMAIL = 'leadhouse.gestaoimobiliaria@gmail.com';

function wrap(content, title) {
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#0A0A0A;color:#E0E0E0;border-radius:16px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 16px"><tr><td style="text-align:center">
        <span style="display:inline-block;width:56px;height:56px;line-height:56px;border-radius:14px;background:#1a1a1a;border:1px solid #2a2a2a;text-align:center;font-size:30px">🏠</span>
      </td></tr></table>
      <h1 style="font-family:Georgia,serif;color:#C9A84C;font-size:26px;margin:0 0 4px;text-align:center;letter-spacing:1px">LeadHouse</h1>
      <p style="color:#5A5A5A;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 28px;text-align:center">${title}</p>
      ${content}
      <p style="font-size:12px;color:#555;margin-top:32px;border-top:1px solid #222;padding-top:16px">
        LeadHouse — Gestão imobiliária inteligente<br>
        Dúvidas? <a href="mailto:${SUPPORT_EMAIL}" style="color:#888;text-decoration:underline">${SUPPORT_EMAIL}</a>
      </p>
    </div>
  `;
}

function btn(href, label) {
  return `<p style="margin:32px 0;text-align:center">
    <a href="${href}" style="display:inline-block;background:#C9A84C;color:#0A0A0A;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;letter-spacing:1px;text-transform:uppercase;font-size:13px">${label}</a>
  </p>`;
}

async function send({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[email] RESEND_API_KEY ausente — nao enviado: ${subject} -> ${to}`);
    return { sent: false, reason: 'no_api_key' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error('[email] Resend error:', res.status, errBody);
      return { sent: false, reason: 'resend_error', status: res.status };
    }
    return { sent: true };
  } catch (e) {
    console.error('[email] exception:', e.message);
    return { sent: false, reason: 'exception', error: e.message };
  }
}

// ─────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────

async function sendWelcome({ to, nome }) {
  const content = `
    <p style="font-size:15px;line-height:1.6">Olá ${nome || ''}, seja bem-vindo(a) à LeadHouse!</p>
    <p style="font-size:15px;line-height:1.6">Você ganhou <b>14 dias gratuitos</b> pra testar tudo — leads ilimitados, integração com WhatsApp e o agente de IA. Sem cartão de crédito.</p>
    ${btn(SITE_URL, 'Acessar minha conta')}
    <p style="font-size:14px;line-height:1.6;color:#aaa">Em 5 minutos você consegue:</p>
    <ul style="font-size:14px;line-height:1.8;color:#aaa;padding-left:20px">
      <li>Cadastrar seu primeiro imóvel</li>
      <li>Conectar o WhatsApp Business</li>
      <li>Receber o primeiro lead automatizado</li>
    </ul>
    <p style="font-size:13px;color:#888;line-height:1.6">Qualquer dúvida, é só responder este email.</p>
  `;
  return send({ to, subject: 'Bem-vindo à LeadHouse — 14 dias grátis', html: wrap(content, 'Boas-vindas') });
}

async function sendTrialExpiring({ to, nome, diasRestantes }) {
  const urgencia = diasRestantes <= 1 ? 'Seu trial expira amanhã' : `Faltam ${diasRestantes} dias do seu trial`;
  const content = `
    <p style="font-size:15px;line-height:1.6">Olá ${nome || ''},</p>
    <p style="font-size:15px;line-height:1.6">${urgencia}. Pra continuar com leads ilimitados e o agente de IA, escolha um plano antes que o acesso seja bloqueado.</p>
    ${btn('https://leadhouses.com.br/#planos', 'Escolher meu plano')}
    <p style="font-size:13px;color:#888;line-height:1.6">Você não vai perder nenhum dado — todos os leads, imóveis e visitas continuam guardados quando você assinar.</p>
  `;
  return send({ to, subject: urgencia + ' — LeadHouse', html: wrap(content, 'Trial expirando') });
}

async function sendPaymentSuccess({ to, nome, plano }) {
  const planoNome = (plano || '').charAt(0).toUpperCase() + (plano || '').slice(1);
  const content = `
    <p style="font-size:15px;line-height:1.6">Olá ${nome || ''},</p>
    <p style="font-size:15px;line-height:1.6">Pagamento confirmado! 🎉 Você agora está no plano <b>${planoNome}</b>.</p>
    ${btn(SITE_URL, 'Acessar minha conta')}
    <p style="font-size:13px;color:#888;line-height:1.6">A nota fiscal e os recibos ficam disponíveis no portal de cobrança (Configurações → Plano → Gerenciar).</p>
  `;
  return send({ to, subject: 'Pagamento confirmado — LeadHouse', html: wrap(content, 'Pagamento aprovado') });
}

async function sendPaymentFailed({ to, nome }) {
  const content = `
    <p style="font-size:15px;line-height:1.6">Olá ${nome || ''},</p>
    <p style="font-size:15px;line-height:1.6">Não conseguimos processar seu último pagamento. Pode ser cartão expirado, limite, ou bloqueio antifraude.</p>
    ${btn(SITE_URL + '/?tab=conta', 'Atualizar forma de pagamento')}
    <p style="font-size:13px;color:#888;line-height:1.6">Tentaremos novamente automaticamente em 24h. Se quiser, pode atualizar o cartão no portal de cobrança a qualquer momento.</p>
  `;
  return send({ to, subject: 'Pagamento não processado — atualize seu cartão', html: wrap(content, 'Pagamento falhou') });
}

async function sendSubscriptionCanceled({ to, nome, fimAcesso }) {
  const dataFim = fimAcesso ? new Date(fimAcesso).toLocaleDateString('pt-BR') : 'fim do período já pago';
  const content = `
    <p style="font-size:15px;line-height:1.6">Olá ${nome || ''},</p>
    <p style="font-size:15px;line-height:1.6">Sua assinatura foi cancelada. Seu acesso continua ativo até <b>${dataFim}</b>.</p>
    <p style="font-size:15px;line-height:1.6">Se mudar de ideia, pode reativar a qualquer momento sem perder seus dados.</p>
    ${btn(SITE_URL + '/?tab=conta', 'Reativar assinatura')}
    <p style="font-size:13px;color:#888;line-height:1.6">Se cancelou por algum problema, queremos saber — só responder este email.</p>
  `;
  return send({ to, subject: 'Assinatura cancelada — LeadHouse', html: wrap(content, 'Cancelamento') });
}

module.exports = {
  send,
  sendWelcome,
  sendTrialExpiring,
  sendPaymentSuccess,
  sendPaymentFailed,
  sendSubscriptionCanceled,
};
