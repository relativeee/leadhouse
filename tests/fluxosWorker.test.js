const test = require('node:test');
const assert = require('node:assert/strict');
const { rodarCiclo } = require('../services/automacoes');
const { fakeSupabase } = require('./helpers/fakeSupabase');

const QUA_12H_RECIFE = new Date('2026-10-07T15:00:00Z');
const MIN = 60 * 1000;
const HT = { inicio: '08:00', fim: '18:00', dias: [1, 2, 3, 4, 5, 6] };

function fluxo(id, gatilho, nos, extra = {}) {
  return { id, usuario_id: 10, nome: `Fluxo ${id}`, ativo: true, gatilho, nos, no_inicial: 'p1', parar_se_responder: true, ...extra };
}

function cenario({ agora = QUA_12H_RECIFE, usuario = {}, ...extra } = {}) {
  const tabelas = {
    usuarios: [{ id: 10, nome: 'Carla Souza', email: 'carla@example.com', plano: 'pro', horario_trabalho: HT, evolution_instance_status: 'connected', ...usuario }],
    leads: [{ id: 1, usuario_id: 10, nome: 'Ana Lima', telefone: '81999990000', temperatura: 'morno', estagio: 'novo', lia_pausada: false }],
    lead_eventos: [],
    automacoes: [],
    automacao_execucoes: [],
    visitas: [],
    fluxos: [],
    fluxo_inscricoes: [],
    ...extra,
  };
  const relogio = { agora };
  const sb = fakeSupabase(tabelas, {
    unique: {
      automacao_execucoes: ['usuario_id', 'receita', 'chave'],
      fluxo_inscricoes: [
        { cols: ['fluxo_id', 'lead_id'], onde: r => r.status === 'ativa' },
        { cols: ['fluxo_id', 'origem_chave'], onde: r => r.origem_chave != null },
      ],
    },
    defaults: { automacao_execucoes: () => ({ criado_em: relogio.agora.toISOString() }) },
  });
  const enviados = [], pushes = [], meta = [];
  const deps = {
    db: {
      supabase: sb,
      async atualizarLead(id, campos, uid) { const l = tabelas.leads.find(x => x.id === id && x.usuario_id === uid); Object.assign(l, campos); return l; },
    },
    push: { disponivel: () => true, async sendPushParaCorretor(uid, p) { pushes.push({ uid, ...p }); return { sent: 1 }; } },
    emails: { async send() { return { sent: true }; } },
    evolution: { async sendText(uid, tel, msg) { enviados.push({ uid, tel, msg }); } },
    async enviarMensagem(tel, msg) { meta.push({ tel, msg }); },
    async enviarTemplate() {},
  };
  const rodar = async (quando) => {
    if (quando) relogio.agora = quando;
    return rodarCiclo({ ...deps, agora: relogio.agora });
  };
  return { tabelas, rodar, enviados, pushes, meta };
}

const evento = (id, tipo, extra = {}) => ({ id, usuario_id: 10, lead_id: 1, tipo, processado_em: null, ...extra });

test('lead novo entra no fluxo, recebe WhatsApp, espera e segue', async () => {
  const c = cenario({
    lead_eventos: [evento(1, 'lead_criado')],
    fluxos: [fluxo(7, { tipo: 'lead_criado' }, {
      p1: { tipo: 'acao', acao: 'whatsapp', texto: 'Oi {primeiro_nome}, aqui é {corretor}', proximo: 'p2' },
      p2: { tipo: 'esperar', minutos: 60, proximo: 'p3' },
      p3: { tipo: 'acao', acao: 'push', texto: 'Seguir com {nome}', proximo: null },
    })],
  });
  const r = await c.rodar();
  assert.equal(r.erros, 0, r.falhas.join());
  assert.deepEqual(c.enviados, [{ uid: 10, tel: '5581999990000', msg: 'Oi Ana, aqui é Carla' }]);
  const insc = c.tabelas.fluxo_inscricoes[0];
  assert.equal(insc.status, 'ativa');
  assert.equal(insc.no_atual, 'p3');
  assert.equal(insc.proximo_em, new Date(QUA_12H_RECIFE.getTime() + 60 * MIN).toISOString());

  await c.rodar(new Date(QUA_12H_RECIFE.getTime() + 30 * MIN)); // ainda esperando
  assert.equal(c.pushes.length, 0);

  await c.rodar(new Date(QUA_12H_RECIFE.getTime() + 61 * MIN));
  assert.equal(c.pushes.length, 1);
  assert.equal(c.pushes[0].body, 'Seguir com Ana Lima');
  assert.equal(insc.status, 'concluida');
  assert.equal(c.enviados.length, 1, 'nao repete o WhatsApp');
});

