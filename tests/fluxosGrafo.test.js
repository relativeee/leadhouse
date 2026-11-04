const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../public/fluxosGrafo');
const F = require('../utils/fluxosRegras');

const rotulo = c => `<b>${c.tipo}</b>`;

// gatilho -> p1 (condicao) -sim-> [p2 push, p3 esperar, p4 whatsapp]
//                          -nao-> [p5 push] -> p4?  (p4 tem 2 antecessores: vira cartao proprio)
const ramificado = () => ({
  nome: 'Ramificado',
  gatilho: { tipo: 'lead_criado' },
  no_inicial: 'p1',
  nos: {
    p1: { tipo: 'condicao', campo: 'temperatura', op: 'igual', valor: 'quente', sim: 'p2', nao: 'p5' },
    p2: { tipo: 'acao', acao: 'push', titulo: null, texto: 'quente!', proximo: 'p3' },
    p3: { tipo: 'esperar', minutos: 60, proximo: 'p4' },
    p4: { tipo: 'acao', acao: 'whatsapp', texto: 'oi', proximo: null },
    p5: { tipo: 'acao', acao: 'push', titulo: null, texto: 'frio', proximo: 'p4' },
  },
});

const semPos = nos => Object.fromEntries(Object.entries(nos).map(([id, { pos, ...n }]) => [id, n]));

test('agrupa passos em sequência num cartão; passo com 2 antecessores abre cartão próprio', () => {
  const { cards, ligacoes, inicio } = G.paraCards(ramificado());
  assert.equal(inicio, 'p1');
  assert.deepEqual(Object.keys(cards).sort(), ['p1', 'p2', 'p4', 'p5']);
  assert.deepEqual(cards.p2.passos.map(p => p._id), ['p2', 'p3']);
  assert.deepEqual(cards.p4.passos.map(p => p._id), ['p4']);
  assert.deepEqual(ligacoes.p1, { output_1: 'p2', output_2: 'p5' });
  assert.deepEqual(ligacoes.p2, { output_1: 'p4' });
  assert.deepEqual(ligacoes.p5, { output_1: 'p4' });
});

test('ida e volta pelo Drawflow preserva o grafo e passa na validação do backend', () => {
  const f = ramificado();
  const { json, cards } = G.paraDrawflow(f, rotulo);
  const volta = G.deDrawflow(json, cards);
  assert.deepEqual(volta.erros, []);
  assert.equal(volta.no_inicial, 'p1');
  assert.deepEqual(semPos(volta.nos), f.nos);
  assert.equal(F.validarFluxo({ ...f, nos: volta.nos, no_inicial: volta.no_inicial }).ok, true);
});

test('fluxo linear vira um cartão só', () => {
  const f = { gatilho: { tipo: 'manual' }, no_inicial: 'a', nos: {
    a: { tipo: 'acao', acao: 'push', texto: 'x', proximo: 'b' },
    b: { tipo: 'esperar', minutos: 5, proximo: 'c' },
    c: { tipo: 'acao', acao: 'push', texto: 'y', proximo: null },
  } };
  const { cards } = G.paraCards(f);
  assert.deepEqual(Object.keys(cards), ['a']);
  assert.equal(cards.a.passos.length, 3);
});

test('json do Drawflow: conexões dos dois lados e saídas Sim/Não na condição', () => {
  const { json, dfPorId } = G.paraDrawflow(ramificado(), rotulo);
  const d = json.drawflow.Home.data;
  assert.equal(d[1].name, 'gatilho');
  assert.deepEqual(d[1].outputs.output_1.connections, [{ node: String(dfPorId.p1), output: 'input_1' }]);
  assert.deepEqual(Object.keys(d[dfPorId.p1].outputs), ['output_1', 'output_2']);
  assert.deepEqual(d[dfPorId.p4].inputs.input_1.connections.map(c => c.input), ['output_1', 'output_1']);
});

test('passo novo dentro do cartão e cartão novo ligado viram passos encadeados', () => {
  const f = ramificado();
  const { json, cards, dfPorId } = G.paraDrawflow(f, rotulo);
  cards.p4.passos.push({ _id: 'n1', tipo: 'acao', acao: 'mover_estagio', para: 'atendimento' });
  const volta = G.deDrawflow(json, cards);
  assert.equal(volta.nos.p4.proximo, 'n1');
  assert.equal(volta.nos.n1.proximo, null);
  assert.ok(dfPorId.p4);
});

test('erros amigáveis: gatilho solto, cartão solto, cartão vazio e ciclo', () => {
  const f = ramificado();
  const { json, cards, dfPorId } = G.paraDrawflow(f, rotulo);

  const semInicio = structuredClone(json);
  semInicio.drawflow.Home.data[1].outputs.output_1.connections = [];
  assert.match(G.deDrawflow(semInicio, cards).erros.join(), /Ligue o "Quando"/);

  const solto = structuredClone(json);
  solto.drawflow.Home.data[dfPorId.p1].outputs.output_2.connections = [];
  assert.match(G.deDrawflow(solto, cards).erros.join(), /sem ligação com o fluxo: p5/);

  const vazio = structuredClone(cards);
  vazio.p5.passos = [];
  assert.match(G.deDrawflow(json, vazio).erros.join(), /p5 está vazio/);

  const ciclo = structuredClone(json);
  ciclo.drawflow.Home.data[dfPorId.p4].outputs.output_1.connections = [{ node: String(dfPorId.p1), output: 'input_1' }];
  assert.match(G.deDrawflow(ciclo, cards).erros.join(), /voltar para um bloco anterior/);
});

test('novoId e idsEmUso contam os passos dentro dos grupos', () => {
  const { cards } = G.paraCards(ramificado());
  assert.deepEqual(G.idsEmUso(cards).sort(), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(G.novoId(['n1', 'n2', 'p1']), 'n3');
});
