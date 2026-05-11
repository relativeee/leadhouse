-- ============================================
-- LeadHouse — Migration: push_subscriptions
-- Executar no SQL Editor do Supabase Dashboard
-- ============================================
-- Tabela que guarda as Web Push subscriptions de cada corretor.
-- Um corretor pode ter varias subscriptions (1 por device/browser).

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

-- Index pra buscar todas subscriptions de um corretor rapidamente
create index if not exists idx_push_subscriptions_usuario_id on push_subscriptions(usuario_id);

-- RLS: cada corretor so ve suas proprias subscriptions
alter table push_subscriptions enable row level security;

-- Service role bypassa RLS automaticamente. Politicas abaixo sao
-- pro caso de algum codigo client-side usar anon_key (nao deveria).
drop policy if exists "owner_select" on push_subscriptions;
create policy "owner_select" on push_subscriptions
  for select using (auth.uid()::text = usuario_id::text);

drop policy if exists "owner_insert" on push_subscriptions;
create policy "owner_insert" on push_subscriptions
  for insert with check (auth.uid()::text = usuario_id::text);

drop policy if exists "owner_delete" on push_subscriptions;
create policy "owner_delete" on push_subscriptions
  for delete using (auth.uid()::text = usuario_id::text);
