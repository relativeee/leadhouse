/**
 * services/liaTools.js
 * Factory dos handlers das tools da Lia (imoveis, enviando_arquivos).
 * Recebe dependencias (userId, telefone, conversa, db, sendImage) e devolve
 * o objeto { imoveis, enviando_arquivos } pronto pra passar pra gerarResposta.
 */

/**
 * Constroi handlers das tools com as deps injetadas.
 *
 * @param {Object} deps
 * @param {number} deps.userId - ID do corretor (dono do banco de imoveis)
 * @param {string} deps.telefone - Telefone do lead (E.164 sem +)
 * @param {Object} deps.conversa - Estado da conversa, com Set `imoveisEnviados`
 * @param {Object} deps.db - Modulo services/supabase (precisa expor .supabase)
 * @param {Function} deps.sendImage - async (telefone, urlOuBase64, caption) => any
 * @returns {Object} { imoveis, enviando_arquivos }
 */
const { buscarImoveis } = require('../utils/imoveisBusca');

function criarToolHandlers({ userId, telefone, conversa, db, sendImage }) {
  // Cache local pra um id_imovel virar imovel completo sem refazer query (dedup).
  const imovelCache = new Map();

  // Filtro em JS (utils/imoveisBusca.js): valor/quartos sao TEXT no banco e
  // comparar no Postgres era lexicografico ("2500000" <= "700000").
  async function imoveisHandler(input = {}) {
    const { data, error } = await db.supabase
      .from('imoveis')
      .select('*')
      .eq('usuario_id', userId)
      .eq('status', 'disponivel')
      .limit(500);
    if (error) {
      console.error('[liaTools.imoveis] erro:', error.message);
      return { erro: 'Falha ao consultar imoveis', filtros: input };
    }

    for (const im of data || []) imovelCache.set(im.id, im);
    return buscarImoveis(data || [], input);
  }

  async function enviandoArquivosHandler(input = {}) {
    const id = input.id_imovel;
    console.log(`[liaTools.enviando_arquivos] CHAMADA tel=${telefone} id_imovel=${id}`);
    if (!id || typeof id !== 'number') {
      console.warn(`[liaTools.enviando_arquivos] id_imovel invalido:`, input);
      return { erro: 'id_imovel ausente ou invalido. Use um id retornado por `imoveis`.' };
    }

    // Dedup REMOVIDO temporariamente — havia bug em que o antigo Bloco 3b auto-send
    // marcava o imovel como enviado mesmo quando a entrega na WhatsApp falhava
    // silenciosamente, bloqueando retentativas futuras. Agora cada chamada da tool
    // tenta enviar. Se Lia chamar 2x na mesma conversa, sao 2 envios mesmo —
    // melhor 2 fotos que zero. Anti-spam fica como responsabilidade do prompt.
    if (conversa?.imoveisEnviados?.has?.(id)) {
      console.log(`[liaTools.enviando_arquivos] id=${id} ja consta como enviado mas vamos tentar de novo (dedup desligado)`);
    }

    // Busca dados completos (cache local primeiro, depois DB)
    let imovel = imovelCache.get(id);
    if (!imovel) {
      const { data, error } = await db.supabase
        .from('imoveis')
        .select('*')
        .eq('id', id)
        .eq('usuario_id', userId)
        .maybeSingle();
      if (error || !data) {
        console.warn(`[liaTools.enviando_arquivos] imovel id=${id} nao encontrado (user=${userId})`);
        return { erro: `Imovel id=${id} nao encontrado pra esse corretor.` };
      }
      imovel = data;
    }

    if (!imovel.foto_url) {
      console.warn(`[liaTools.enviando_arquivos] imovel "${imovel.titulo}" (id=${id}) SEM foto_url`);
      return { erro: `Imovel "${imovel.titulo}" nao tem foto cadastrada.`, id_imovel: id };
    }

    console.log(`[liaTools.enviando_arquivos] enviando id=${id} titulo="${imovel.titulo}" foto_url=${imovel.foto_url?.slice(0, 60)}...`);

    // Caption: titulo + bairro + valor + quartos + area
    const cap = [imovel.titulo];
    if (imovel.bairro) cap.push(imovel.bairro);
    if (imovel.valor) cap.push(`R$ ${imovel.valor}`);
    if (imovel.quartos) cap.push(`${imovel.quartos} quartos`);
    if (imovel.area) cap.push(`${imovel.area}m²`);
    const caption = cap.join(' · ');

    try {
      await sendImage(telefone, imovel.foto_url, caption);
      if (conversa?.imoveisEnviados?.add) conversa.imoveisEnviados.add(id);
      return { ok: true, id_imovel: id, titulo: imovel.titulo, caption };
    } catch (err) {
      console.error(`[liaTools.enviando_arquivos] falha sendImage id=${id}:`, err.message);
      return { erro: `Falha ao enviar foto: ${err.message}`, id_imovel: id };
    }
  }

  return {
    imoveis: imoveisHandler,
    enviando_arquivos: enviandoArquivosHandler,
  };
}

module.exports = { criarToolHandlers };
