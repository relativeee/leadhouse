const crypto = require('node:crypto');
function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function metaAuth(req, res, next) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return res.status(503).json({ erro: 'Webhook Meta nao configurado' });
  if (!Buffer.isBuffer(req.rawBody)) return res.status(400).json({ erro: 'Corpo JSON obrigatorio' });
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  if (!equalSecret(req.headers['x-hub-signature-256'], expected)) return res.status(401).json({ erro: 'Assinatura invalida' });
  next();
}
function evolutionAuth(req, res, next) {
  const expected = process.env.EVOLUTION_WEBHOOK_TOKEN;
  if (!expected) return res.status(503).json({ erro: 'Webhook Evolution nao configurado' });
  if (!equalSecret(req.query?.token || req.headers['x-webhook-token'], expected)) return res.status(401).json({ erro: 'Token invalido' });
  next();
}
function cronAuthorized(req) {
  return equalSecret((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), process.env.CRON_SECRET);
}
module.exports = { metaAuth, evolutionAuth, cronAuthorized, equalSecret };
