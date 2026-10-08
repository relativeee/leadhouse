const test = require('node:test');
const assert = require('node:assert/strict');
const { prazoEmDias, pontosPrazo, calcularTemperatura } = require('../utils/leadScoring');

test('frases que ja pontuavam continuam com a mesma pontuacao', () => {
  for (const p of ['urgente', 'imediato', '30 dias', 'este mês']) assert.equal(pontosPrazo(p), 3, p);
  for (const p of ['3 meses', 'trimestre']) assert.equal(pontosPrazo(p), 2, p);
  for (const p of ['6 meses', 'semestre']) assert.equal(pontosPrazo(p), 1, p);
});

test('prazos em texto livre que antes valiam zero', () => {
  // "30-90 dias" e o valor sugerido pelo proprio prompt da Lia
  assert.equal(pontosPrazo('30-90 dias'), 2);
  assert.equal(pontosPrazo('2 meses'), 2);
  assert.equal(pontosPrazo('45 dias'), 2);
  assert.equal(pontosPrazo('1 mês'), 3);
  assert.equal(pontosPrazo('o quanto antes'), 3);
  assert.equal(pontosPrazo('este mes'), 3);
  assert.equal(pontosPrazo('semana que vem'), 3);
  assert.equal(pontosPrazo('mês que vem'), 2);
  assert.equal(pontosPrazo('entre 1 e 3 meses'), 2);
  assert.equal(pontosPrazo('uns quatro meses'), 1);
  assert.equal(pontosPrazo('15 dias'), 3);
});

test('prazos longos ou desconhecidos nao pontuam', () => {
  for (const p of ['1 ano', 'ano que vem', 'até 2 anos', 'sem pressa', 'não informado', 'depende', '', null, undefined]) {
    assert.equal(pontosPrazo(p), 0, String(p));
  }
  assert.equal(prazoEmDias('não informado'), null);
});

test('faixa usa o limite maior', () => {
  assert.equal(prazoEmDias('30-90 dias'), 90);
  assert.equal(prazoEmDias('1 a 3 meses'), 90);
});

test('lead completo com prazo de 2 meses agora e quente', () => {
  const lead = {
    faixa_valor: 'até 500 mil', pagamento: 'financiamento', prazo: '2 meses',
    bairro: 'Boa Viagem', tipo_imovel: 'apartamento', objetivo: 'comprar',
  };
  assert.equal(calcularTemperatura(lead), 'quente');
  assert.equal(calcularTemperatura({ ...lead, prazo: 'não informado' }), 'morno');
});
