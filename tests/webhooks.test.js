const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { metaAuth, evolutionAuth, cronAuthorized } = require('../services/webhookSecurity');
const { durableWebhook } = require('../services/webhookEvents');
function response() { return { code: 200, status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; }, sendStatus(n) { this.code = n; return this; } }; }
test('Meta validates exact signed bytes and rejects missing configuration', () => {
  const saved = process.env.META_APP_SECRET;
  try {
    process.env.META_APP_SECRET = 'test-secret';
    const rawBody = Buffer.from('{ "hello": "world" }');
    const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
    let next = false;
    metaAuth({ rawBody, headers: { 'x-hub-signature-256': signature } }, response(), () => { next = true; });
    assert.equal(next, true);
    const bad = response();
    metaAuth({ rawBody: Buffer.from('{}'), headers: { 'x-hub-signature-256': signature } }, bad, () => assert.fail());
    assert.equal(bad.code, 401);
    const parsed = response();
    metaAuth({ headers: {} }, parsed, () => assert.fail());
    assert.equal(parsed.code, 400);
    delete process.env.META_APP_SECRET;
    const absent = response(); metaAuth({}, absent, () => assert.fail()); assert.equal(absent.code, 503);
  } finally { if (saved === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = saved; }
});
test('Evolution and cron fail closed; user-agent is not authentication', () => {
  const saved = process.env.EVOLUTION_WEBHOOK_TOKEN, cron = process.env.CRON_SECRET;
  try {
    delete process.env.EVOLUTION_WEBHOOK_TOKEN; delete process.env.CRON_SECRET;
    const r = response(); evolutionAuth({}, r, () => assert.fail()); assert.equal(r.code, 503);
    assert.equal(cronAuthorized({ headers: { 'user-agent': 'vercel-cron/1.0' } }), false);
    process.env.EVOLUTION_WEBHOOK_TOKEN = 'secret';
    let called = false; evolutionAuth({ query: { token: 'secret' } }, response(), () => { called = true; }); assert.equal(called, true);
    const bad = response(); evolutionAuth({ headers: { 'x-webhook-token': ['secret'] } }, bad, () => assert.fail()); assert.equal(bad.code, 401);
  } finally { if (saved === undefined) delete process.env.EVOLUTION_WEBHOOK_TOKEN; else process.env.EVOLUTION_WEBHOOK_TOKEN = saved; if (cron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = cron; }
});
test('same phone has isolated histories for different owners, including eviction', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const start = source.indexOf('const conversas = {}');
  const end = source.indexOf('// Parseia string de valor', start);
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end) + '\nthis.get = getConversa;', context);
  context.get(1, '5511').historico.push({ content: 'private' });
  assert.equal(context.get(2, '5511').historico.length, 0);
  assert.equal(context.get(1, '5511').historico[0].content, 'private');
});
function fakeDb(claim = 'claimed', finishError = null) {
  const calls = [];
  return { calls, from() { return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { id: 7 } }; } }; }, async rpc(name, args) { calls.push({ name, args }); return name === 'claim_whatsapp_event' ? { data: claim } : { error: finishError }; } };
}
const req = () => ({ body: { event: 'messages.upsert', instance: 'instance-7', data: { key: { id: 'msg-1', remoteJid: '5511@s.whatsapp.net' } } } });
test('duplicate and busy events never invoke handler', async () => {
  for (const claim of ['done', 'busy', 'review']) {
    const db = fakeDb(claim), res = response();
    await durableWebhook(db, 'evolution', () => assert.fail())(req(), res);
    assert.equal(res.code, claim === 'done' ? 200 : 503);
    assert.equal(db.calls.length, 1);
  }
});
test('ledger commits before acknowledgement and marks thrown failures', async () => {
  const db = fakeDb(), res = response();
  await durableWebhook(db, 'evolution', async (_, buffered) => { buffered.json({ ok: true }); assert.equal(res.body, undefined); })(req(), res);
  assert.equal(db.calls[1].args.p_success, true); assert.deepEqual(res.body, { ok: true });
  const failed = fakeDb(), r = response();
  await durableWebhook(failed, 'evolution', async () => { throw Error('send timed out'); })(req(), r);
  assert.equal(r.code, 500); assert.equal(failed.calls[1].args.p_success, false);
});
test('ledger failure cannot acknowledge successful processing', async () => {
  const db = fakeDb('claimed', { message: 'DB unavailable' }), res = response();
  await durableWebhook(db, 'evolution', async (_, r) => r.json({ ok: true }))(req(), res);
  assert.equal(res.code, 503);
});
test('Meta processes every message in a batch with the configured owner', async () => {
  const savedUser = process.env.META_WEBHOOK_USER_ID, savedPhone = process.env.WHATSAPP_PHONE_ID;
  try {
    process.env.META_WEBHOOK_USER_ID = '7'; process.env.WHATSAPP_PHONE_ID = 'number-7';
    const db = fakeDb(), seen = [], res = response();
    const value = { metadata: { phone_number_id: 'number-7' }, messages: [{ id: 'm1', from: '5511' }, { id: 'm2', from: '5511' }] };
    await durableWebhook(db, 'meta', async (r, s) => { seen.push([r.webhookUserId, r.body.entry[0].changes[0].value.messages[0].id]); s.sendStatus(200); })({ body: { entry: [{ changes: [{ value }] }] } }, res);
    assert.deepEqual(seen, [[7, 'm1'], [7, 'm2']]); assert.equal(res.code, 200);
    value.metadata.phone_number_id = 'other-number';
    const rejected = response(); await durableWebhook(db, 'meta', () => assert.fail())({ body: { entry: [{ changes: [{ value }] }] } }, rejected);
    assert.equal(rejected.code, 403);
  } finally {
    if (savedUser === undefined) delete process.env.META_WEBHOOK_USER_ID; else process.env.META_WEBHOOK_USER_ID = savedUser;
    if (savedPhone === undefined) delete process.env.WHATSAPP_PHONE_ID; else process.env.WHATSAPP_PHONE_ID = savedPhone;
  }
});
