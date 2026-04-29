-- ============================================
-- LeadHouse — Schema Supabase
-- Execute no SQL Editor do Supabase Dashboard
-- ============================================

-- Imoveis
create table if not exists imoveis (
  id bigint generated always as identity primary key,
  titulo text not null,
  tipo text not null,
  status text default 'disponivel',
  endereco text default '',
  bairro text default '',
  cidade text default '',
  valor text default '',
  quartos text default '',
  vagas text default '',
  area text default '',
  descricao text default '',
  fotos_extras jsonb default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Leads (manual + whatsapp)
create table if not exists leads (
  id bigint generated always as identity primary key,
  nome text default '',
  telefone text not null,
  email text default '',
  objetivo text default '',
  tipo_imovel text default '',
  bairro text default '',
  faixa_valor text default '',
  pagamento text default '',
  prazo text default '',
  temperatura text default 'frio',
  proximo_passo text default '',
  resumo text default '',
  observacoes text default '',
  origem text default 'manual',
  total_mensagens int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Visitas
create table if not exists visitas (
  id bigint generated always as identity primary key,
  lead_nome text not null,
  lead_telefone text default '',
  imovel_titulo text default '',
  endereco text default '',
  data date not null,
  horario time not null,
  corretor text default '',
  observacoes text default '',
  status text default 'agendada',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- RLS ativada com policies que NEGAM acesso anon. O backend usa SUPABASE_SERVICE_ROLE
-- (que bypassa RLS) pra todas as queries. Defesa em profundidade: se a anon_key
-- vazar, ela sozinha nao consegue ler/editar/apagar nada.
alter table imoveis enable row level security;
alter table leads enable row level security;
alter table visitas enable row level security;

-- Negar tudo pra anon. Service_role bypassa RLS e continua funcionando.
create policy "Bloqueia anon imoveis" on imoveis for all to anon using (false) with check (false);
create policy "Bloqueia anon leads" on leads for all to anon using (false) with check (false);
create policy "Bloqueia anon visitas" on visitas for all to anon using (false) with check (false);

-- Usuarios
create table if not exists usuarios (
  id bigint generated always as identity primary key,
  nome text not null,
  email text unique not null,
  senha_hash text not null,
  created_at timestamptz default now()
);

alter table usuarios enable row level security;
create policy "Acesso total usuarios" on usuarios for all using (true) with check (true);
