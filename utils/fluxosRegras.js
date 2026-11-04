/**
 * utils/fluxosRegras.js
 * Regras dos fluxos criados pelo corretor (Automacoes Fase 2) — funcoes puras,
 * sem I/O. O worker em services/fluxos.js busca os dados e executa o que estas
 * funcoes decidem.
 *
 * Um fluxo e um gatilho + um grafo de nos:
 *   { "n1": { tipo: "condicao", campo, op, valor, sim: "n2", nao: null },
 *     "n2": { tipo: "acao", acao: "push", titulo, texto, proximo: "n3" },
 *     "n3": { tipo: "esperar", minutos: 2880, proximo: null } }
 * `proximo`/`sim`/`nao` = null encerra o fluxo.
 */

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

const ESTAGIOS = ['novo', 'atendimento', 'qualificado', 'visita', 'proposta', 'fechado', 'perdido'];
const TEMPERATURAS = ['frio', 'morno', 'quente'];
const ESTAGIOS_FINAIS = ['fechado', 'perdido'];

const GATILHOS = {
  lead_criado:       { nome: 'Lead novo chegou' },
  estagio_mudou:     { nome: 'Lead mudou de estágio' },
  temperatura_mudou: { nome: 'Temperatura do lead mudou' },
  lead_parado:       { nome: 'Lead parado num estágio' },
  visita:            { nome: 'Visita agendada' },
  lead_respondeu:    { nome: 'Lead mandou mensagem' },
  manual:            { nome: 'Manual (você coloca o lead)' },
};

const ACOES = {
  push:              { nome: 'Avisar no celular', paraLead: false },
  email:             { nome: 'Me mandar e-mail', paraLead: false },
  whatsapp:          { nome: 'Enviar WhatsApp ao lead', paraLead: true },
  whatsapp_template: { nome: 'Enviar template Meta ao lead', paraLead: true },
  mover_estagio:     { nome: 'Mover estágio', paraLead: false },
  mudar_temperatura: { nome: 'Mudar temperatura', paraLead: false },
  pausar_lia:        { nome: 'Pausar a Lia neste lead', paraLead: false },
  retomar_lia:       { nome: 'Retomar a Lia neste lead', paraLead: false },
};

const CAMPOS_CONDICAO = ['temperatura', 'estagio', 'bairro', 'faixa_valor', 'objetivo', 'tipo_imovel', 'origem', 'pagamento', 'prazo'];
const OPERADORES = ['igual', 'diferente', 'contem', 'vazio', 'nao_vazio'];
const MARCOS_VISITA = ['24h', '2h', 'pos'];

const LIMITES = {
  fluxosPorUsuario: 20,
  nosPorFluxo: 30,
  nome: 80,
  texto: 1000,
  titulo: 120,
  esperarMinMin: 1,
  esperarMaxMin: 90 * 24 * 60,
  whatsappPorLeadDia: 2,
  inscricoesPorLeadFluxoDia: 3,
};

// ─────────────────────────────────────────────
// Validacao
// ─────────────────────────────────────────────

