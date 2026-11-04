const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../utils/imoveisBusca');

// Formatos reais encontrados na tabela imoveis (valor/quartos sao TEXT).
const im = (id, bairro, valor, quartos, extra = {}) => ({ id, titulo: `Imóvel ${id}`, tipo: 'Apartamento', bairro, valor, quartos, foto_url: 'https://x/f.jpg', ...extra });

test('parseValorImovel: formatos do banco e do lead', () => {
  assert.equal(B.parseValorImovel('2500000'), 2500000);
  assert.equal(B.parseValorImovel('2.500.000'), 2500000);
  assert.equal(B.parseValorImovel('795.000'), 795000);
  assert.equal(B.parseValorImovel('R$ 1.250.000,00'), 1250000);
  assert.equal(B.parseValorImovel('2,5 mi'), 2500000);
  assert.equal(B.parseValorImovel('850 mil'), 850000);
  assert.equal(B.parseValorImovel(459000), 459000);
  assert.equal(B.parseValorImovel(''), null);
  assert.equal(B.parseValorImovel('sob consulta'), null);
});

test('buscarImoveis: 2,5 mi NÃO passa em "até 700 mil" (bug do filtro em texto)', () => {
  const r = B.buscarImoveis([im(1, 'Miramar', '2500000', '4')], { valor_max: 700000 });
  assert.equal(r.total, 0);
  assert.equal(r.imoveis.length, 0);
  assert.match(r.alternativas[0].nao_atende.join(), /valor \(R\$ 2\.500\.000, acima de R\$ 700\.000\)/);
});

test('buscarImoveis: 10 quartos passa em "3 ou mais" (outro lado do bug)', () => {
  const r = B.buscarImoveis([im(1, 'Bessa', '900000', '10')], { quartos_min: 3 });
  assert.equal(r.total, 1);
  assert.equal(r.imoveis[0].quartos, 10);
});

test('buscarImoveis: bairro ignora acento e caixa; ordena por valor', () => {
  const lista = [im(1, 'Tambaú', '795.000', '3'), im(2, 'tambau', '459000', '3'), im(3, 'Manaíra', '500000', '3')];
  const r = B.buscarImoveis(lista, { bairro: 'Tambau', quartos_min: 3, valor_max: 800000 });
  assert.deepEqual(r.imoveis.map(i => i.id), [2, 1]);
  assert.equal(r.imoveis[0].valor, 'R$ 459.000');
});

test('buscarImoveis: sem match devolve alternativas reais e aviso com o total', () => {
  const lista = [im(1, 'Miramar', '2500000', '4'), im(2, 'Bessa', '650000', '2')];
  const r = B.buscarImoveis(lista, { bairro: 'Manaíra', quartos_min: 3, valor_max: 700000 });
  assert.equal(r.total, 0);
  assert.equal(r.total_imoveis_disponiveis_do_corretor, 2);
  assert.equal(r.alternativas.length, 2);
  assert.match(r.aviso, /só 2 imóvel/);
  assert.ok(r.alternativas.every(a => a.nao_atende.length > 0));
});

test('buscarImoveis: corretor sem imóveis', () => {
  const r = B.buscarImoveis([], { bairro: 'Manaíra' });
  assert.equal(r.total, 0);
  assert.equal(r.alternativas, undefined);
  assert.match(r.aviso, /nenhum imóvel disponível/);
});
