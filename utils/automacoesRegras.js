/**
 * utils/automacoesRegras.js
 * Regras das automacoes (Fase 1) — funcoes puras, sem I/O.
 * O worker em services/automacoes.js busca os dados e executa o que estas
 * funcoes decidem. Mantido puro pra ser testado com node:test.
 */

const HORA = 60 * 60 * 1000;

// Catalogo de receitas. Sem linha na tabela `automacoes` vale o padrao daqui.
const RECEITAS = {
  lead_quente: {
    id: 'lead_quente',
    nome: 'Alerta de lead quente',
    descricao: 'Quando um lead vira quente, avisa você na hora e move o lead para "Qualificado" (se ainda estiver em Novo ou Atendimento).',
    padraoAtivo: true,
    enviaParaLead: false,
    configPadrao: {},
  },
  lembrete_visita: {
    id: 'lembrete_visita',
    nome: 'Lembrete e pós-visita',
    descricao: 'Lembra o cliente 24h e 2h antes da visita e pede feedback no dia seguinte. Você também recebe um aviso.',
    padraoAtivo: false, // so liga depois dos templates aprovados na Meta
    enviaParaLead: true,
    configPadrao: {},
  },
  sla_corretor: {
    id: 'sla_corretor',
    nome: 'Lead parado (SLA)',
    descricao: 'Avisa por push e e-mail quando um lead fica mais de 48h em "Atendimento" sem mudar de estágio.',
    padraoAtivo: true,
    enviaParaLead: false,
    configPadrao: { horas: 48, estagios: ['atendimento'] },
  },
};

const ESTAGIOS_ANTES_DE_QUALIFICADO = ['novo', 'atendimento'];

/**
 * Mescla o catalogo com as linhas salvas do usuario.
 * @param {Array<{receita: string, ativo: boolean, config: object}>} linhas
 */
function configUsuario(linhas) {
  const out = {};
  for (const r of Object.values(RECEITAS)) {
    const salva = (linhas || []).find(l => l.receita === r.id);
    out[r.id] = {
      ativo: salva ? !!salva.ativo : r.padraoAtivo,
      config: { ...r.configPadrao, ...(salva?.config || {}) },
    };
  }
  return out;
}

/**
 * Acoes da receita lead_quente para um evento.
 * Nunca regride o funil: so move se o lead estiver antes de "qualificado".
 */
function acoesLeadQuente(evento, lead) {
  if (!evento || evento.tipo !== 'temperatura_mudou' || evento.para !== 'quente') return [];
  if (!lead || lead.temperatura !== 'quente') return []; // ja esfriou de novo antes do worker rodar
  const acoes = [{ tipo: 'push' }];
  if (ESTAGIOS_ANTES_DE_QUALIFICADO.includes(lead.estagio || 'novo')) {
    acoes.push({ tipo: 'mover_estagio', para: 'qualificado' });
  }
  return acoes;
}

/**
 * Instante da visita. Datas/horarios sao gravados no horario de Recife
 * (UTC-3 fixo, sem horario de verao — mesmo fuso usado no resto do app).
 */
function visitaInstante(data, horario) {
  if (!data || !horario) return null;
  const d = new Date(`${data}T${String(horario).slice(0, 5)}:00-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const STATUS_VISITA_ATIVA = ['agendada', 'confirmada', 'reagendada'];

/**
 * Marcos devidos agora para uma visita. Janelas largas porque o cron pode
 * atrasar; a idempotencia (chave por marco) evita envio duplicado.
 * @returns {Array<'24h'|'2h'|'pos'>}
 */
function marcosVisita(visita, agora) {
  if (!visita || visita.status === 'cancelada') return [];
  const inicio = visitaInstante(visita.data, visita.horario);
  if (!inicio) return [];
  const faltam = (inicio.getTime() - agora.getTime()) / HORA;
  const marcos = [];
  if (STATUS_VISITA_ATIVA.includes(visita.status)) {
    if (faltam > 23 && faltam <= 25) marcos.push('24h');
    if (faltam > 1 && faltam <= 3) marcos.push('2h');
  }
  if (faltam <= -18 && faltam > -30) marcos.push('pos');
  return marcos;
}

function slaEstourado(lead, agora, config) {
  if (!lead || !lead.estagio_desde) return false;
  if (!(config.estagios || []).includes(lead.estagio)) return false;
  const desde = new Date(lead.estagio_desde).getTime();
  if (Number.isNaN(desde)) return false;
  return agora.getTime() - desde > (config.horas || 48) * HORA;
}

// Realerta so se o lead sair e voltar ao estagio (estagio_desde muda).
function chaveSla(lead) {
  return `lead:${lead.id}:sla:${lead.estagio}:${new Date(lead.estagio_desde).toISOString()}`;
}

// "2026-10-08" -> "08/10"
function dataCurta(data) {
  const [, m, d] = String(data || '').split('-');
  return d && m ? `${d}/${m}` : '';
}

/**
 * Telefone no formato da Cloud API (so digitos, com DDI). Visitas manuais
 * guardam o que o corretor digitou: "(81) 99999-0000" -> "5581999990000".
 * Retorna null se nao parecer um telefone valido.
 */
function telefoneWhatsApp(telefone) {
  const d = String(telefone || '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if (d.length >= 12 && d.length <= 15) return d;
  return null;
}

function nomeOuPadrao(nome, padrao = 'Lead') {
  const n = String(nome || '').trim();
  return n && n !== 'não informado' ? n : padrao;
}

module.exports = {
  RECEITAS,
  configUsuario,
  acoesLeadQuente,
  visitaInstante,
  marcosVisita,
  slaEstourado,
  chaveSla,
  dataCurta,
  telefoneWhatsApp,
  nomeOuPadrao,
};