function texto(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function validarGatilho(g, erros) {
  if (!g || typeof g !== 'object' || !GATILHOS[g.tipo]) { erros.push('Gatilho inválido'); return null; }
  const out = { tipo: g.tipo };
  if (g.tipo === 'estagio_mudou') {
    if (g.para != null && !ESTAGIOS.includes(g.para)) erros.push('Estágio do gatilho inválido');
    out.para = g.para || null;
  } else if (g.tipo === 'temperatura_mudou') {
    if (g.para != null && !TEMPERATURAS.includes(g.para)) erros.push('Temperatura do gatilho inválida');
    out.para = g.para || null;
  } else if (g.tipo === 'lead_parado') {
    if (!ESTAGIOS.includes(g.estagio)) erros.push('Estágio do gatilho inválido');
    if (!Number.isInteger(g.horas) || g.horas < 1 || g.horas > 720) erros.push('Horas do gatilho devem ser entre 1 e 720');
    out.estagio = g.estagio;
    out.horas = g.horas;
  } else if (g.tipo === 'visita') {
    if (!MARCOS_VISITA.includes(g.marco)) erros.push('Momento da visita inválido');
    out.marco = g.marco;
  }
  return out;
}

function validarNo(id, no, ids, erros) {
  const ref = v => (v === null || v === undefined ? null : v);
  const checarRef = (campo) => {
    const v = ref(no[campo]);
    if (v !== null && !ids.includes(v)) erros.push(`Passo ${id}: ligação "${campo}" aponta para um passo que não existe`);
    return v;
  };
  if (!no || typeof no !== 'object') { erros.push(`Passo ${id} inválido`); return null; }
  const pos = no.pos && Number.isFinite(no.pos.x) && Number.isFinite(no.pos.y) ? { x: Math.round(no.pos.x), y: Math.round(no.pos.y) } : undefined;

  if (no.tipo === 'condicao') {
    if (!CAMPOS_CONDICAO.includes(no.campo)) erros.push(`Passo ${id}: campo da condição inválido`);
    if (!OPERADORES.includes(no.op)) erros.push(`Passo ${id}: operador inválido`);
    const precisaValor = !['vazio', 'nao_vazio'].includes(no.op);
    if (precisaValor && !texto(no.valor, 200)) erros.push(`Passo ${id}: informe o valor da condição`);
    return { tipo: 'condicao', campo: no.campo, op: no.op, valor: precisaValor ? String(no.valor).trim() : null, sim: checarRef('sim'), nao: checarRef('nao'), ...(pos && { pos }) };
  }

  if (no.tipo === 'esperar') {
    if (!Number.isInteger(no.minutos) || no.minutos < LIMITES.esperarMinMin || no.minutos > LIMITES.esperarMaxMin) {
      erros.push(`Passo ${id}: espera deve ser entre 1 minuto e 90 dias`);
    }
    return { tipo: 'esperar', minutos: no.minutos, proximo: checarRef('proximo'), ...(pos && { pos }) };
  }

  if (no.tipo === 'acao') {
    const a = no.acao;
    if (!ACOES[a]) { erros.push(`Passo ${id}: ação inválida`); return null; }
    const out = { tipo: 'acao', acao: a, proximo: checarRef('proximo'), ...(pos && { pos }) };
    if (a === 'push' || a === 'email') {
      if (!texto(no.texto, LIMITES.texto)) erros.push(`Passo ${id}: escreva a mensagem`);
      if (no.titulo != null && no.titulo !== '' && !texto(no.titulo, LIMITES.titulo)) erros.push(`Passo ${id}: título muito longo`);
      out.texto = no.texto;
      out.titulo = no.titulo ? String(no.titulo) : null;
    } else if (a === 'whatsapp') {
      if (!texto(no.texto, LIMITES.texto)) erros.push(`Passo ${id}: escreva a mensagem do WhatsApp`);
      out.texto = no.texto;
    } else if (a === 'whatsapp_template') {
      if (typeof no.template !== 'string' || !/^[a-z0-9_]{1,512}$/.test(no.template)) erros.push(`Passo ${id}: nome do template inválido (só letras minúsculas, números e _)`);
      const params = Array.isArray(no.params) ? no.params : [];
      if (params.length > 10 || params.some(p => typeof p !== 'string' || p.length > 200)) erros.push(`Passo ${id}: parâmetros do template inválidos`);
      out.template = no.template;
      out.params = params;
    } else if (a === 'mover_estagio') {
      if (!ESTAGIOS.includes(no.para)) erros.push(`Passo ${id}: estágio inválido`);
      out.para = no.para;
    } else if (a === 'mudar_temperatura') {
      if (!TEMPERATURAS.includes(no.para)) erros.push(`Passo ${id}: temperatura inválida`);
      out.para = no.para;
    }
    return out;
  }

  erros.push(`Passo ${id}: tipo de passo inválido`);
  return null;
}

function saidas(no) {
  if (!no) return [];
  if (no.tipo === 'condicao') return [no.sim, no.nao].filter(Boolean);
  return [no.proximo].filter(Boolean);
}

/**
 * Valida e normaliza um fluxo vindo do cliente.
 * Garante: ids validos, ligacoes existentes, todos os passos alcancaveis a
 * partir do inicial, e nenhum ciclo (o fluxo sempre termina).
 * @returns {{ ok: boolean, erros: string[], fluxo?: object }}
 */
function validarFluxo(entrada) {
  const erros = [];
  if (!entrada || typeof entrada !== 'object') return { ok: false, erros: ['Envie o fluxo'] };
  if (!texto(entrada.nome, LIMITES.nome)) erros.push(`Dê um nome ao fluxo (até ${LIMITES.nome} caracteres)`);

  const gatilho = validarGatilho(entrada.gatilho, erros);

  // Estrutura primeiro: sem ela nao da pra validar os passos.
  const estrutura = [];
  const nosEntrada = entrada.nos && typeof entrada.nos === 'object' && !Array.isArray(entrada.nos) ? entrada.nos : null;
  const ids = nosEntrada ? Object.keys(nosEntrada) : [];
  if (!ids.length) estrutura.push('Adicione pelo menos um passo');
  if (ids.length > LIMITES.nosPorFluxo) estrutura.push(`Máximo de ${LIMITES.nosPorFluxo} passos por fluxo`);
  if (ids.some(id => !/^[a-z0-9_]{1,20}$/i.test(id))) estrutura.push('Identificador de passo inválido');
  if (ids.length && !ids.includes(entrada.no_inicial)) estrutura.push('Passo inicial inválido');
  if (estrutura.length) return { ok: false, erros: [...erros, ...estrutura] };

  const nos = {};
  for (const id of ids) {
    const n = validarNo(id, nosEntrada[id], ids, erros);
    if (n) nos[id] = n;
  }
  if (erros.length) return { ok: false, erros };

  // Ciclos e passos soltos (DFS a partir do inicial)
  const estado = {}; // 1 = visitando, 2 = feito
  let ciclo = false;
  (function visitar(id) {
    if (ciclo) return;
    if (estado[id] === 1) { ciclo = true; return; }
    if (estado[id] === 2) return;
    estado[id] = 1;
    for (const s of saidas(nos[id])) visitar(s);
    estado[id] = 2;
  })(entrada.no_inicial);
  if (ciclo) erros.push('O fluxo não pode voltar para um passo anterior (ciclo)');
  const soltos = ids.filter(id => !estado[id]);
  if (soltos.length) erros.push(`Há passos que nunca são alcançados: ${soltos.join(', ')}`);
  if (erros.length) return { ok: false, erros };

  return {
    ok: true,
    erros: [],
    fluxo: {
      nome: entrada.nome.trim(),
      gatilho,
      nos,
      no_inicial: entrada.no_inicial,
      parar_se_responder: entrada.parar_se_responder !== false,
    },
  };
}

// ─────────────────────────────────────────────
// Execucao
// ─────────────────────────────────────────────

/** Evento de lead_eventos dispara este gatilho? */
function gatilhoCasa(gatilho, evento) {
  if (!gatilho || !evento) return false;
  switch (gatilho.tipo) {
    case 'lead_criado': return evento.tipo === 'lead_criado';
    case 'lead_respondeu': return evento.tipo === 'lead_respondeu';
    case 'estagio_mudou': return evento.tipo === 'estagio_mudou' && (!gatilho.para || evento.para === gatilho.para);
    case 'temperatura_mudou': return evento.tipo === 'temperatura_mudou' && (!gatilho.para || evento.para === gatilho.para);
    default: return false; // lead_parado, visita e manual nao vem de eventos
  }
}

function normalizar(v) {
  return String(v ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase();
}

function vazio(v) {
  const n = normalizar(v);
  return !n || n === 'nao informado';
}

function avaliarCondicao(no, lead) {
  const atual = lead ? lead[no.campo] : null;
  switch (no.op) {
    case 'vazio': return vazio(atual);
    case 'nao_vazio': return !vazio(atual);
    case 'igual': return normalizar(atual) === normalizar(no.valor);
    case 'diferente': return normalizar(atual) !== normalizar(no.valor);
    case 'contem': return normalizar(atual).includes(normalizar(no.valor));
    default: return false;
  }
}

/** Proximo passo apos executar `no`. Para condicao, depende do resultado. */
function proximoNo(no, resultadoCondicao) {
  if (!no) return null;
  if (no.tipo === 'condicao') return (resultadoCondicao ? no.sim : no.nao) || null;
  return no.proximo || null;
}

function valorLimpo(v) {
  const s = String(v ?? '').trim();
  return s && normalizar(s) !== 'nao informado' ? s : '';
}

/**
 * Substitui {nome}, {primeiro_nome}, {bairro}, {tipo_imovel}, {faixa_valor},
 * {objetivo}, {corretor}. Variavel sem valor some (sem deixar "{bairro}" no texto).
 */
function renderTexto(modelo, lead, corretor) {
  const nome = valorLimpo(lead?.nome);
  const vars = {
    nome,
    primeiro_nome: nome.split(/\s+/)[0] || '',
    bairro: valorLimpo(lead?.bairro),
    tipo_imovel: valorLimpo(lead?.tipo_imovel),
    faixa_valor: valorLimpo(lead?.faixa_valor),
    objetivo: valorLimpo(lead?.objetivo),
    corretor: valorLimpo(corretor?.nome).split(/\s+/)[0] || '',
  };
  return String(modelo || '')
    .replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([,.!?])/g, '$1')
    .trim();
}

// ─────────────────────────────────────────────
// Horario de trabalho (fuso de Recife, UTC-3 fixo — igual ao resto do app)
// ─────────────────────────────────────────────

const OFFSET_RECIFE = -3 * HORA;
const HORARIO_PADRAO = { inicio: '08:00', fim: '18:00', dias: [1, 2, 3, 4, 5, 6] };

function minutosDe(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : null;
}

function janelaDoDia(ht, diaSemana) {
  const h = ht && typeof ht === 'object' ? ht : HORARIO_PADRAO;
  const dias = Array.isArray(h.dias) && h.dias.length ? h.dias : HORARIO_PADRAO.dias;
  if (!dias.includes(diaSemana)) return null;
  const esp = h.especial && h.especial[diaSemana];
  const inicio = minutosDe(esp?.inicio || h.inicio || HORARIO_PADRAO.inicio);
  const fim = minutosDe(esp?.fim || h.fim || HORARIO_PADRAO.fim);
  if (inicio === null || fim === null || fim <= inicio) return null;
  return { inicio, fim };
}

/** Partes da data em Recife: { diaSemana, minutos, meiaNoite (Date UTC da 00:00 local) } */
function partesRecife(agora) {
  const local = new Date(agora.getTime() + OFFSET_RECIFE);
  const minutos = local.getUTCHours() * 60 + local.getUTCMinutes();
  const meiaNoite = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - OFFSET_RECIFE);
  return { diaSemana: local.getUTCDay(), minutos, meiaNoite };
}

