/**
 * utils/imoveisBusca.js
 * Busca de imoveis da tool `imoveis` da Lia — funcoes puras, sem I/O.
 *
 * valor/quartos/area/vagas sao TEXT no banco e chegam em formatos variados
 * ("795.000", "2.500.000", "459000", "R$ 1.250.000,00", "2,5 mi"). Filtrar no
 * Postgres comparava texto com texto: "2500000" <= "700000" dava true. Aqui o
 * filtro e feito em JS, com numero de verdade.
 *
 * Quando nada atende todos os filtros, devolve os imoveis reais mais proximos
 * com o que cada um NAO atende — sem isso a Lia preenchia o vazio inventando.
 */

const MAX_RESULTADOS = 10;
const MAX_ALTERNATIVAS = 5;

function normalizar(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// "2.500.000" | "795.000" | "R$ 1.250.000,00" | "2,5 mi" | "850 mil" | 459000 -> numero em reais
function parseValorImovel(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const s = normalizar(v);
  const m = s.match(/(\d[\d.,]*)\s*(milhoes|milhao|mi\b|mil\b|k\b)?/);
  if (!m) return null;
  let num = m[1].replace(/[.,]$/, '');
  if (num.includes('.') && num.includes(',')) {
    num = num.replace(/\./g, '').replace(',', '.');
  } else if (num.includes(',')) {
    num = /^\d{1,3}(,\d{3})+$/.test(num) ? num.replace(/,/g, '') : num.replace(',', '.');
  } else if (num.includes('.')) {
    num = /^\d{1,3}(\.\d{3})+$/.test(num) ? num.replace(/\./g, '') : num;
  }
  let n = parseFloat(num);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = m[2] || '';
  if (u === 'mil' || u === 'k') n *= 1000;
  else if (u.startsWith('mi')) n *= 1000000;
  return Math.round(n);
}

// "3" | "3 quartos" | 3 -> 3
function parseInteiro(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  const m = String(v ?? '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function formatarReais(n) {
  return n == null ? null : `R$ ${n.toLocaleString('pt-BR')}`;
}

function numeroOuNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Lista de filtros que o imovel NAO atende (vazia = atende tudo).
function naoAtende(im, f) {
  const faltas = [];
  if (f.bairro && !normalizar(im.bairro).includes(normalizar(f.bairro))) {
    faltas.push(`bairro (fica em ${im.bairro || 'bairro não informado'}, pediu ${f.bairro})`);
  }
  if (f.tipo && !normalizar(im.tipo).includes(normalizar(f.tipo))) {
    faltas.push(`tipo (é ${im.tipo || 'tipo não informado'}, pediu ${f.tipo})`);
  }
  if (f.nome && !normalizar(im.titulo).includes(normalizar(f.nome))) {
    faltas.push(`nome (não é "${f.nome}")`);
  }
  const quartos = parseInteiro(im.quartos);
  if (f.quartos_min != null && (quartos == null || quartos < f.quartos_min)) {
    faltas.push(`quartos (${quartos ?? '?'}, pediu ${f.quartos_min} ou mais)`);
  }
  const valor = parseValorImovel(im.valor);
  if (f.valor_max != null && (valor == null || valor > f.valor_max)) {
    faltas.push(`valor (${formatarReais(valor) ?? 'não informado'}, acima de ${formatarReais(f.valor_max)})`);
  }
  if (f.valor_min != null && (valor == null || valor < f.valor_min)) {
    faltas.push(`valor (${formatarReais(valor) ?? 'não informado'}, abaixo de ${formatarReais(f.valor_min)})`);
  }
  return faltas;
}

function resumir(im) {
  const valor = parseValorImovel(im.valor);
  return {
    id: im.id,
    titulo: im.titulo,
    bairro: im.bairro || null,
    tipo: im.tipo || null,
    valor: formatarReais(valor),
    quartos: parseInteiro(im.quartos),
    vagas: parseInteiro(im.vagas),
    area: im.area || null,
    tem_foto: !!im.foto_url,
  };
}

/**
 * @param {Array} disponiveis - TODOS os imoveis disponiveis do corretor
 * @param {Object} input - filtros vindos da tool (bairro, tipo, nome, quartos_min, valor_min, valor_max)
 */
function buscarImoveis(disponiveis, input = {}) {
  const f = {
    bairro: input.bairro ? String(input.bairro) : null,
    tipo: input.tipo ? String(input.tipo) : null,
    nome: input.nome ? String(input.nome) : null,
    quartos_min: numeroOuNull(input.quartos_min),
    valor_min: numeroOuNull(input.valor_min),
    valor_max: numeroOuNull(input.valor_max),
  };
  const lista = disponiveis || [];
  const avaliados = lista.map(im => ({ im, faltas: naoAtende(im, f) }));
  const porValor = (a, b) => (parseValorImovel(a.im.valor) ?? Infinity) - (parseValorImovel(b.im.valor) ?? Infinity);

  const atendem = avaliados.filter(x => !x.faltas.length).sort(porValor);
  const base = { total_imoveis_disponiveis_do_corretor: lista.length, filtros_aplicados: input };

  if (atendem.length) {
    return { ...base, total: atendem.length, imoveis: atendem.slice(0, MAX_RESULTADOS).map(x => resumir(x.im)) };
  }

  if (!lista.length) {
    return {
      ...base,
      total: 0,
      imoveis: [],
      aviso: 'O corretor não tem nenhum imóvel disponível cadastrado no sistema. Não ofereça nem cite imóveis: diga que o corretor vai buscar opções no perfil do lead e siga qualificando.',
    };
  }

  const alternativas = avaliados
    .sort((a, b) => a.faltas.length - b.faltas.length || porValor(a, b))
    .slice(0, MAX_ALTERNATIVAS)
    .map(x => ({ ...resumir(x.im), nao_atende: x.faltas }));

  return {
    ...base,
    total: 0,
    imoveis: [],
    alternativas,
    aviso: `Nenhum imóvel atende a todos os filtros. "alternativas" são os imóveis REAIS mais próximos, com o que cada um não atende. O corretor tem só ${lista.length} imóvel(is) disponível(is) no total: não diga que há outras opções em outros bairros ou faixas além destas. Se nenhuma alternativa fizer sentido para o lead, diga com naturalidade que vai pedir para o corretor buscar algo no perfil dele.`,
  };
}

module.exports = { normalizar, parseValorImovel, parseInteiro, buscarImoveis };
