/**
 * services/supabase.js
 * Cliente Supabase e funcoes CRUD para imoveis, leads e visitas.
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─────────────────────────────────────────────
// Imoveis
// ─────────────────────────────────────────────
async function listarImoveis() {
  const { data, error } = await supabase
    .from('imoveis')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function criarImovel(imovel) {
  const { data, error } = await supabase
    .from('imoveis')
    .insert(imovel)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function atualizarImovel(id, campos) {
  const { data, error } = await supabase
    .from('imoveis')
    .update(campos)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function excluirImovel(id) {
  const { error } = await supabase
    .from('imoveis')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ─────────────────────────────────────────────
// Leads (manuais + whatsapp)
// ─────────────────────────────────────────────
async function listarLeads(origem) {
  let query = supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false });
  if (origem) query = query.eq('origem', origem);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function criarLead(lead) {
  const { data, error } = await supabase
    .from('leads')
    .insert(lead)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function buscarLeadPorTelefone(telefone) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('telefone', telefone)
    .eq('origem', 'whatsapp')
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertLeadWhatsApp(telefone, campos) {
  const existente = await buscarLeadPorTelefone(telefone);
  if (existente) {
    const { data, error } = await supabase
      .from('leads')
      .update({ ...campos, updated_at: new Date().toISOString() })
      .eq('id', existente.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  } else {
    return criarLead({ ...campos, telefone, origem: 'whatsapp' });
  }
}

async function atualizarLead(id, campos) {
  const { data, error } = await supabase
    .from('leads')
    .update({ ...campos, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function excluirLead(id) {
  const { error } = await supabase
    .from('leads')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ─────────────────────────────────────────────
// Visitas
// ─────────────────────────────────────────────
async function listarVisitas() {
  const { data, error } = await supabase
    .from('visitas')
    .select('*')
    .order('data', { ascending: true });
  if (error) throw error;
  return data;
}

async function criarVisita(visita) {
  const { data, error } = await supabase
    .from('visitas')
    .insert(visita)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function atualizarVisita(id, campos) {
  const { data, error } = await supabase
    .from('visitas')
    .update(campos)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function excluirVisita(id) {
  const { error } = await supabase
    .from('visitas')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

module.exports = {
  supabase,
  listarImoveis, criarImovel, atualizarImovel, excluirImovel,
  listarLeads, criarLead, buscarLeadPorTelefone, upsertLeadWhatsApp, atualizarLead, excluirLead,
  listarVisitas, criarVisita, atualizarVisita, excluirVisita,
};
