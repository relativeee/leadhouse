/**
 * utils/leadScoring.js
 * Avalia temperatura do lead com base nos dados extraídos.
 * Pode ser usado para validar/sobrescrever a temperatura sugerida pela IA.
 */

const NUMEROS_POR_EXTENSO = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
};
const DIAS_POR_UNIDADE = { dia: 1, semana: 7, mes: 30, ano: 365 };

/**
 * Converte o prazo em texto livre (vem da extração da IA) em dias.
 * Retorna null quando não dá pra estimar.
 * Ex.: "30-90 dias" → 90, "2 meses" → 60, "o quanto antes" → 0.
 */
function prazoEmDias(prazo) {
  if (!prazo) return null;
  const t = String(prazo).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  if (/nao informad|nao sabe|indefinid|sem pressa|sem prazo/.test(t)) return null;
  if (/urgent|imediat|quanto antes|mais rapido possivel|pra ja|para ja|agora|(est|ess)a semana|(est|ess)e mes/.test(t)) return 0;
  if (/semana que vem|proxima semana/.test(t)) return 14;
  if (/mes que vem|proximo mes/.test(t)) return 60;
  if (/trimestre/.test(t)) return 90;
  if (/semestre/.test(t)) return 180;
  if (/ano que vem|proximo ano/.test(t)) return 365;

  // "45 dias", "2 meses", "1 a 3 meses", "30-90 dias", "um ano".
  // Em faixa vale o limite maior — é o prazo que o lead de fato se deu.
  const re = /(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\s*(dias?|semanas?|mes(?:es)?|anos?)\b/g;
  let maior = null;
  for (const [, num, unidade] of t.matchAll(re)) {
    const n = /^\d+$/.test(num) ? Number(num) : NUMEROS_POR_EXTENSO[num];
    const base = unidade.startsWith('dia') ? 'dia' : unidade.startsWith('semana') ? 'semana' : unidade.startsWith('mes') ? 'mes' : 'ano';
    const dias = n * DIAS_POR_UNIDADE[base];
    if (maior === null || dias > maior) maior = dias;
  }
  return maior;
}

function pontosPrazo(prazo) {
  const dias = prazoEmDias(prazo);
  if (dias === null) return 0;
  if (dias <= 30) return 3;
  if (dias <= 90) return 2;
  if (dias <= 180) return 1;
  return 0;
}

function calcularTemperatura(leadData) {
  let pontos = 0;

  // Orçamento definido
  if (leadData.faixa_valor && leadData.faixa_valor !== 'não informado') pontos += 2;

  // Forma de pagamento definida
  if (leadData.pagamento && leadData.pagamento !== 'não informado') pontos += 1;

  // Prazo curto: até 30 dias = 3, até 90 = 2, até 180 = 1
  pontos += pontosPrazo(leadData.prazo);

  // Bairro/região definida
  if (leadData.bairro && leadData.bairro !== 'não informado') pontos += 1;

  // Tipo de imóvel definido
  if (leadData.tipo_imovel && leadData.tipo_imovel !== 'não informado') pontos += 1;

  // Objetivo definido
  if (leadData.objetivo && leadData.objetivo !== 'não informado') pontos += 1;

  if (pontos >= 7) return 'quente';
  if (pontos >= 4) return 'morno';
  return 'frio';
}

function validarEAjustarLead(leadData) {
  const temperaturaCalculada = calcularTemperatura(leadData);

  // Se a IA disse quente mas pontuação diz diferente, usa a pontuação
  if (leadData.temperatura === 'quente' && temperaturaCalculada !== 'quente') {
    leadData.temperatura = temperaturaCalculada;
  }

  // Se a IA disse frio mas pontuação diz quente, confia na IA (pode ter contexto adicional)
  // Mantém o da IA nesse caso

  return leadData;
}

module.exports = { calcularTemperatura, validarEAjustarLead, prazoEmDias, pontosPrazo };
