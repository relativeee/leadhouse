const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../utils/fluxosRegras');

const base = () => ({
  nome: 'Follow-up',
  gatilho: { tipo: 'lead_parado', estagio: 'atendimento', horas: 24 },
  no_inicial: 'p1',
  nos: {
    p1: { tipo: 'acao', acao: 'whatsapp', texto: 'Oi {primeiro_nome}', proximo: 'p2' },
    p2: { tipo: 'esperar', minutos: 2880, proximo: 'p3' },
    p3: { tipo: 'condicao', campo: 'temperatura', op: 'igual', valor: 'frio', sim: 'p4', nao: null },
    p4: { tipo: 'acao', acao: 'mover_estagio', para: 'perdido', proximo: null },
  },
});

test('validarFluxo: aceita um fluxo linear e normaliza', () => {
  const v = F.validarFluxo(base());
  assert.equal(v.ok, true, v.erros.join('; '));
  assert.equal(v.fluxo.parar_se_responder, true);
  assert.deepEqual(v.fluxo.gatilho, { tipo: 'lead_parado', estagio: 'atendimento', horas: 24 });
});

test('validarFluxo: recusa ciclo, passo solto e ligação inexistente', () => {
  const ciclo = base();
  ciclo.nos.p4.proximo = 'p1';
  assert.match(F.validarFluxo(ciclo).erros.join(), /ciclo/);

  const solto = base();
  solto.nos.p9 = { tipo: 'esperar', minutos: 10, proximo: null };
  assert.match(F.validarFluxo(solto).erros.join(), /nunca são alcançados: p9/);

  const quebrado = base();
  quebrado.nos.p1.proximo = 'xx';
  assert.match(F.validarFluxo(quebrado).erros.join(), /não existe/);
});

test('validarFluxo: recusa campos e valores fora da lista', () => {
  const f = base();
  f.nos.p3.campo = 'senha_hash';
  f.nos.p4.para = 'inventado';
  f.gatilho.horas = 0;
  const erros = F.validarFluxo(f).erros.join(' | ');
  assert.match(erros, /campo da condição inválido/);
  assert.match(erros, /estágio inválido/);
  assert.match(erros, /Horas do gatilho/);
});

test('validarFluxo: limita tamanho do texto e quantidade de passos', () => {
  const longo = base();
  longo.nos.p1.texto = 'x'.repeat(1001);
  assert.equal(F.validarFluxo(longo).ok, false);

  const muitos = { ...base(), nos: {}, no_inicial: 'n0' };
  for (let i = 0; i < 31; i++) muitos.nos['n' + i] = { tipo: 'esperar', minutos: 1, proximo: i < 30 ? 'n' + (i + 1) : null };
  assert.match(F.validarFluxo(muitos).erros.join(), /Máximo de 30 passos/);
});

test('gatilhoCasa: filtra pelo destino quando informado', () => {
  assert.equal(F.gatilhoCasa({ tipo: 'estagio_mudou', para: 'visita' }, { tipo: 'estagio_mudou', para: 'visita' }), true);
  assert.equal(F.gatilhoCasa({ tipo: 'estagio_mudou', para: 'visita' }, { tipo: 'estagio_mudou', para: 'proposta' }), false);
  assert.equal(F.gatilhoCasa({ tipo: 'estagio_mudou', para: null }, { tipo: 'estagio_mudou', para: 'proposta' }), true);
  assert.equal(F.gatilhoCasa({ tipo: 'lead_parado' }, { tipo: 'estagio_mudou' }), false);
});

test('avaliarCondicao: ignora acento/caixa e trata "não informado" como vazio', () => {
  const lead = { bairro: 'Manaíra', faixa_valor: 'não informado' };
  assert.equal(F.avaliarCondicao({ campo: 'bairro', op: 'igual', valor: 'manaira' }, lead), true);
  assert.equal(F.avaliarCondicao({ campo: 'bairro', op: 'contem', valor: 'NAI' }, lead), true);
  assert.equal(F.avaliarCondicao({ campo: 'faixa_valor', op: 'vazio' }, lead), true);
  assert.equal(F.avaliarCondicao({ campo: 'faixa_valor', op: 'nao_vazio' }, lead), false);
});

test('renderTexto: substitui variáveis e some com as vazias', () => {
  const lead = { nome: 'Júlia Ramos', bairro: 'não informado' };
  assert.equal(F.renderTexto('Oi {primeiro_nome}, aqui é {corretor}!', lead, { nome: 'Carla Souza' }), 'Oi Júlia, aqui é Carla!');
  assert.equal(F.renderTexto('Opções em {bairro} .', lead, {}), 'Opções em.');
  assert.equal(F.renderTexto('{desconhecida}', lead, {}), '{desconhecida}');
});

test('horário de trabalho: Recife UTC-3, dias e sábado especial', () => {
  const ht = { inicio: '08:00', fim: '18:00', dias: [1, 2, 3, 4, 5, 6], especial: { 6: { inicio: '08:00', fim: '15:00' } } };
  // qua 07/10/2026 15:00Z = 12:00 Recife
  assert.equal(F.dentroDoHorario(ht, new Date('2026-10-07T15:00:00Z')), true);
  // qua 22:00Z = 19:00 Recife -> fora; proximo = qui 08:00 Recife = 11:00Z
  assert.equal(F.proximoHorarioUtil(ht, new Date('2026-10-07T22:00:00Z')).toISOString(), '2026-10-08T11:00:00.000Z');
  // sab 10/10 19:00Z = 16:00 Recife -> fora (sabado ate 15h); domingo nao trabalha -> seg 08:00
  assert.equal(F.proximoHorarioUtil(ht, new Date('2026-10-10T19:00:00Z')).toISOString(), '2026-10-12T11:00:00.000Z');
  // qua 09:00Z = 06:00 Recife -> mesmo dia 08:00
  assert.equal(F.proximoHorarioUtil(ht, new Date('2026-10-07T09:00:00Z')).toISOString(), '2026-10-07T11:00:00.000Z');
  // sem horario configurado: usa o padrao 08-18 seg-sab
  assert.equal(F.dentroDoHorario(null, new Date('2026-10-07T15:00:00Z')), true);
});

test('inicioDoDiaRecife e janela de 24h', () => {
  assert.equal(F.inicioDoDiaRecife(new Date('2026-10-08T02:00:00Z')).toISOString(), '2026-10-07T03:00:00.000Z');
  const agora = new Date('2026-10-07T15:00:00Z');
  assert.equal(F.dentroJanela24h('2026-10-07T00:00:00Z', agora), true);
  assert.equal(F.dentroJanela24h('2026-10-06T14:00:00Z', agora), false);
  assert.equal(F.dentroJanela24h(null, agora), false);
});

test('planoPermiteFluxos: Pro/Elite/trial válido/admin sim; Start e trial vencido não', () => {
  const agora = new Date('2026-10-07T15:00:00Z');
  assert.equal(F.planoPermiteFluxos({ plano: 'elite' }, agora), true);
  assert.equal(F.planoPermiteFluxos({ plano: 'PRO' }, agora), true);
  assert.equal(F.planoPermiteFluxos({ plano: null, is_admin: true }, agora), true);
  assert.equal(F.planoPermiteFluxos({ plano: 'trial', trial_expires_at: '2026-10-08T00:00:00Z' }, agora), true);
  assert.equal(F.planoPermiteFluxos({ plano: 'trial', trial_expires_at: '2026-10-01T00:00:00Z' }, agora), false);
  assert.equal(F.planoPermiteFluxos({ plano: 'start' }, agora), false);
});