test('trava: no máximo 2 WhatsApps por lead por dia; o 3º vai para amanhã 08:00', async () => {
  const w = (n, prox) => ({ tipo: 'acao', acao: 'whatsapp', texto: `msg ${n}`, proximo: prox });
  const c = cenario({
    lead_eventos: [evento(1, 'lead_criado')],
    fluxos: [fluxo(7, { tipo: 'lead_criado' }, { p1: w(1, 'p2'), p2: w(2, 'p3'), p3: w(3, null) })],
  });
  await c.rodar();
  assert.deepEqual(c.enviados.map(e => e.msg), ['msg 1', 'msg 2']);
  const insc = c.tabelas.fluxo_inscricoes[0];
  assert.equal(insc.no_atual, 'p3');
  assert.equal(insc.proximo_em, '2026-10-08T11:00:00.000Z'); // qui 08:00 Recife

  await c.rodar(new Date('2026-10-08T11:00:00Z'));
  assert.deepEqual(c.enviados.map(e => e.msg), ['msg 1', 'msg 2', 'msg 3']);
  assert.equal(insc.status, 'concluida');
});

test('fora do horário de trabalho: WhatsApp fica para o próximo horário útil', async () => {
  const c = cenario({
    agora: new Date('2026-10-07T22:00:00Z'), // 19:00 Recife
    lead_eventos: [evento(1, 'lead_criado')],
    fluxos: [fluxo(7, { tipo: 'lead_criado' }, { p1: { tipo: 'acao', acao: 'whatsapp', texto: 'oi', proximo: null } })],
  });
  await c.rodar();
  assert.equal(c.enviados.length, 0);
  assert.equal(c.tabelas.fluxo_inscricoes[0].proximo_em, '2026-10-08T11:00:00.000Z');
});

test('lead respondeu: a sequência para', async () => {
  const c = cenario({
    lead_eventos: [evento(1, 'lead_criado')],
    fluxos: [fluxo(7, { tipo: 'lead_criado' }, {
      p1: { tipo: 'esperar', minutos: 2880, proximo: 'p2' },
      p2: { tipo: 'acao', acao: 'whatsapp', texto: 'oi de novo', proximo: null },
    })],
  });
  await c.rodar();
  c.tabelas.lead_eventos.push(evento(2, 'lead_respondeu'));
  await c.rodar();
  const insc = c.tabelas.fluxo_inscricoes[0];
  assert.equal(insc.status, 'parada');
  assert.equal(insc.motivo, 'lead respondeu');
  await c.rodar(new Date(QUA_12H_RECIFE.getTime() + 3 * 24 * 60 * MIN));
  assert.equal(c.enviados.length, 0);
});

test('condição falsa encerra o fluxo sem agir', async () => {
  const c = cenario({
    lead_eventos: [evento(1, 'lead_criado')],
    fluxos: [fluxo(7, { tipo: 'lead_criado' }, {
      p1: { tipo: 'condicao', campo: 'temperatura', op: 'igual', valor: 'quente', sim: 'p2', nao: null },
      p2: { tipo: 'acao', acao: 'push', texto: 'x', proximo: null },
    })],
  });
  await c.rodar();
  assert.equal(c.pushes.length, 0);
  assert.equal(c.tabelas.fluxo_inscricoes[0].status, 'concluida');
  assert.equal(c.tabelas.fluxo_inscricoes[0].motivo, 'condição não atendida');
});

test('ações no lead: move estágio e muda temperatura', async () => {
  const c = cenario({
    lead_eventos: [evento(1, 'lead_criado')],
    fluxos: [fluxo(7, { tipo: 'lead_criado' }, {
      p1: { tipo: 'acao', acao: 'mover_estagio', para: 'atendimento', proximo: 'p2' },
      p2: { tipo: 'acao', acao: 'mudar_temperatura', para: 'quente', proximo: null },
    })],
  });
  await c.rodar();
  assert.equal(c.tabelas.leads[0].estagio, 'atendimento');
  assert.equal(c.tabelas.leads[0].temperatura, 'quente');
});

