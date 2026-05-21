-- ============================================
-- LeadHouse — Migration: password_resets
-- Executar no SQL Editor do Supabase Dashboard
-- ============================================
-- Tabela usada pelo fluxo "esqueci minha senha".
-- Server cria registro com token aleatorio (crypto.randomBytes(32)),
-- usuario clica no link no email com ?token=..., server valida token
-- nao usado e nao expirado, e troca a senha em usuarios.senha_hash.
--
-- RLS habilitada com policy bloqueando role 'anon'. Servidor usa
-- SUPABASE_SERVICE_ROLE (bypassa RLS). NAO usamos auth.uid() porque
-- LeadHouse usa JWT proprio, nao Supabase Auth. Tokens sao MUITO
-- sensiveis (concedem reset de senha) — defesa em profundidade critica.

create table if not exists password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null,
  token text not null,
  expires_at timestamptz not null,
  used boolean default false,
  created_at timestamptz default now()
);

alter table password_resets enable row level security;
drop policy if exists "Bloqueia anon password_resets" on password_resets;
create policy "Bloqueia anon password_resets"
  on password_resets for all to anon
  using (false) with check (false);
