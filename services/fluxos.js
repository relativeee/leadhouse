/**
 * services/fluxos.js
 * Worker dos fluxos criados pelo corretor (Automacoes Fase 2). Roda dentro do
 * ciclo de services/automacoes.js (cron de 1 minuto).
 *
 *   inscreverPorEventos  — lead_eventos -> inscricoes (e para quem respondeu)
 *   inscreverPorTempo    — lead parado / marcos de visita -> inscricoes
 *   avancarInscricoes    — executa os passos devidos ate um "esperar" ou o fim
 *
 * Cada acao passa por executarUmaVez (unique em automacao_execucoes), entao
 * retry do cron nunca duplica envio. Decisoes ficam em utils/fluxosRegras.js.
 */

const F = require('../utils/fluxosRegras');
const R = require('../utils/automacoesRegras');

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const MAX_PASSOS_POR_CICLO = 30; // por inscricao — o grafo nao tem ciclo, e so um teto

const receitaDe = fluxo => `fluxo:${fluxo.id}`;

async function fluxosAtivos(sb, usuarioIds, filtroGatilho) {
  const ids = [...new Set(usuarioIds)].filter(Boolean);
  if (!ids.length) return [];
  const { data, error } = await sb.from('fluxos').select('*').in('usuario_id', ids).eq('ativo', true);
  if (error) throw error;
  return (data || []).filter(f => !filtroGatilho || filtroGatilho.includes(f.gatilho?.tipo));
}

async function carregarUsuarios(sb, ids, cache) {
  const faltam = [...new Set(ids)].filter(id => id && !cache.has(id));
  if (faltam.length) {
    const { data, error } = await sb
      .from('usuarios')
      .select('id, nome, email, plano, is_admin, trial_expires_at, horario_trabalho, evolution_instance_status')
      .in('id', faltam);
    if (error) throw error;
    for (const u of data || []) cache.set(u.id, u);
  }
  return cache;
}

/**
 * Cria a inscricao. Respeita: 1 ativa por (fluxo, lead), 1 por origem, e no
 * maximo N inscricoes do mesmo lead no mesmo fluxo por dia (evita ping-pong
 * entre fluxos que movem estagio um do outro).
 */
async function inscrever(ctx, fluxo, leadId, origemChave) {
  const { sb, agora, stats } = ctx;
  const { data: hoje, error: errC } = await sb
    .from('fluxo_inscricoes')
    .select('id')
    .eq('fluxo_id', fluxo.id)
    .eq('lead_id', leadId)
    .gte('criado_em', F.inicioDoDiaRecife(agora).toISOString())
    .limit(F.LIMITES.inscricoesPorLeadFluxoDia);
  if (errC) throw errC;
  if ((hoje || []).length >= F.LIMITES.inscricoesPorLeadFluxoDia) return false;

  const { error } = await sb.from('fluxo_inscricoes').insert({
    fluxo_id: fluxo.id,
    usuario_id: fluxo.usuario_id,
    lead_id: leadId,
    no_atual: fluxo.no_inicial,
    proximo_em: agora.toISOString(),
    status: 'ativa',
    origem_chave: origemChave,
    criado_em: agora.toISOString(),
  });
  if (error) {
    if (error.code === '23505') return false; // ja ativa nesse fluxo ou origem repetida
    throw error;
  }
  stats.fluxos.inscritos++;
  return true;
}

async function pararInscricoes(sb, filtro, motivo, agora) {
  let q = sb.from('fluxo_inscricoes').update({ status: 'parada', motivo, atualizado_em: agora.toISOString() }).eq('status', 'ativa');
  for (const [c, v] of Object.entries(filtro)) q = Array.isArray(v) ? q.in(c, v) : q.eq(c, v);
  const { error } = await q;
  if (error) throw error;
}

