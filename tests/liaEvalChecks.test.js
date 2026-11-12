const test = require('node:test');
const assert = require('node:assert/strict');
const { avaliarConversa, nomesCitados } = require('../evals/lia/checks');
const { INVENTARIO } = require('../evals/lia/inventario');
const casos = require('../evals/lia/casos');

const regras = r => r.falhas.map(f => f.regra);

test('checks: a conversa ruim de 2026-10-29 é reprovada pelos motivos certos', () => {
  const turnos = [
    { lia: 'Oi! Aqui é a Lia, assistente do Luca. Tá buscando pra comprar ou alugar?', tools: [] },
    { lia: 'Opa, João, não achei em Manaíra. Mas Tambaú e Cabo Branco tão com tudo disponível. Quer ver de lá? Ou prefere esperar?', tools: [] },
    { lia: 'Vou ser sincero: tenho o **Edifício Ondas**. Já mandei a foto do Ondas. Quando surgir algo eu te aviso.', tools: [] },
  ];
  const r = avaliarConversa(turnos, { deveUsar: ['imoveis'] }, INVENTARIO);
  for (const regra of ['varias_perguntas', 'masculino', 'markdown', 'foto_sem_envio', 'imovel_inexistente', 'promessa_aviso', 'tool_nao_usada']) {
    assert.ok(regras(r).includes(regra), `faltou ${regra}: ${JSON.stringify(r.falhas)}`);
  }
});

test('checks: conversa boa passa sem falhas', () => {
  const turnos = [
    { lia: 'Oi! Aqui é a Lia, assistente do Luca. Achei o Residencial Brisa do Mar, 2 quartos em Tambaú por R$ 380 mil. Quer ver a foto?', tools: [{ nome: 'imoveis', resultado: { total: 1 } }] },
    { lia: 'Mandei a foto! Quer marcar uma visita na sexta às 10h ou no sábado às 9h?', tools: [{ nome: 'enviando_arquivos', resultado: { ok: true } }] },
  ];
  const r = avaliarConversa(turnos, { deveUsar: ['imoveis', 'enviando_arquivos'], deve: [/Brisa/] }, INVENTARIO);
  assert.deepEqual(r.falhas, []);
});

test('checks: nomes de imóvel citados', () => {
  assert.deepEqual(nomesCitados('Tenho o Edifício Mirante e a Casa Jardim do Bessa.'), ['Edifício Mirante', 'Casa Jardim do Bessa']);
});

test('casos: ids únicos, toda conversa tem mensagens e esperado', () => {
  const ids = casos.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of casos) {
    assert.ok(c.mensagens.length > 0 && c.esperado, c.id);
  }
});
