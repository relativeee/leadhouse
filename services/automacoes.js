/**
 * services/automacoes.js
 * Worker do motor de automacoes (Fase 1). Chamado a cada minuto pelo
 * Supabase pg_cron via GET /api/cron/automacoes.
 *
 * Ciclo:
 *   1) consome lead_eventos pendentes (gravados por trigger) -> lead_quente
 *   2) varre visitas proximas -> lembrete_visita (24h, 2h, pos)
 *   3) varre leads parados no estagio -> sla_corretor
 *
 * Toda acao passa por executarUmaVez(): insere em automacao_execucoes ANTES
 * de executar; unique (usuario_id, receita, chave) garante que retry do cron
 * ou ciclos sobrepostos nunca dupliquem envio.
 *
 * Decisoes (o que fazer) ficam em utils/automacoesRegras.js — aqui so I/O.
 */

const R = require('../utils/automacoesRegras');

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

// Tabela ausente = migrations/automacoes.sql ainda nao rodou. O ciclo vira no-op
// em vez de erro, pra o deploy do codigo poder vir antes da migration.
function tabelaAusente(error) {
  return !!error && (error.code === 'PGRST205' || error.code === '42P01' || /does not exist|schema cache/i.test(error.message || ''));
}

// "2026-10-07" no fuso de Recife
function hojeRecife(agora, deslocDias = 0) {
  return new Date(agora.getTime() - 3 * HORA + deslocDias * DIA).toISOString().slice(0, 10);
}

async function carregarConfigs(sb, usuarioIds) {
  const ids = [...new Set(usuarioIds)].filter(Boolean);
  const porUsuario = new Map();
  if (!ids.length) return porUsuario;
  const { data, error } = await sb.from('automacoes').select('usuario_id, receita, ativo, config').in('usuario_id', ids);
  if (error) throw error;
  for (const id of ids) porUsuario.set(id, R.configUsuario((data || []).filter(l => l.usuario_id === id)));
  return porUsuario;
}

function criarExecutor(sb, stats) {
  return async function executarUmaVez(usuarioId, receita, chave, fn) {
    const { data: reg, error } = await sb
      .from('automacao_execucoes')
      .insert({ usuario_id: usuarioId, receita, chave, status: 'executando' })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') return false; // ja executado
      throw error;
    }
    let status = 'ok', detalhe = null;
    try {
      const r = await fn();
      if (r && r.status) { status = r.status; detalhe = r.detalhe || null; }
    } catch (e) {
      status = 'erro';
      detalhe = String(e.response?.data?.error?.message || e.message || e).slice(0, 500);
      stats.erros++;
      console.error(`[automacoes] ${receita} ${chave} falhou:`, detalhe);
    }
    await sb.from('automacao_execucoes').update({ status, detalhe }).eq('id', reg.id);
    if (status === 'ok') stats.acoes++;
    return true;
  };
}

async function enviarPush(push, usuarioId, payload) {
  if (!push?.disponivel()) return { status: 'pulado', detalhe: 'push nao configurado' };
  const r = await push.sendPushParaCorretor(usuarioId, payload);
  if (!r.sent) return { status: 'pulado', detalhe: 'corretor sem dispositivo com push ativo' };
  return { status: 'ok', detalhe: `push enviado a ${r.sent} dispositivo(s)` };
}

// ─────────────────────────────────────────────
// 1) Eventos -> lead_quente
// ─────────────────────────────────────────────
async function processarEventos(ctx) {
  const { sb, db, push, executarUmaVez, agora, estourou, stats } = ctx;
  const { data: eventos, error } = await sb
    .from('lead_eventos')
    .select('*')
    .is('processado_em', null)
    .order('id', { ascending: true })
    .limit(100);
  if (error) throw error;
  if (!eventos?.length) return;

  const configs = await carregarConfigs(sb, eventos.map(e => e.usuario_id));
  const processados = [];

  for (const ev of eventos) {
    if (estourou()) break;
    processados.push(ev.id);
    stats.eventos++;
    if (!configs.get(ev.usuario_id)?.lead_quente.ativo) continue;
    if (ev.tipo !== 'temperatura_mudou' || ev.para !== 'quente') continue;

    const { data: lead } = await sb
      .from('leads')
      .select('id, nome, telefone, temperatura, estagio, resumo, faixa_valor, bairro')
      .eq('id', ev.lead_id)
      .eq('usuario_id', ev.usuario_id)
      .maybeSingle();
    if (!lead) continue;

    for (const acao of R.acoesLeadQuente(ev, lead)) {
      if (acao.tipo === 'push') {
        // 1 alerta por lead por dia: o extrator pode oscilar quente<->morno
        await executarUmaVez(ev.usuario_id, 'lead_quente', `lead:${lead.id}:quente:${hojeRecife(agora)}`, () =>
          enviarPush(push, ev.usuario_id, {
            title: `🔥 Lead quente: ${R.nomeOuPadrao(lead.nome)}`,
            body: [lead.resumo, lead.faixa_valor, lead.bairro]
              .map(s => String(s || '').trim()).filter(s => s && s !== 'não informado')[0] || 'Responda agora enquanto o interesse está alto.',
            url: '/?tab=funil',
            tag: `quente-${lead.id}`,
          }));
      } else if (acao.tipo === 'mover_estagio') {
        await executarUmaVez(ev.usuario_id, 'lead_quente', `lead:${lead.id}:mover_${acao.para}`, async () => {
          await db.atualizarLead(lead.id, { estagio: acao.para }, ev.usuario_id);
          return { status: 'ok', detalhe: `${lead.estagio || 'novo'} -> ${acao.para}` };
        });
      }
    }
  }

  // Marca como processado mesmo quando a receita esta desligada — senao a fila cresce pra sempre.
  if (processados.length) {
    const { error: errUpd } = await sb.from('lead_eventos').update({ processado_em: agora.toISOString() }).in('id', processados);
    if (errUpd) throw errUpd;
  }
}