// ─────────────────────────────────────────────
// 1) Eventos -> inscricoes
// ─────────────────────────────────────────────
async function inscreverPorEventos(ctx, eventos) {
  const { sb, agora, estourou } = ctx;
  if (!eventos?.length) return;
  const fluxos = await fluxosAtivos(sb, eventos.map(e => e.usuario_id));
  const usuarios = await carregarUsuarios(sb, eventos.map(e => e.usuario_id), ctx.usuarios);

  for (const ev of eventos) {
    if (estourou()) break;
    const doUsuario = fluxos.filter(f => f.usuario_id === ev.usuario_id);

    // Parar sequencias: lead respondeu, ou foi fechado/perdido.
    if (ev.tipo === 'lead_respondeu') {
      const ids = doUsuario.filter(f => f.parar_se_responder).map(f => f.id);
      if (ids.length) await pararInscricoes(sb, { lead_id: ev.lead_id, fluxo_id: ids }, 'lead respondeu', agora);
    }
    if (ev.tipo === 'estagio_mudou' && F.ESTAGIOS_FINAIS.includes(ev.para)) {
      await pararInscricoes(sb, { lead_id: ev.lead_id, usuario_id: ev.usuario_id }, `lead ${ev.para}`, agora);
    }

    if (!F.planoPermiteFluxos(usuarios.get(ev.usuario_id), agora)) continue;
    for (const fluxo of doUsuario) {
      if (F.gatilhoCasa(fluxo.gatilho, ev)) await inscrever(ctx, fluxo, ev.lead_id, `ev:${ev.id}`);
    }
  }
}

// ─────────────────────────────────────────────
// 2) Gatilhos de tempo -> inscricoes
// ─────────────────────────────────────────────
async function inscreverPorTempo(ctx) {
  const { sb, agora, estourou } = ctx;
  const { data: ativos, error } = await sb.from('fluxos').select('*').eq('ativo', true);
  if (error) throw error;
  const todos = (ativos || []).filter(f => ['lead_parado', 'visita'].includes(f.gatilho?.tipo));
  if (!todos.length) return;
  const usuarios = await carregarUsuarios(sb, todos.map(f => f.usuario_id), ctx.usuarios);

  for (const fluxo of todos) {
    if (estourou()) break;
    if (!F.planoPermiteFluxos(usuarios.get(fluxo.usuario_id), agora)) continue;
    const g = fluxo.gatilho;

    if (g.tipo === 'lead_parado') {
      // Janela de 24h apos o limite: so quem ACABOU de estourar (igual ao SLA).
      const { data: leads, error: errL } = await sb
        .from('leads')
        .select('id, estagio, estagio_desde')
        .eq('usuario_id', fluxo.usuario_id)
        .eq('estagio', g.estagio)
        .lt('estagio_desde', new Date(agora.getTime() - g.horas * HORA).toISOString())
        .gt('estagio_desde', new Date(agora.getTime() - (g.horas + 24) * HORA).toISOString())
        .limit(200);
      if (errL) throw errL;
      for (const lead of leads || []) {
        await inscrever(ctx, fluxo, lead.id, `parado:${lead.id}:${lead.estagio}:${new Date(lead.estagio_desde).toISOString()}`);
      }
    }

    if (g.tipo === 'visita') {
      const { data: visitas, error: errV } = await sb
        .from('visitas')
        .select('id, lead_telefone, data, horario, status')
        .eq('usuario_id', fluxo.usuario_id)
        .in('status', ['agendada', 'confirmada', 'reagendada', 'realizada'])
        .gte('data', new Date(agora.getTime() - 2 * 24 * HORA).toISOString().slice(0, 10))
        .lte('data', new Date(agora.getTime() + 2 * 24 * HORA).toISOString().slice(0, 10))
        .limit(200);
      if (errV) throw errV;
      const devidas = (visitas || []).filter(v => R.marcosVisita(v, agora).includes(g.marco));
      if (!devidas.length) continue;
      // Visita nao tem lead_id: casa pelo telefone normalizado.
      const { data: leads, error: errL } = await sb.from('leads').select('id, telefone').eq('usuario_id', fluxo.usuario_id).limit(5000);
      if (errL) throw errL;
      const porTel = new Map((leads || []).map(l => [R.telefoneWhatsApp(l.telefone), l.id]).filter(([t]) => t));
      for (const v of devidas) {
        const leadId = porTel.get(R.telefoneWhatsApp(v.lead_telefone));
        if (leadId) await inscrever(ctx, fluxo, leadId, `visita:${v.id}:${g.marco}`);
      }
    }
  }
}

// ─────────────────────────────────────────────
// 3) Avancar inscricoes
// ─────────────────────────────────────────────

async function whatsappsHoje(sb, leadId, agora) {
  const { data, error } = await sb
    .from('automacao_execucoes')
    .select('id')
    .eq('lead_id', leadId)
    .eq('canal', 'whatsapp')
    .eq('status', 'ok')
    .gte('criado_em', F.inicioDoDiaRecife(agora).toISOString())
    .limit(F.LIMITES.whatsappPorLeadDia);
  if (error) throw error;
  return (data || []).length;
}

