const test = require('node:test');
const assert = require('node:assert/strict');
const { recordId, validateUpdate, updateMiddleware } = require('../services/crmValidation');
test('updates reject owner and internal fields across resources', () => {
  for (const kind of ['lead','imovel','visita']) {
    for (const field of ['usuario_id','id','created_at','historico_json','origem']) {
      assert.throws(() => validateUpdate(kind, { [field]: '42' }), /Campo nao permitido/);
    }
  }
});
test('IDs are strict and safe; malformed requests are rejected', () => {
  for (const id of ['1oops','0','-1','1.5','9007199254740993']) assert.throws(() => recordId(id));
  for (const body of [null, [], {}, 'text']) assert.throws(() => validateUpdate('lead', body));
  assert.equal(recordId('12'),12);
});
test('valid UI partial edits and clearing property link are accepted', () => {
  assert.deepEqual(validateUpdate('lead', { nome: 'Maria', imovel_id: null }), { nome: 'Maria', imovel_id: null });
  assert.deepEqual(validateUpdate('imovel', { quartos: '2', foto_url: '', fotos_extras: [] }), { quartos: '2', foto_url: '', fotos_extras: [] });
  assert.deepEqual(validateUpdate('visita', { data: '2028-02-29', horario: '10:30:00' }), { data: '2028-02-29', horario: '10:30:00' });
});
test('rejects impossible calendar dates, invalid time and workflow states', () => {
  for (const data of ['2026-02-29','2026-04-31','2026-13-01']) assert.throws(() => validateUpdate('visita', { data }));
  for (const horario of ['24:00','12:60','9:30']) assert.throws(() => validateUpdate('visita', { horario }));
  assert.throws(() => validateUpdate('estagio', { estagio: 'hack' }));
  assert.throws(() => validateUpdate('lead', { temperatura: 'fervendo' }));
  assert.throws(() => validateUpdate('imovel', { status: 'agendada' }));
});
test('middleware rejects foreign property link and scopes lookup to authenticated owner', async () => {
  const filters = [];
  const db = { from(table) { assert.equal(table,'imoveis'); return { select() { return this; }, eq(k,v) { filters.push([k,v]); return this; }, async maybeSingle() { return { data: null }; } }; } };
  const res = { status(n) { this.code=n; return this; }, json(b) { this.body=b; } };
  await updateMiddleware('lead', db)({ userId: 7, params: {id:'2'}, body: { imovel_id: 99 } }, res, () => assert.fail());
  assert.equal(res.code,400); assert.deepEqual(filters,[['id',99],['usuario_id',7]]);
});
test('valid edits reach handler; invalid edits never reach database', async () => {
  let next=false; const req={params:{id:'3'},body:{nome:'Joao'}};
  await updateMiddleware('lead', {})(req, {}, () => { next=true; }); assert.equal(next,true); assert.equal(req.recordId,3);
  const res={status(n){this.code=n;return this;},json(){}};
  await updateMiddleware('lead', {from(){assert.fail();}})({params:{id:'3'},body:{usuario_id:99}},res,()=>assert.fail()); assert.equal(res.code,400);
});
