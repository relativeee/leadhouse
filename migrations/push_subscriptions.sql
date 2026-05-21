-- ============================================
-- LeadHouse — Migration: push_subscriptions
-- Executar no SQL Editor do Supabase Dashboard
-- ============================================
-- Tabela que guarda as Web Push subscriptions de cada corretor.
-- Um corretor pode ter varias subscriptions (1 por device/browser).
--
-- NOTA: RLS habilitada com policy que bloqueia role 'anon'. Servidor
-- usa SUPABASE_SERVICE_ROLE (bypassa RLS) pra todas as queries. NAO
-- usamos auth.uid() porque LeadHouse usa JWT proprio, nao Supabase Auth.
-- Ownership por usuario_id e enforced no application layer (filtros
-- nos endpoints e queries) + RLS bloqueia anon como defesa em profundidade.

create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  usuario_id bigint not null references usuarios(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz default now(),
  last_used_at timestamptz default now()
);

create index if not exists idx_push_subscriptions_usuario_id on push_subscriptions(usuario_id);

-- RLS habilitada + bloqueio explicito pra anon. Service_role bypassa
-- RLS e continua funcionando normalmente do backend.
alter table push_subscriptions enable row level security;
drop policy if exists "owner_select" on push_subscriptions;
drop policy if exists "owner_insert" on push_subscriptions;
drop policy if exists "owner_delete" on push_subscriptions;
drop policy if exists "Bloqueia anon push_subscriptions" on push_subscriptions;
create policy "Bloqueia anon push_subscriptions"
  on push_subscriptions for all to anon
  using (false) with check (false);