/**
 * Trava do WhatsApp automatico. Retorna null se pode enviar agora, ou a data
 * para a qual o passo deve ser adiado.
 */
async function adiarWhatsApp(ctx, usuario, lead) {
  const { sb, agora } = ctx;
  if (!F.dentroDoHorario(usuario.horario_trabalho, agora)) return F.proximoHorarioUtil(usuario.horario_trabalho, agora);
  if (await whatsappsHoje(sb, lead.id, agora) >= F.LIMITES.whatsappPorLeadDia) {
    return F.proximoHorarioUtil(usuario.horario_trabalho, F.inicioDoDiaRecife(agora, 1));
  }
  return null;
}

async function executarAcao(ctx, no, fluxo, usuario, lead) {
  const { db, push, emails, evolution, enviarMensagem, enviarTemplate, agora } = ctx;
  const t = s => F.renderTexto(s, lead, usuario);
  const nomeLead = R.nomeOuPadrao(lead.nome);

  switch (no.acao) {
    case 'push': {
      if (!push?.disponivel()) return { status: 'pulado', detalhe: 'push nao configurado' };
      const r = await push.sendPushParaCorretor(usuario.id, {
        title: t(no.titulo) || `${fluxo.nome}: ${nomeLead}`,
        body: t(no.texto),
        url: '/?tab=funil',
        tag: `fluxo-${fluxo.id}-${lead.id}`,
      });
      if (!r.sent) return { status: 'pulado', detalhe: 'corretor sem dispositivo com push ativo' };
      return { status: 'ok', detalhe: `push: ${nomeLead}` };
    }
    case 'email': {
      if (!emails?.send || !usuario.email) return { status: 'pulado', detalhe: 'e-mail indisponivel' };
      await emails.send({
        to: usuario.email,
        subject: t(no.titulo) || `${fluxo.nome}: ${nomeLead}`,
        html: `<p>${escapeHtml(t(no.texto)).replace(/\n/g, '<br>')}</p><p><a href="${process.env.SITE_URL || 'https://app.leadhouses.com.br'}/?tab=funil">Abrir o funil</a></p>`,
      });
      return { status: 'ok', detalhe: `e-mail: ${nomeLead}` };
    }
    case 'whatsapp':
    case 'whatsapp_template': {
      if (lead.lia_pausada) return { status: 'pulado', detalhe: 'lead com atendimento manual (Lia pausada)' };
      const telefone = R.telefoneWhatsApp(lead.telefone);
      if (!telefone) return { status: 'pulado', detalhe: 'lead sem telefone valido' };
      if (no.acao === 'whatsapp_template') {
        if (!enviarTemplate) return { status: 'pulado', detalhe: 'WhatsApp Cloud API nao configurada' };
        await enviarTemplate(telefone, no.template, (no.params || []).map(t));
        return { status: 'ok', detalhe: `template ${no.template}: ${nomeLead}` };
      }
      const msg = t(no.texto);
      if (usuario.evolution_instance_status === 'connected' && evolution?.sendText) {
        await evolution.sendText(usuario.id, telefone, msg);
        return { status: 'ok', detalhe: `WhatsApp: ${nomeLead}` };
      }
      if (enviarMensagem && F.dentroJanela24h(lead.ultima_msg_lead_em, agora)) {
        await enviarMensagem(telefone, msg);
        return { status: 'ok', detalhe: `WhatsApp: ${nomeLead}` };
      }
      return { status: 'pulado', detalhe: 'sem WhatsApp conectado e fora da janela de 24h da Meta (use um template)' };
    }
    case 'mover_estagio':
      await db.atualizarLead(lead.id, { estagio: no.para }, usuario.id);
      lead.estagio = no.para;
      return { status: 'ok', detalhe: `${nomeLead} -> ${no.para}` };
    case 'mudar_temperatura':
      await db.atualizarLead(lead.id, { temperatura: no.para }, usuario.id);
      lead.temperatura = no.para;
      return { status: 'ok', detalhe: `${nomeLead}: ${no.para}` };
    case 'pausar_lia':
    case 'retomar_lia': {
      const pausada = no.acao === 'pausar_lia';
      await db.atualizarLead(lead.id, { lia_pausada: pausada }, usuario.id);
      lead.lia_pausada = pausada;
      return { status: 'ok', detalhe: `Lia ${pausada ? 'pausada' : 'retomada'}: ${nomeLead}` };
    }
    default:
      return { status: 'pulado', detalhe: `acao desconhecida: ${no.acao}` };
  }
}

