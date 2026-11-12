/**
 * Regras automaticas da bateria da Lia — funcoes puras. Cada falha vira
 * { regra, turno, detalhe }. Testadas em tests/liaEvalChecks.test.js.
 */
const { normalizar } = require('../../utils/imoveisBusca');

// Mesmo padrao do guardFotoAlucinacao (server.js).
const RE_FOTO = /\b(mandei|enviei|j[áa]\s+(?:mandei|enviei)|te\s+(?:mandei|enviei)|acabei de mandar|t[áa]\s+a[íi]|segue a foto|segue a imagem)\b[^.!?\n]{0,50}\b(foto|imagem|arquivo|materi[ao]l)\b/i;
const RE_MARKDOWN = /\*\*|__|^\s*[-*•]\s|^\s*\d+[.)]\s/m;
const RE_MASCULINO = /\b(sincero|obrigado|animado|honesto)\b/i;
const RE_REAPRESENTA = /\b(aqui [ée] a lia|sou a lia|me chamo lia)\b/i;
const RE_SAUDACAO = /^\s*(oi|ol[áa])\b/i;
const RE_PROMESSA = /\b(te aviso|eu aviso|aviso voc[êe]|te chamo quando|te mando mensagem quando|te aviso aqui)\b/i;
// "Edifício X", "Residencial X", "Condomínio X", "Solar X", "Casa X"...
const RE_NOME_IMOVEL = /\b(Edif[íi]cio|Residencial|Condom[íi]nio|Solar|Torre|Casa)\s+((?:d[aeo]s?\s+)?[A-ZÀ-Ý][\wÀ-ÿ]+(?:\s+(?:d[aeo]s?\s+)?[A-ZÀ-Ý][\wÀ-ÿ]+)*)/g;
const LIMITE_CARACTERES = 500;

function nomesCitados(texto) {
  return [...String(texto || '').matchAll(RE_NOME_IMOVEL)].map(m => `${m[1]} ${m[2]}`.trim());
}

function enviouFoto(tools) {
  return (tools || []).some(t => t.nome === 'enviando_arquivos' && t.resultado && t.resultado.ok === true);
}

/**
 * @param {Array} turnos - [{ lead, lia, tools: [{nome, input, resultado}] }]
 * @param {Object} caso - entrada de casos.js
 * @param {Array} inventario - imoveis disponiveis no caso
 */
function avaliarConversa(turnos, caso, inventario) {
  const falhas = [];
  const avisos = [];
  const titulos = inventario.map(i => normalizar(i.titulo));
  const falha = (regra, turno, detalhe) => falhas.push({ regra, turno: turno + 1, detalhe });

  turnos.forEach((t, i) => {
    const txt = t.lia || '';
    if (!txt.trim()) { falha('resposta_vazia', i, 'A Lia não respondeu nada'); return; }
    if (RE_MARKDOWN.test(txt)) falha('markdown', i, 'Usou negrito, lista ou numeração');
    const perguntas = (txt.match(/\?/g) || []).length;
    if (perguntas > 1) falha('varias_perguntas', i, `${perguntas} perguntas na mesma mensagem`);
    if (RE_MASCULINO.test(txt)) falha('masculino', i, `Falou de si no masculino: "${txt.match(RE_MASCULINO)[0]}"`);
    if (i > 0 && (RE_REAPRESENTA.test(txt) || RE_SAUDACAO.test(txt))) falha('reapresentacao', i, 'Cumprimentou ou se apresentou de novo');
    if (RE_PROMESSA.test(txt)) falha('promessa_aviso', i, `Prometeu avisar o lead: "${txt.match(RE_PROMESSA)[0]}"`);
    if (RE_FOTO.test(txt) && !enviouFoto(t.tools)) falha('foto_sem_envio', i, 'Disse que mandou foto sem envio bem-sucedido neste turno');
    for (const nome of nomesCitados(txt)) {
      const n = normalizar(nome);
      if (!titulos.some(tt => tt.includes(n) || n.includes(tt))) falha('imovel_inexistente', i, `Citou "${nome}", que não está no cadastro`);
    }
    if (txt.length > LIMITE_CARACTERES) avisos.push({ regra: 'mensagem_longa', turno: i + 1, detalhe: `${txt.length} caracteres` });
  });

  const usadas = new Set(turnos.flatMap(t => (t.tools || []).map(x => x.nome)));
  for (const tool of caso.deveUsar || []) {
    if (!usadas.has(tool)) falhas.push({ regra: 'tool_nao_usada', turno: null, detalhe: `Nunca chamou ${tool}` });
  }
  const tudo = turnos.map(t => t.lia || '').join('\n');
  for (const re of caso.deve || []) {
    if (!re.test(tudo)) falhas.push({ regra: 'faltou_conteudo', turno: null, detalhe: `Esperava encontrar ${re}` });
  }
  for (const re of caso.naoDeve || []) {
    const m = tudo.match(re);
    if (m) falhas.push({ regra: 'conteudo_proibido', turno: null, detalhe: `Encontrou "${m[0]}" (${re})` });
  }
  return { falhas, avisos };
}

module.exports = { avaliarConversa, nomesCitados };
