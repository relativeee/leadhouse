const fields = {
  imovel: 'titulo tipo status endereco bairro cidade valor quartos vagas area descricao foto_url fotos_extras'.split(' '),
  lead: 'nome telefone email objetivo tipo_imovel bairro faixa_valor pagamento prazo temperatura observacoes imovel_id estagio'.split(' '),
  visita: 'lead_nome lead_telefone imovel_titulo endereco data horario corretor observacoes status'.split(' '),
  estagio: ['estagio'],
};
const stages = ['novo','atendimento','qualificado','visita','proposta','fechado','perdido'];
function invalid(message) { const error = new Error(message); error.status = 400; throw error; }
function recordId(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) invalid('ID invalido');
  return Number(value);
}
function validateUpdate(kind, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Envie um objeto JSON');
  const allowed = fields[kind];
  if (!allowed || !Object.keys(body).length) invalid('Nenhum campo para atualizar');
  const result = {};
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.includes(key)) invalid(`Campo nao permitido: ${key}`);
    if (key === 'imovel_id') { result[key] = value === null ? null : recordId(value); continue; }
    if (key === 'fotos_extras') {
      if (!Array.isArray(value) || value.length > 2 || value.some(v => typeof v !== 'string')) invalid('Fotos extras invalidas');
    } else if (typeof value !== 'string') invalid(`Campo ${key} deve ser texto`);
    if (['titulo','tipo','nome','telefone','lead_nome'].includes(key) && !value.trim()) invalid(`Campo ${key} obrigatorio`);
    if (key === 'estagio' && !stages.includes(value)) invalid('Estagio invalido');
    if (key === 'temperatura' && !['frio','morno','quente'].includes(value)) invalid('Temperatura invalida');
    if (key === 'status') {
      const statuses = kind === 'imovel' ? ['disponivel','reservado','vendido','alugado'] : ['agendada','confirmada','realizada','cancelada','reagendada'];
      if (!statuses.includes(value)) invalid('Status invalido');
    }
    if (key === 'data') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value) invalid('Data invalida');
    }
    if (key === 'horario' && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)) invalid('Horario invalido');
    result[key] = value;
  }
  return result;
}
function updateMiddleware(kind, db) {
  return async (req, res, next) => {
    try {
      req.recordId = recordId(req.params.id);
      req.body = validateUpdate(kind, req.body);
      if (kind === 'lead' && req.body.imovel_id !== undefined && req.body.imovel_id !== null) {
        const { data, error } = await db.from('imoveis').select('id').eq('id', req.body.imovel_id).eq('usuario_id', req.userId).maybeSingle();
        if (error) throw error;
        if (!data) return res.status(400).json({ erro: 'Imovel vinculado nao pertence a sua conta' });
      }
      next();
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ erro: error.message });
      return res.status(500).json({ erro: 'Erro ao validar atualizacao' });
    }
  };
}
module.exports = { recordId, validateUpdate, updateMiddleware };