async function salvarInscricao(sb, insc, campos, agora) {
  const { error } = await sb.from('fluxo_inscricoes').update({ ...campos, atualizado_em: agora.toISOString() }).eq('id', insc.id).eq('status', 'ativa');
  if (error) throw error;
}

async function avancarInscricoes(ctx) {
  const { sb, agora, estourou, executarUmaVez, stats } = ctx;
  const { data: fila, error } = await sb
    .from('fluxo_inscricoes')
    .select('*')
    .eq('status', 'ativa')
    .lte('proximo_em', agora.toISOString())
    .order('proximo_em', { ascending: true })
    .limit(100);
  if (error) throw error;
  if (!fila?.length) return;

  const { data: fluxosFila, error: errF } = await sb.from('fluxos').select('*').in('id', [...new Set(fila.map(i => i.fluxo_id))]);
  if (errF) throw errF;
  const fluxos = new Map((fluxosFila || []).map(f => [f.id, f]));
  const usuarios = await carregarUsuarios(sb, fila.map(i => i.usuario_id), ctx.usuarios);

  for (const insc of fila) {
    if (estourou()) break;
    const fluxo = fluxos.get(insc.fluxo_id);
    const usuario = usuarios.get(insc.usuario_id);
    if (!fluxo || !fluxo.ativo) { await salvarInscricao(sb, insc, { status: 'parada', motivo: 'fluxo desligado' }, agora); continue; }
    if (!F.planoPermiteFluxos(usuario, agora)) continue; // plano sem fluxos: congela ate reativar

    const { data: lead, error: errL } = await sb
      .from('leads')
      .select('id, nome, telefone, temperatura, estagio, bairro, faixa_valor, objetivo, tipo_imovel, origem, pagamento, prazo, lia_pausada, ultima_msg_lead_em')
      .eq('id', insc.lead_id)
      .eq('usuario_id', insc.usuario_id)
      .maybeSingle();
    if (errL) throw errL;
    if (!lead) { await salvarInscricao(sb, insc, { status: 'parada', motivo: 'lead removido' }, agora); continue; }

    let noId = insc.no_atual;
    let fim = null; // { status, motivo } quando a inscricao termina
    let adiadoPara = null;

    for (let passos = 0; noId && passos < MAX_PASSOS_POR_CICLO; passos++) {
      const no = fluxo.nos?.[noId];
      if (!no) { fim = { status: 'erro', motivo: `passo ${noId} nao existe mais` }; break; }

      if (no.tipo === 'condicao') {
        const ok = F.avaliarCondicao(no, lead);
        noId = F.proximoNo(no, ok);
        if (!noId) fim = { status: 'concluida', motivo: ok ? null : 'condição não atendida' };
        continue;
      }

      if (no.tipo === 'esperar') {
        noId = no.proximo || null;
        if (!noId) { fim = { status: 'concluida', motivo: null }; break; }
        adiadoPara = new Date(agora.getTime() + no.minutos * MIN);
        break;
      }

      // acao
      const ehWhatsApp = no.acao === 'whatsapp' || no.acao === 'whatsapp_template';
      if (ehWhatsApp) {
        adiadoPara = await adiarWhatsApp(ctx, usuario, lead);
        if (adiadoPara) break; // fica neste passo ate o horario permitido
      }
      await executarUmaVez(usuario.id, receitaDe(fluxo), `insc:${insc.id}:no:${noId}`,
        () => executarAcao(ctx, no, fluxo, usuario, lead),
        ehWhatsApp ? { lead_id: lead.id, canal: 'whatsapp' } : { lead_id: lead.id });
      stats.fluxos.passos++;
      noId = F.proximoNo(no);
      if (!noId) fim = { status: 'concluida', motivo: null };
    }

    if (fim) await salvarInscricao(sb, insc, { status: fim.status, motivo: fim.motivo, no_atual: null, proximo_em: null }, agora);
    else await salvarInscricao(sb, insc, { no_atual: noId, proximo_em: (adiadoPara || agora).toISOString() }, agora);
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { inscreverPorEventos, inscreverPorTempo, avancarInscricoes, inscrever, receitaDe };
