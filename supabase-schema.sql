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
  area text default '',
  descricao text default '',
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

-- Habilitar RLS (Row Level Security) com acesso publico para a anon key
alter table imoveis enable row level security;
alter table leads enable row level security;
alter table visitas enable row level security;

create policy "Acesso total imoveis" on imoveis for all using (true) with check (true);
create policy "Acesso total leads" on leads for all using (true) with check (true);
create policy "Acesso total visitas" on visitas for all using (true) with check (true);

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