function dentroDoHorario(ht, agora) {
  const { diaSemana, minutos } = partesRecife(agora);
  const j = janelaDoDia(ht, diaSemana);
  return !!j && minutos >= j.inicio && minutos < j.fim;
}

/** Primeiro instante >= `apartir` dentro do horario de trabalho (procura ate 14 dias). */
function proximoHorarioUtil(ht, apartir) {
  if (dentroDoHorario(ht, apartir)) return apartir;
  const { meiaNoite, minutos } = partesRecife(apartir);
  for (let d = 0; d < 14; d++) {
    const diaInicio = new Date(meiaNoite.getTime() + d * DIA);
    const j = janelaDoDia(ht, partesRecife(diaInicio).diaSemana);
    if (!j) continue;
    if (d === 0 && minutos >= j.fim) continue;
    const ini = d === 0 ? Math.max(j.inicio, minutos) : j.inicio;
    return new Date(diaInicio.getTime() + ini * MIN);
  }
  return new Date(apartir.getTime() + DIA); // horario mal configurado: tenta amanha
}

/** 00:00 de hoje e de amanha em Recife (para a trava diaria). */
function inicioDoDiaRecife(agora, deslocDias = 0) {
  return new Date(partesRecife(agora).meiaNoite.getTime() + deslocDias * DIA);
}

