/**
 * utils/leadScoring.js
 * Avalia temperatura do lead com base nos dados extraídos.
 * Pode ser usado para validar/sobrescrever a temperatura sugerida pela IA.
 */

function calcularTemperatura(leadData) {
  let pontos = 0;

  // Orçamento definido
  if (leadData.faixa_valor && leadData.faixa_valor !== 'não informado') pontos += 2;

  // Forma de pagamento definida
  if (leadData.pagamento && leadData.pagamento !== 'não informado') pontos += 1;

  // Prazo curto
  if (leadData.prazo) {
    const prazo = leadData.prazo.toLowerCase();
    if (prazo.includes('urgente') || prazo.includes('imediato') || prazo.includes('30 dias') || prazo.includes('este mês')) {
      pontos += 3;
    } else if (prazo.includes('3 meses') || prazo.includes('trimestre')) {
      pontos += 2;
    } else if (prazo.includes('6 meses') || prazo.includes('semestre')) {
      pontos += 1;
    }
  }

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

module.exports = { calcularTemperatura, validarEAjustarLead };
