-- ============================================
-- LeadHouse — Migration: hotmart_events
-- Executar no SQL Editor do Supabase Dashboard
-- ============================================
-- Tabela usada pra idempotencia de webhook Hotmart.
-- Hotmart pode retentar o mesmo evento (mesmo `id`) em caso de timeout/5xx.
-- Sem essa tabela, retry = duplo upgrade de plano, duplo email. Resolve:
-- ANTES de processar, tenta insert com event.id como PK. Se PK violation
-- (23505), evento ja foi processado -> retorna 200 sem agir.
--
-- RLS habilitada bloqueando anon. service_role bypassa.

create table if not exists hotmart_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz default now()
);

alter table hotmart_events enable row level security;
drop policy if exists "Bloqueia anon hotmart_events" on hotmart_events;
create policy "Bloqueia anon hotmart_events"
  on hotmart_events for all to anon
  using (false) with check (false);

-- Adiciona colunas Hotmart em usuarios (mantemos stripe_* tambem pra compat)
alter table usuarios
  add column if not exists hotmart_subscriber_code text,
  add column if not exists hotmart_transaction_id text;

create index if not exists idx_usuarios_hotmart_subscriber
  on usuarios(hotmart_subscriber_code)
  where hotmart_subscriber_code is not null;