// ─────────────────────────────────────────────
// 2) Visitas -> lembrete_visita
// ─────────────────────────────────────────────
async function processarVisitas(ctx) {
  const { sb, push, enviarTemplate, executarUmaVez, agora, estourou } = ctx;
  // Receita nasce desligada: so quem ligou explicitamente tem linha ativo=true.
  const { data: ativos, error } = await sb.from('automacoes').select('usuario_id').eq('receita', 'lembrete_visita').eq('ativo', true);
  if (error) throw error;
  const usuarioIds = (ativos || []).map(a => a.usuario_id);
  if (!usuarioIds.length) return;

  const { data: visitas, error: errV } = await sb
    .from('visitas')
    .select('id, usuario_id, lead_nome, lead_telefone, imovel_titulo, data, horario, status')
    .in('usuario_id', usuarioIds)
    .in('status', ['agendada', 'confirmada', 'reagendada', 'realizada'])
    .gte('data', hojeRecife(agora, -2))
    .lte('data', hojeRecife(agora, 2))
    .limit(500);
  if (errV) throw errV;

  for (const v of visitas || []) {
    if (estourou()) break;
    const nome = R.nomeOuPadrao(v.lead_nome, 'tudo bem');
    const imovel = (v.imovel_titulo || '').trim();
    const horario = String(v.horario || '').slice(0, 5);
    const telefone = R.telefoneWhatsApp(v.lead_telefone);

    for (const marco of R.marcosVisita(v, agora)) {
      await executarUmaVez(v.usuario_id, 'lembrete_visita', `visita:${v.id}:${marco}`, async () => {
        if (!telefone) return { status: 'pulado', detalhe: 'visita sem telefone do cliente' };
        if (!enviarTemplate) return { status: 'pulado', detalhe: 'WhatsApp Cloud API nao configurada' };
        if (marco === 'pos') {
          await enviarTemplate(telefone, 'pos_visita', [nome, imovel || 'imóvel']);
          await enviarPush(push, v.usuario_id, {
            title: `🏠 Como foi a visita com ${R.nomeOuPadrao(v.lead_nome)}?`,
            body: 'Atualize o estágio do lead no funil.',
            url: '/?tab=funil',
            tag: `pos-visita-${v.id}`,
          });
        } else {
          await enviarTemplate(telefone, 'lembrete_visita', [nome, R.dataCurta(v.data), horario, imovel || 'o imóvel']);
          if (marco === '24h') {
            await enviarPush(push, v.usuario_id, {
              title: `📅 Amanhã: ${R.nomeOuPadrao(v.lead_nome)} · ${horario}`,
              body: imovel || 'Lembrete enviado ao cliente.',
              url: '/?tab=visitas',
              tag: `visita-${v.id}`,
            });
          }
        }
        return { status: 'ok', detalhe: `template enviado (${marco})` };
      });
    }
  }
}

