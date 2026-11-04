const { randomUUID } = require('node:crypto');
// Durable claim and per-conversation lease across Vercel instances. Responses are
// buffered until the ledger is committed. Ambiguous failures are never auto-replayed.
function durableWebhook(db, provider, handler) {
  return async (req, res) => {
    let scope;
    try {
      if (provider === 'evolution') {
        if (!['messages.upsert', 'MESSAGES_UPSERT'].includes(req.body?.event)) return await handler(req, res);
        const msg = req.body?.data;
        if (!msg || msg.key?.remoteJid?.endsWith('@g.us')) return res.json({ received: true });
        const { data: user, error } = await db.from('usuarios').select('id').eq('evolution_instance_name', req.body.instance).maybeSingle();
        if (error) throw error;
        if (!user) return res.status(404).json({ erro: 'Instancia sem dono' });
        scope = { user: user.id, phone: msg.key?.remoteJid?.split('@')[0], id: msg.key?.id };
      } else {
        const changes = (req.body?.entry || []).flatMap(entry =>
          (entry.changes || []).map(change => ({ entry, change })));
        if (changes.length > 1) {
          for (const { entry, change } of changes) {
            const itemReq = Object.create(req);
            itemReq.body = { ...req.body, entry: [{ ...entry, changes: [change] }] };
            let code = 200, body;
            const itemRes = { status(n) { code = n; return this; }, json(b) { body = b; return this; }, sendStatus(n) { code = n; return this; } };
            await durableWebhook(db, provider, handler)(itemReq, itemRes);
            if (code >= 400) return res.status(code).json(body || { erro: 'Falha no lote' });
          }
          return res.sendStatus(200);
        }
        const value = req.body?.entry?.[0]?.changes?.[0]?.value;
        const messages = value?.messages;
        if (!messages?.length) return res.sendStatus(200);
        if (messages.length > 1) {
          // Process each item with its own durable claim. A batch retry skips items
          // already committed and retries only items that were busy.
          for (const message of messages) {
            const itemReq = Object.create(req);
            itemReq.body = { ...req.body, entry: [{ ...req.body.entry[0], changes: [{
              ...req.body.entry[0].changes[0], value: { ...value, messages: [message] },
            }] }] };
            let code = 200, body;
            const itemRes = { status(n) { code = n; return this; }, json(b) { body = b; return this; }, sendStatus(n) { code = n; return this; } };
            await durableWebhook(db, provider, handler)(itemReq, itemRes);
            if (code >= 400) return res.status(code).json(body || { erro: 'Falha no lote' });
          }
          return res.sendStatus(200);
        }
        const userId = Number(process.env.META_WEBHOOK_USER_ID);
        if (!Number.isSafeInteger(userId) || userId <= 0 || !process.env.WHATSAPP_PHONE_ID) return res.status(503).json({ erro: 'Dono Meta nao configurado' });
        if (value.metadata?.phone_number_id !== process.env.WHATSAPP_PHONE_ID) return res.status(403).json({ erro: 'Numero Meta invalido' });
        const { data: user, error } = await db.from('usuarios').select('id').eq('id', userId).maybeSingle();
        if (error) throw error;
        if (!user) return res.status(503).json({ erro: 'Dono Meta inexistente' });
        scope = { user: user.id, phone: messages[0].from, id: messages[0].id };
        req.webhookUserId = user.id;
      }
      if (!scope.phone || !scope.id) return res.status(400).json({ erro: 'Identificador de mensagem obrigatorio' });
      const owner = randomUUID();
      const args = { p_provider: provider, p_user: scope.user, p_phone: scope.phone, p_event: scope.id, p_owner: owner };
      const { data: claim, error } = await db.rpc('claim_whatsapp_event', args);
      if (error) throw error;
      if (claim === 'done') return res.status(200).json({ received: true, idempotent: true });
      if (claim !== 'claimed') return res.status(503).json({ erro: 'Conversa ocupada ou evento pendente de revisao' });
      const response = { status: 200, kind: 'json', body: { received: true } };
      const buffered = Object.create(res);
      buffered.status = code => { response.status = code; return buffered; };
      buffered.json = body => { response.kind = 'json'; response.body = body; return buffered; };
      buffered.sendStatus = code => { response.status = code; response.kind = 'status'; return buffered; };
      try { await handler(req, buffered); }
      catch (err) { response.status = 500; response.body = { erro: 'Erro interno' }; }
      const { error: finishError } = await db.rpc('finish_whatsapp_event', { ...args, p_success: response.status < 400 });
      if (finishError) throw finishError;
      if (response.kind === 'status') return res.sendStatus(response.status);
      return res.status(response.status).json(response.body);
    } catch (err) {
      console.error(`[${provider} ledger]`, err.message);
      return res.status(503).json({ erro: 'Processamento indisponivel' });
    }
  };
}
module.exports = { durableWebhook };
