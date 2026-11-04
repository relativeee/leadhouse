/**
 * public/fluxosGrafo.js
 * Conversao entre o grafo de um fluxo (formato salvo no banco, ver
 * utils/fluxosRegras.js) e os CARTOES do construtor visual (Drawflow).
 * Funcoes puras: roda no navegador (window.FluxosGrafo) e no Node (testes).
 *
 * Cartoes:
 *   gatilho  — "Quando ...", sem entrada, 1 saida.
 *   grupo    — sequencia de passos lineares (acao/esperar), 1 entrada, 1 saida ("Proximo passo").
 *   condicao — 1 entrada, output_1 = Sim, output_2 = Nao.
 * O banco continua guardando passo a passo: passos seguidos com um unico
 * antecessor viram um cartao so; ao salvar o cartao e desmembrado de volta.
 * Id do cartao = id do seu primeiro passo. No Drawflow, `data._id` = id do cartao.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FluxosGrafo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const GATILHO = 'gatilho';
  const COL = 340, LIN = 230, X0 = 40, Y0 = 80;
  const linear = no => !!no && (no.tipo === 'acao' || no.tipo === 'esperar');
  const semLigacoes = ({ sim, nao, proximo, pos, ...c }) => c;

  function saidasNo(no) {
    if (!no) return [];
    if (no.tipo === 'condicao') return [no.sim, no.nao];
    return [no.proximo];
  }

  /**
   * Agrupa o grafo em cartoes.
   * @returns {{ cards: object, ligacoes: object, pos: object }}
   *   cards[id] = { tipo:'grupo', passos:[{_id,...}] } | { tipo:'condicao', ...campos }
   *   ligacoes[id] = { output_1: cardId|null, output_2?: cardId|null }
   */
  function paraCards(fluxo) {
    const nos = fluxo.nos || {};
    const preds = {};
    for (const no of Object.values(nos)) for (const a of saidasNo(no)) if (a) preds[a] = (preds[a] || 0) + 1;

    // n continua o cartao do antecessor se ambos sao lineares, ligados direto, e n tem 1 antecessor
    const continua = {};
    for (const [id, no] of Object.entries(nos)) {
      if (linear(no) && no.proximo && linear(nos[no.proximo]) && preds[no.proximo] === 1 && no.proximo !== fluxo.no_inicial) {
        continua[no.proximo] = id;
      }
    }

    const cards = {}, ligacoes = {}, pos = {}, cardDe = {};
    for (const [id, no] of Object.entries(nos)) {
      if (continua[id]) continue; // nao e cabeca de cartao
      if (no.tipo === 'condicao') {
        cards[id] = semLigacoes(no);
        cardDe[id] = id;
      } else {
        const passos = [];
        const vistos = new Set();
        let atual = id;
        while (atual && nos[atual] && !vistos.has(atual) && (atual === id || continua[atual])) {
          vistos.add(atual);
          passos.push({ _id: atual, ...semLigacoes(nos[atual]) });
          cardDe[atual] = id;
          const prox = nos[atual].proximo;
          atual = prox && continua[prox] === atual ? prox : null;
        }
        cards[id] = { tipo: 'grupo', passos };
      }
      if (no.pos) pos[id] = no.pos;
    }

    for (const [id, card] of Object.entries(cards)) {
      if (card.tipo === 'condicao') {
        ligacoes[id] = { output_1: nos[id].sim ? cardDe[nos[id].sim] : null, output_2: nos[id].nao ? cardDe[nos[id].nao] : null };
      } else {
        const ultimo = nos[card.passos[card.passos.length - 1]._id];
        ligacoes[id] = { output_1: ultimo.proximo ? cardDe[ultimo.proximo] : null };
      }
    }
    return { cards, ligacoes, pos, inicio: fluxo.no_inicial ? cardDe[fluxo.no_inicial] : null };
  }

  /** Posicao automatica: coluna = maior profundidade a partir do cartao inicial. */
  function layout(ligacoes, inicio) {
    const ids = Object.keys(ligacoes);
    const prof = {};
    if (inicio) prof[inicio] = 0;
    for (let rodada = 0; rodada < ids.length; rodada++) {
      let mudou = false;
      for (const id of ids) {
        if (prof[id] === undefined) continue;
        for (const alvo of Object.values(ligacoes[id])) {
          if (alvo && ligacoes[alvo] && (prof[alvo] === undefined || prof[alvo] < prof[id] + 1)) { prof[alvo] = prof[id] + 1; mudou = true; }
        }
      }
      if (!mudou) break;
    }
    const linhas = {}, pos = {};
    for (const id of ids) {
      const col = prof[id] === undefined ? 0 : prof[id];
      const lin = (linhas[col] = (linhas[col] || 0) + 1) - 1;
      pos[id] = { x: X0 + COL * (col + 1), y: Y0 + LIN * lin + (prof[id] === undefined ? LIN * 2 : 0) };
    }
    return pos;
  }

  /**
   * fluxo: { gatilho, nos, no_inicial }. rotulo(card | {tipo:'gatilho', gatilho}) -> html.
   * Retorna { json (para editor.import), cards, dfPorId }.
   */
  function paraDrawflow(fluxo, rotulo) {
    const { cards, ligacoes, pos: salvas, inicio } = paraCards(fluxo);
    const auto = layout(ligacoes, inicio);
    const posDe = id => salvas[id] || auto[id];
    const dfPorId = {};
    Object.keys(cards).forEach((id, i) => { dfPorId[id] = i + 2; });

    const data = {};
    const ids = Object.keys(cards);
    const xMin = ids.length ? Math.min(...ids.map(id => posDe(id).x)) : X0 + COL;
    data[1] = {
      id: 1, name: GATILHO, data: {}, class: 'fx-gatilho',
      html: rotulo({ tipo: GATILHO, gatilho: fluxo.gatilho }), typenode: false, inputs: {},
      outputs: { output_1: { connections: inicio ? [{ node: String(dfPorId[inicio]), output: 'input_1' }] : [] } },
      pos_x: xMin - COL, pos_y: inicio ? posDe(inicio).y : Y0,
    };
    for (const [id, card] of Object.entries(cards)) {
      const outputs = {};
      for (const [saida, alvo] of Object.entries(ligacoes[id])) {
        outputs[saida] = { connections: alvo ? [{ node: String(dfPorId[alvo]), output: 'input_1' }] : [] };
      }
      data[dfPorId[id]] = {
        id: dfPorId[id], name: card.tipo, data: { _id: id }, class: 'fx-' + card.tipo,
        html: rotulo(card), typenode: false,
        inputs: { input_1: { connections: [] } }, outputs,
        pos_x: posDe(id).x, pos_y: posDe(id).y,
      };
    }
    for (const no of Object.values(data)) {
      for (const [saida, o] of Object.entries(no.outputs)) {
        for (const c of o.connections) data[c.node].inputs.input_1.connections.push({ node: String(no.id), input: saida });
      }
    }
    return { json: { drawflow: { Home: { data } } }, cards, dfPorId };
  }

  /** Id do primeiro passo do cartao (o que as ligacoes apontam). */
  function cabeca(card, id) {
    return card.tipo === 'grupo' ? (card.passos[0] && card.passos[0]._id) || null : id;
  }

  /**
   * exportado: editor.export(). cards: { cardId -> cartao } (estado do editor).
   * Desmembra os cartoes em passos. Retorna { nos, no_inicial, erros }.
   */
  function deDrawflow(exportado, cards) {
    const data = (exportado && exportado.drawflow && exportado.drawflow.Home && exportado.drawflow.Home.data) || {};
    const cardPorDf = {};
    let gatilho = null;
    for (const n of Object.values(data)) {
      if (n.name === GATILHO) gatilho = n;
      else if (n.data && n.data._id && cards[n.data._id]) cardPorDf[n.id] = n.data._id;
    }
    const destino = (n, saida) => {
      const c = n && n.outputs && n.outputs[saida] && n.outputs[saida].connections[0];
      const cardId = c ? cardPorDf[c.node] : null;
      return cardId ? cabeca(cards[cardId], cardId) : null;
    };

    const erros = [];
    const nos = {};
    for (const n of Object.values(data)) {
      const id = cardPorDf[n.id];
      if (!id) continue;
      const card = cards[id];
      const pos = { x: Math.round(n.pos_x), y: Math.round(n.pos_y) };
      if (card.tipo === 'condicao') {
        const { tipo, ...campos } = card;
        nos[id] = { tipo: 'condicao', ...campos, sim: destino(n, 'output_1'), nao: destino(n, 'output_2'), pos };
        continue;
      }
      if (!card.passos.length) { erros.push(`O bloco ${id} está vazio: adicione um passo ou apague o bloco`); continue; }
      const proximoDoCartao = destino(n, 'output_1');
      card.passos.forEach((p, i) => {
        const { _id, ...campos } = p;
        nos[_id] = { ...campos, proximo: i + 1 < card.passos.length ? card.passos[i + 1]._id : proximoDoCartao };
        if (i === 0) nos[_id].pos = pos;
      });
    }

    const noInicial = destino(gatilho, 'output_1');
    const ids = Object.keys(nos);
    if (!ids.length && !erros.length) erros.push('Adicione pelo menos um bloco');
    else if (ids.length && !noInicial) erros.push('Ligue o "Quando" ao primeiro bloco');

    const estado = {};
    let ciclo = false;
    (function visitar(id) {
      if (!id || ciclo) return;
      if (estado[id] === 1) { ciclo = true; return; }
      if (estado[id] === 2) return;
      estado[id] = 1;
      for (const a of saidasNo(nos[id])) visitar(a);
      estado[id] = 2;
    })(noInicial);
    if (ciclo) erros.push('O fluxo não pode voltar para um bloco anterior');
    if (noInicial) {
      const soltos = Object.entries(cards).filter(([cid, c]) => { const h = cabeca(c, cid); return h && nos[h] && !estado[h]; }).map(([cid]) => cid);
      if (soltos.length) erros.push(`Blocos sem ligação com o fluxo: ${soltos.join(', ')}`);
    }
    return { nos, no_inicial: noInicial, erros };
  }

  /** Proximo id livre no padrao n1, n2... (ids de passos e cartoes compartilham o espaco). */
  function novoId(existentes) {
    let i = 1;
    while (existentes.includes('n' + i)) i++;
    return 'n' + i;
  }

  /** Todos os ids em uso (cartoes + passos dentro dos grupos). */
  function idsEmUso(cards) {
    const ids = new Set();
    for (const [id, c] of Object.entries(cards)) {
      ids.add(id);
      if (c.tipo === 'grupo') for (const p of c.passos) ids.add(p._id);
    }
    return [...ids];
  }

  return { GATILHO, paraCards, layout, paraDrawflow, deDrawflow, novoId, idsEmUso, cabeca };
});