// ─────────────────────────────────────────────
// 3) Leads parados -> sla_corretor
// ─────────────────────────────────────────────
async function processarSla(ctx) {
  const { sb, push, emails, executarUmaVez, agora, estourou } = ctx;
  const { data: linhas, error } = await sb.from('automacoes').select('usuario_id, ativo, config').eq('receita', 'sla_corretor');
  if (error) throw error;

  // Uniao das configs (padrao + personalizadas) pra montar UMA query.
  const cfgs = [R.RECEITAS.sla_corretor.configPadrao, ...(linhas || []).map(l => ({ ...R.RECEITAS.sla_corretor.configPadrao, ...(l.config || {}) }))];
  const estagios = [...new Set(cfgs.flatMap(c => c.estagios || []))];
  const minHoras = Math.min(...cfgs.map(c => c.horas || 48));
  const maxHoras = Math.max(...cfgs.map(c => c.horas || 48));
  if (!estagios.length) return;

  // Janela de 24h apos o limite: so alerta quem ACABOU de estourar. Evita
  // rajada de alertas de leads antigos no primeiro deploy (estagio_desde
  // foi preenchido com updated_at na migration).
  const { data: leads, error: errL } = await sb
    .from('leads')
    .select('id, usuario_id, nome, estagio, estagio_desde')
    .in('estagio', estagios)
    .not('usuario_id', 'is', null)
    .lt('estagio_desde', new Date(agora.getTime() - minHoras * HORA).toISOString())
    .gt('estagio_desde', new Date(agora.getTime() - (maxHoras + 24) * HORA).toISOString())
    .limit(500);
  if (errL) throw errL;
  if (!leads?.length) return;

  const configs = await carregarConfigs(sb, leads.map(l => l.usuario_id));
  const porUsuario = new Map();
  for (const lead of leads) {
    const c = configs.get(lead.usuario_id)?.sla_corretor;
    if (!c?.ativo || !R.slaEstourado(lead, agora, c.config)) continue;
    if (agora.getTime() - new Date(lead.estagio_desde).getTime() > (c.config.horas + 24) * HORA) continue;
    if (!porUsuario.has(lead.usuario_id)) porUsuario.set(lead.usuario_id, []);
    porUsuario.get(lead.usuario_id).push(lead);
  }

  for (const [usuarioId, lista] of porUsuario) {
    if (estourou()) break;
    // Reserva cada lead antes de avisar; so avisa os que ainda nao foram avisados.
    const novos = [];
    for (const lead of lista) {
      await executarUmaVez(usuarioId, 'sla_corretor', R.chaveSla(lead), async () => {
        novos.push(lead);
        return { status: 'ok', detalhe: `parado em ${lead.estagio}` };
      });
    }
    if (!novos.length) continue;

    const horas = configs.get(usuarioId).sla_corretor.config.horas;
    const nomes = novos.map(l => R.nomeOuPadrao(l.nome));
    await enviarPush(push, usuarioId, {
      title: novos.length === 1 ? `⏰ ${nomes[0]} está parado há ${horas}h` : `⏰ ${novos.length} leads parados há ${horas}h`,
      body: novos.length === 1 ? 'Sem mudança de estágio. Que tal retomar o contato?' : nomes.slice(0, 5).join(', '),
      url: '/?tab=funil',
      tag: 'sla',
    }).catch(e => console.error('[automacoes] push sla:', e.message));

    if (emails?.send) {
      const { data: u } = await sb.from('usuarios').select('email, nome').eq('id', usuarioId).maybeSingle();
      if (u?.email) {
        const itens = novos.map(l => `<li><strong>${escapeHtml(R.nomeOuPadrao(l.nome))}</strong> — em "${escapeHtml(l.estagio)}"</li>`).join('');
        await emails.send({
          to: u.email,
          subject: novos.length === 1 ? `Lead parado há ${horas}h: ${nomes[0]}` : `${novos.length} leads parados há ${horas}h`,
          html: `<p>Oi ${escapeHtml((u.nome || '').split(' ')[0] || '')},</p><p>Estes leads estão há mais de ${horas}h sem mudar de estágio:</p><ul>${itens}</ul><p><a href="${process.env.SITE_URL || 'https://app.leadhouses.com.br'}/?tab=funil">Abrir o funil</a></p>`,
        }).catch(e => console.error('[automacoes] email sla:', e.message));
      }
    }
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Executa um ciclo completo. Cada etapa isolada: falha numa nao impede as outras.
 * @returns {Promise<{instalado: boolean, eventos: number, acoes: number, erros: number, falhas: string[]}>}
 */
async function rodarCiclo({ db, push, emails, enviarTemplate, agora = new Date(), orcamentoMs = 45000 }) {
  const sb = db.supabase;
  const inicio = Date.now();
  const stats = { instalado: true, eventos: 0, acoes: 0, erros: 0, falhas: [] };
  const ctx = {
    sb, db, push, emails, enviarTemplate, agora, stats,
    executarUmaVez: criarExecutor(sb, stats),
    estourou: () => Date.now() - inicio > orcamentoMs,
  };

  for (const [nome, etapa] of [['eventos', processarEventos], ['visitas', processarVisitas], ['sla', processarSla]]) {
    if (ctx.estourou()) break;
    try {
      await etapa(ctx);
    } catch (e) {
      if (tabelaAusente(e)) return { ...stats, instalado: false };
      stats.erros++;
      stats.falhas.push(`${nome}: ${e.message}`);
      console.error(`[automacoes] etapa ${nome} falhou:`, e.message);
    }
  }
  return stats;
}

module.exports = { rodarCiclo, tabelaAusente };
