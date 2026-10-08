const test = require('node:test');
const assert = require('node:assert/strict');
const { rodarCiclo } = require('../services/automacoes');
const { fakeSupabase } = require('./helpers/fakeSupabase');

function cenario(extra = {}) {
  const tabelas = {
    leads: [
      { id: 1, usuario_id: 10, nome: 'Ana', temperatura: 'quente', estagio: 'novo', resumo: 'Quer 3 quartos em Boa Viagem' },
      { id: 2, usuario_id: 10, nome: 'Bruno', temperatura: 'quente', estagio: 'proposta' },
    ],
    lead_eventos: [
      { id: 1, usuario_id: 10, lead_id: 1, tipo: 'temperatura_mudou', de: 'morno', para: 'quente', processado_em: null },
      { id: 2, usuario_id: 10, lead_id: 2, tipo: 'temperatura_mudou', de: 'frio', para: 'quente', processado_em: null },
      { id: 3, usuario_id: 10, lead_id: 1, tipo: 'estagio_mudou', de: null, para: 'novo', processado_em: null },
    ],
    automacoes: [],
    automacao_execucoes: [],
    visitas: [],
    usuarios: [{ id: 10, email: 'corretor@example.com', nome: 'Carla Souza' }],
    ...extra,
  };
  const sb = fakeSupabase(tabelas, { unique: { automacao_execucoes: ['usuario_id', 'receita', 'chave'] } });
  const pushes = [], templates = [], emailsEnviados = [];
  const deps = {
    db: {
      supabase: sb,
      async atualizarLead(id, campos, uid) { const l = tabelas.leads.find(x => x.id === id && x.usuario_id === uid); Object.assign(l, campos); return l; },
    },
    push: { disponivel: () => true, async sendPushParaCorretor(uid, p) { pushes.push({ uid, ...p }); return { sent: 1 }; } },
    emails: { async send(e) { emailsEnviados.push(e); return { sent: true }; } },
    async enviarTemplate(tel, nome, params) { templates.push({ tel, nome, params }); },
    agora: new Date('2026-10-07T15:00:00Z'),
  };
  return { tabelas, deps, pushes, templates, emailsEnviados };
}

test('lead quente: push + move de novo para qualificado; lead em proposta so recebe push', async () => {
  const { tabelas, deps, pushes } = cenario();
  const r = await rodarCiclo(deps);
  assert.equal(r.instalado, true);
  assert.equal(r.erros, 0);
  assert.equal(r.eventos, 3);
  assert.equal(pushes.length, 2);
  assert.match(pushes[0].title, /Ana/);
  assert.equal(tabelas.leads[0].estagio, 'qualificado');
  assert.equal(tabelas.leads[1].estagio, 'proposta');
  assert.ok(tabelas.lead_eventos.every(e => e.processado_em), 'todos os eventos marcados como processados');
});

test('idempotente: o mesmo evento reprocessado nao repete push nem movimento', async () => {
  const { tabelas, deps, pushes } = cenario();
  await rodarCiclo(deps);
  tabelas.lead_eventos.forEach(e => { e.processado_em = null; }); // simula retry
  const r2 = await rodarCiclo(deps);
  assert.equal(pushes.length, 2);
  assert.equal(r2.acoes, 0);
  assert.equal(r2.erros, 0, 'duplicata e pulada em silencio, nao vira erro');
  assert.ok(tabelas.lead_eventos.every(e => e.processado_em), 'retry consome a fila');
});

test('receita desligada: nao age, mas consome os eventos', async () => {
  const { tabelas, deps, pushes } = cenario({ automacoes: [{ usuario_id: 10, receita: 'lead_quente', ativo: false, config: {} }] });
  await rodarCiclo(deps);
  assert.equal(pushes.length, 0);
  assert.equal(tabelas.leads[0].estagio, 'novo');
  assert.ok(tabelas.lead_eventos.every(e => e.processado_em));
});

test('lembrete de visita: so com a receita ligada, 1 template por marco', async () => {
  const visita = { id: 5, usuario_id: 10, lead_nome: 'Ana', lead_telefone: '(81) 99999-0000', imovel_titulo: 'Apto Boa Viagem', data: '2026-10-08', horario: '12:00:00', status: 'agendada' };
  // agora = 07/10 12:00 Recife -> visita em 24h
  const desligado = cenario({ lead_eventos: [], visitas: [{ ...visita }] });
  await rodarCiclo(desligado.deps);
  assert.equal(desligado.templates.length, 0);

  const ligado = cenario({ lead_eventos: [], visitas: [{ ...visita }], automacoes: [{ usuario_id: 10, receita: 'lembrete_visita', ativo: true, config: {} }] });
  await rodarCiclo(ligado.deps);
  await rodarCiclo(ligado.deps);
  assert.equal(ligado.templates.length, 1);
  assert.deepEqual(ligado.templates[0], { tel: '5581999990000', nome: 'lembrete_visita', params: ['Ana', '08/10', '12:00', 'Apto Boa Viagem'] });
  assert.equal(ligado.pushes.length, 1);
});

test('SLA: avisa uma vez (push + email agregado) e ignora lead parado ha muito tempo', async () => {
  const agora = new Date('2026-10-07T15:00:00Z');
  const h = n => new Date(agora - n * 3600e3).toISOString();
  const { deps, pushes, emailsEnviados } = cenario({
    lead_eventos: [],
    leads: [
      { id: 1, usuario_id: 10, nome: 'Ana', estagio: 'atendimento', estagio_desde: h(50) },
      { id: 2, usuario_id: 10, nome: 'Bruno', estagio: 'atendimento', estagio_desde: h(60) },
      { id: 3, usuario_id: 10, nome: 'Caio', estagio: 'atendimento', estagio_desde: h(10) },
      { id: 4, usuario_id: 10, nome: 'Duda', estagio: 'atendimento', estagio_desde: h(200) }, // antigo: fora da janela
      { id: 5, usuario_id: 10, nome: 'Eva', estagio: 'visita', estagio_desde: h(50) },
    ],
  });
  await rodarCiclo(deps);
  await rodarCiclo(deps);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /2 leads parados há 48h/);
  assert.equal(emailsEnviados.length, 1);
  assert.match(emailsEnviados[0].html, /Ana/);
  assert.match(emailsEnviados[0].html, /Bruno/);
  assert.doesNotMatch(emailsEnviados[0].html, /Caio|Duda|Eva/);
});

test('migration ainda nao rodou: ciclo vira no-op sem erro', async () => {
  const { deps } = cenario();
  deps.db.supabase = fakeSupabase({}, { ausentes: ['lead_eventos', 'automacoes', 'automacao_execucoes'] });
  const r = await rodarCiclo(deps);
  assert.equal(r.instalado, false);
});

test('falha no envio fica registrada como erro e nao derruba o ciclo', async () => {
  const visita = { id: 5, usuario_id: 10, lead_nome: 'Ana', lead_telefone: '81999990000', imovel_titulo: '', data: '2026-10-08', horario: '12:00', status: 'agendada' };
  const { tabelas, deps } = cenario({ visitas: [visita], automacoes: [{ usuario_id: 10, receita: 'lembrete_visita', ativo: true, config: {} }] });
  deps.enviarTemplate = async () => { throw new Error('template not approved'); };
  const r = await rodarCiclo(deps);
  assert.equal(r.erros, 1);
  const exec = tabelas.automacao_execucoes.find(e => e.receita === 'lembrete_visita');
  assert.equal(exec.status, 'erro');
  assert.match(exec.detalhe, /template not approved/);
  assert.ok(r.acoes >= 2, 'as acoes de lead quente seguiram normalmente');
});
