/**
 * services/logger.js
 * Logging estruturado em JSON pra facilitar parse no Vercel/Logtail/Sentry futuro.
 *
 * Uso:
 *   const log = require('./services/logger');
 *   log.info('user_signup', { userId, email });
 *   log.error('stripe_webhook_failed', { event: type, err: err.message });
 *
 * Em producao, cada call vira uma linha JSON no stdout do Vercel,
 * facilmente filtravel via Vercel CLI ou ingestao em Sentry/Logtail.
 */

const ENV = process.env.NODE_ENV || 'development';
const PRETTY = ENV === 'development';

let Sentry = null;
if (process.env.SENTRY_DSN) {
  try { Sentry = require('@sentry/node'); } catch {}
}

function emit(level, event, ctx = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...ctx,
  };
  if (PRETTY) {
    const colors = { debug: 90, info: 36, warn: 33, error: 31 };
    const c = colors[level] || 0;
    const ctxStr = Object.keys(ctx).length ? ' ' + JSON.stringify(ctx) : '';
    console.log(`\x1b[${c}m[${level}]\x1b[0m ${event}${ctxStr}`);
  } else {
    console.log(JSON.stringify(payload));
  }

  // Erros e warnings vao tambem pro Sentry quando configurado
  if (Sentry && (level === 'error' || level === 'warn')) {
    try {
      const { err, ...rest } = ctx;
      if (err instanceof Error) {
        Sentry.captureException(err, { tags: { event }, extra: rest, level });
      } else {
        Sentry.captureMessage(event, { tags: { event }, extra: ctx, level });
      }
    } catch {}
  }
}

module.exports = {
  debug: (event, ctx) => emit('debug', event, ctx),
  info:  (event, ctx) => emit('info', event, ctx),
  warn:  (event, ctx) => emit('warn', event, ctx),
  error: (event, ctx) => emit('error', event, ctx),
};
