/**
 * services/supabase.js
 * Cliente Supabase e funcoes CRUD filtradas por usuario_id.
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─────────────────────────────────────────────
// Imoveis
// ─────────────────────────────────────────────
async function listarImoveis(userId) {
  const { data, error } = await supabase
    .from('imoveis')
    .select('*')
    .eq('usuario_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function criarImovel(imovel, userId) {
  const { data, error } = await supabase
    .from('imoveis')
    .insert({ ...imovel, usuario_id: userId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function atualizarImovel(id, campos, userId) {
  const { data, error } = await supabase
    .from('imoveis')
    .update(campos)
    .eq('id', id)
    .eq('usuario_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function excluirImovel(id, userId) {
  const { error } = await supabase
    .from('imoveis')
    .delete()
    .eq('id', id)
    .eq('usuario_id', userId);
  if (error) throw error;
}

// ─────────────────────────────────────────────
// Leads (manuais + whatsapp)
// ─────────────────────────────────────────────
async function listarLeads(origem, userId) {
  let query = supabase
    .from('leads')
    .select('*')
    .eq('usuario_id', userId)
    .order('created_at', { ascending: false });
  if (origem) query = query.eq('origem', origem);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function criarLead(lead, userId) {
  const { data, error } = await supabase
    .from('leads')
    .insert({ ...lead, usuario_id: userId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function buscarLeadPorTelefone(telefone, userId) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('telefone', telefone)
    .eq('origem', 'whatsapp')
    .eq('usuario_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertLeadWhatsApp(telefone, campos, userId) {
  const existente = await buscarLeadPorTelefone(telefone, userId);
  if (existente) {
    const { data, error } = await supabase
      .from('leads')
      .update({ ...campos, updated_at: new Date().toISOString() })
      .eq('id', existente.id)
      .eq('usuario_id', userId)
      .select()
      .single();
    if (error) throw error;
    return data;
  } else {
    return criarLead({ ...campos, telefone, origem: 'whatsapp' }, userId);
  }
}

async function atualizarLead(id, campos, userId) {
  const { data, error } = await supabase
    .from('leads')
    .update({ ...campos, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('usuario_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function excluirLead(id, userId) {
  const { error } = await supabase
    .from('leads')
    .delete()
    .eq('id', id)
    .eq('usuario_id', userId);
  if (error) throw error;
}

// ─────────────────────────────────────────────
// Visitas
// ─────────────────────────────────────────────
async function listarVisitas(userId) {
  const { data, error } = await supabase
    .from('visitas')
    .select('*')
    .eq('usuario_id', userId)
    .order('data', { ascending: true });
  if (error) throw error;
  return data;
}

async function criarVisita(visita, userId) {
  const { data, error } = await supabase
    .from('visitas')
    .insert({ ...visita, usuario_id: userId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function atualizarVisita(id, campos, userId) {
  const { data, error } = await supabase
    .from('visitas')
    .update(campos)
    .eq('id', id)
    .eq('usuario_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function excluirVisita(id, userId) {
  const { error } = await supabase
    .from('visitas')
    .delete()
    .eq('id', id)
    .eq('usuario_id', userId);
  if (error) throw error;
}

module.exports = {
  supabase,
  listarImoveis, criarImovel, atualizarImovel, excluirImovel,
  listarLeads, criarLead, buscarLeadPorTelefone, upsertLeadWhatsApp, atualizarLead, excluirLead,
  listarVisitas, criarVisita, atualizarVisita, excluirVisita,
};
