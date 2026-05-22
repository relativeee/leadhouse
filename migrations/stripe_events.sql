-- ============================================
-- LeadHouse — Migration: stripe_events
-- Executar no SQL Editor do Supabase Dashboard
-- ============================================
-- Tabela usada pra idempotência de webhook Stripe.
-- Stripe pode retentar o MESMO evento varias vezes (sob falha de rede,
-- timeout, 5xx). Sem essa tabela, retry = duplo upgrade de plano,
-- duplo email de pagamento aprovado, duplo cancelamento. Resolve:
-- ANTES de processar, tenta insert com event.id como PK. Se PK
-- violation (23505), evento ja foi processado — retorna 200 sem agir.
--
-- RLS habilitada bloqueando anon. service_role bypassa.

create table if not exists stripe_events (
  event_id text primary key,
  type text not null,
  processed_at timestamptz default now()
);

alter table stripe_events enable row level security;
drop policy if exists "Bloqueia anon stripe_events" on stripe_events;
create policy "Bloqueia anon stripe_events"
  on stripe_events for all to anon
  using (false) with check (false);