/** Meta so aceita texto livre ate 24h depois da ultima mensagem do lead. */
function dentroJanela24h(ultimaMsgLead, agora) {
  if (!ultimaMsgLead) return false;
  const t = new Date(ultimaMsgLead).getTime();
  return Number.isFinite(t) && agora.getTime() - t < 24 * HORA;
}

/** Pro, Elite, trial valido e admin podem usar fluxos (Start nao). */
function planoPermiteFluxos(usuario, agora = new Date()) {
  if (!usuario) return false;
  if (usuario.is_admin) return true;
  const p = String(usuario.plano || '').toLowerCase();
  if (p === 'pro' || p === 'elite') return true;
  if (p === 'trial') {
    const exp = usuario.trial_expires_at ? new Date(usuario.trial_expires_at).getTime() : 0;
    return exp > agora.getTime();
  }
  return false;
}

module.exports = {
  ESTAGIOS,
  TEMPERATURAS,
  ESTAGIOS_FINAIS,
  GATILHOS,
  ACOES,
  CAMPOS_CONDICAO,
  OPERADORES,
  MARCOS_VISITA,
  LIMITES,
  validarFluxo,
  gatilhoCasa,
  avaliarCondicao,
  proximoNo,
  renderTexto,
  dentroDoHorario,
  proximoHorarioUtil,
  inicioDoDiaRecife,
  dentroJanela24h,
  planoPermiteFluxos,
};