test('plano Start não dispara fluxos', async () => {
  const c = cenario({
    usuario: { plano: 'start' },
    lead_eventos: [evento(1, 'lead_criado')],
    fluxos: [fluxo(7, { tipo: 'lead_criado' }, { p1: { tipo: 'acao', acao: 'push', texto: 'x', proximo: null } })],
  });
  await c.rodar();
  assert.equal(c.tabelas.fluxo_inscricoes.length, 0);
  assert.equal(c.pushes.length, 0);
});

test('idempotente: retry do mesmo passo não reenvia', async () => {
  const c = cenario({
    lead_eventos: [evento(1, 'lead_criado')],
    fluxos: [fluxo(7, { tipo: 'lead_criado' }, { p1: { tipo: 'acao', acao: 'whatsapp', texto: 'oi', proximo: null } })],
  });
  await c.rodar();
  const insc = c.tabelas.fluxo_inscricoes[0];
  Object.assign(insc, { status: 'ativa', no_atual: 'p1', proximo_em: QUA_12H_RECIFE.toISOString() }); // simula falha ao salvar o avanço
  await c.rodar();
  assert.equal(c.enviados.length, 1);
  assert.equal(insc.status, 'concluida');
});

test('lead parado: inscreve uma vez só, mesmo com vários ciclos', async () => {
  const c = cenario({
    leads: [{ id: 1, usuario_id: 10, nome: 'Ana', telefone: '81999990000', estagio: 'atendimento', estagio_desde: new Date(QUA_12H_RECIFE - 30 * 60 * MIN).toISOString() }],
    fluxos: [fluxo(7, { tipo: 'lead_parado', estagio: 'atendimento', horas: 24 }, { p1: { tipo: 'acao', acao: 'push', texto: 'parado', proximo: null } })],
  });
  await c.rodar();
  await c.rodar(new Date(QUA_12H_RECIFE.getTime() + 5 * MIN));
  assert.equal(c.tabelas.fluxo_inscricoes.length, 1);
  assert.equal(c.pushes.length, 1);
});

test('sem WhatsApp conectado: usa a Meta só dentro da janela de 24h', async () => {
  const nos = { p1: { tipo: 'acao', acao: 'whatsapp', texto: 'oi', proximo: null } };
  const fora = cenario({ usuario: { evolution_instance_status: 'disconnected' }, lead_eventos: [evento(1, 'lead_criado')], fluxos: [fluxo(7, { tipo: 'lead_criado' }, nos)] });
  await fora.rodar();
  assert.equal(fora.meta.length, 0);
  assert.match(fora.tabelas.automacao_execucoes[0].detalhe, /janela de 24h/);
  assert.equal(fora.tabelas.automacao_execucoes[0].status, 'pulado');

  const dentro = cenario({
    usuario: { evolution_instance_status: 'disconnected' },
    leads: [{ id: 1, usuario_id: 10, nome: 'Ana', telefone: '81999990000', ultima_msg_lead_em: new Date(QUA_12H_RECIFE - 60 * MIN).toISOString() }],
    lead_eventos: [evento(1, 'lead_criado')],
    fluxos: [fluxo(7, { tipo: 'lead_criado' }, nos)],
  });
  await dentro.rodar();
  assert.deepEqual(dentro.meta, [{ tel: '5581999990000', msg: 'oi' }]);
});

test('migration dos fluxos ainda não rodou: Fase 1 segue normal', async () => {
  const c = cenario({ lead_eventos: [evento(1, 'temperatura_mudou', { de: 'morno', para: 'quente' })] });
  c.tabelas.leads[0].temperatura = 'quente';
  const sb = fakeSupabase(c.tabelas, { ausentes: ['fluxos', 'fluxo_inscricoes'], unique: { automacao_execucoes: ['usuario_id', 'receita', 'chave'] } });
  const r = await rodarCiclo({
    db: { supabase: sb, async atualizarLead(id, campos) { Object.assign(c.tabelas.leads[0], campos); } },
    push: { disponivel: () => true, async sendPushParaCorretor() { return { sent: 1 }; } },
    agora: QUA_12H_RECIFE,
  });
  assert.equal(r.instalado, true);
  assert.equal(r.fluxos.instalado, false);
  assert.equal(r.erros, 0, r.falhas.join());
  assert.ok(r.acoes >= 1, 'lead quente da Fase 1 agiu');
});
