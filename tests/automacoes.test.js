const test = require('node:test');
const assert = require('node:assert/strict');
const {
  configUsuario, acoesLeadQuente, visitaInstante, marcosVisita, slaEstourado, chaveSla, dataCurta, telefoneWhatsApp,
} = require('../utils/automacoesRegras');

const H = 60 * 60 * 1000;
const quente = { tipo: 'temperatura_mudou', de: 'frio', para: 'quente' };

test('config usa o padrao da receita quando nao ha linha salva', () => {
  const c = configUsuario([]);
  assert.equal(c.lead_quente.ativo, true);
  assert.equal(c.lembrete_visita.ativo, false);
  assert.deepEqual(c.sla_corretor.config, { horas: 48, estagios: ['atendimento'] });
});

test('config salva sobrescreve o padrao e mescla o config', () => {
  const c = configUsuario([{ receita: 'sla_corretor', ativo: false, config: { horas: 24 } }]);
  assert.equal(c.sla_corretor.ativo, false);
  assert.deepEqual(c.sla_corretor.config, { horas: 24, estagios: ['atendimento'] });
});

test('lead que vira quente em estagio inicial gera push e mover', () => {
  for (const estagio of ['novo', 'atendimento', undefined]) {
    assert.deepEqual(
      acoesLeadQuente(quente, { temperatura: 'quente', estagio }).map(a => a.tipo),
      ['push', 'mover_estagio'], String(estagio));
  }
});

test('lead quente adiantado no funil so recebe push (nunca regride)', () => {
  for (const estagio of ['qualificado', 'visita', 'proposta', 'fechado', 'perdido']) {
    assert.deepEqual(acoesLeadQuente(quente, { temperatura: 'quente', estagio }).map(a => a.tipo), ['push'], estagio);
  }
});

test('outros eventos nao geram acao', () => {
  assert.deepEqual(acoesLeadQuente({ tipo: 'temperatura_mudou', de: 'quente', para: 'morno' }, { temperatura: 'morno' }), []);
  assert.deepEqual(acoesLeadQuente({ tipo: 'estagio_mudou', para: 'visita' }, { temperatura: 'quente' }), []);
  // esfriou de novo antes do worker rodar
  assert.deepEqual(acoesLeadQuente(quente, { temperatura: 'morno', estagio: 'novo' }), []);
});

test('visitaInstante interpreta horario de Recife (UTC-3)', () => {
  assert.equal(visitaInstante('2026-10-08', '14:00').toISOString(), '2026-10-08T17:00:00.000Z');
  assert.equal(visitaInstante('2026-10-08', '14:00:00').toISOString(), '2026-10-08T17:00:00.000Z');
  assert.equal(visitaInstante('', '14:00'), null);
  assert.equal(visitaInstante('lixo', '14:00'), null);
});

test('marcos de visita nas janelas', () => {
  const v = { data: '2026-10-08', horario: '14:00', status: 'agendada' };
  const inicio = visitaInstante(v.data, v.horario).getTime();
  const em = h => new Date(inicio - h * H);
  assert.deepEqual(marcosVisita(v, em(24)), ['24h']);
  assert.deepEqual(marcosVisita(v, em(25)), ['24h']);
  assert.deepEqual(marcosVisita(v, em(25.1)), []);
  assert.deepEqual(marcosVisita(v, em(23)), []);
  assert.deepEqual(marcosVisita(v, em(2)), ['2h']);
  assert.deepEqual(marcosVisita(v, em(12)), []);
  assert.deepEqual(marcosVisita(v, em(-20)), ['pos']);
  assert.deepEqual(marcosVisita(v, em(-31)), []);
});

test('visita cancelada nao gera marcos; realizada so gera pos', () => {
  const base = { data: '2026-10-08', horario: '14:00' };
  const inicio = visitaInstante(base.data, base.horario).getTime();
  assert.deepEqual(marcosVisita({ ...base, status: 'cancelada' }, new Date(inicio - 24 * H)), []);
  assert.deepEqual(marcosVisita({ ...base, status: 'cancelada' }, new Date(inicio + 20 * H)), []);
  assert.deepEqual(marcosVisita({ ...base, status: 'realizada' }, new Date(inicio - 24 * H)), []);
  assert.deepEqual(marcosVisita({ ...base, status: 'realizada' }, new Date(inicio + 20 * H)), ['pos']);
});

test('SLA estoura so depois do limite e no estagio configurado', () => {
  const agora = new Date('2026-10-07T12:00:00Z');
  const cfg = { horas: 48, estagios: ['atendimento'] };
  const lead = h => ({ id: 1, estagio: 'atendimento', estagio_desde: new Date(agora - h * H).toISOString() });
  assert.equal(slaEstourado(lead(47), agora, cfg), false);
  assert.equal(slaEstourado(lead(49), agora, cfg), true);
  assert.equal(slaEstourado({ ...lead(49), estagio: 'visita' }, agora, cfg), false);
  assert.equal(slaEstourado({ ...lead(49), estagio_desde: null }, agora, cfg), false);
});

test('chave de SLA muda quando o lead reentra no estagio', () => {
  const a = { id: 7, estagio: 'atendimento', estagio_desde: '2026-10-01T10:00:00Z' };
  assert.equal(chaveSla(a), chaveSla({ ...a }));
  assert.notEqual(chaveSla(a), chaveSla({ ...a, estagio_desde: '2026-10-05T10:00:00Z' }));
});

test('telefoneWhatsApp normaliza para digitos com DDI', () => {
  assert.equal(telefoneWhatsApp('(81) 99999-0000'), '5581999990000');
  assert.equal(telefoneWhatsApp('81 3333-0000'), '558133330000');
  assert.equal(telefoneWhatsApp('5581999990000'), '5581999990000');
  assert.equal(telefoneWhatsApp('+55 (81) 99999-0000'), '5581999990000');
  assert.equal(telefoneWhatsApp('081999990000'), '5581999990000');
  assert.equal(telefoneWhatsApp(''), null);
  assert.equal(telefoneWhatsApp('123'), null);
});

test('dataCurta formata DD/MM', () => {
  assert.equal(dataCurta('2026-10-08'), '08/10');
  assert.equal(dataCurta(''), '');
});
