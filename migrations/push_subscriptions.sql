-- ============================================
-- LeadHouse — Migration: push_subscriptions
-- Executar no SQL Editor do Supabase Dashboard
-- ============================================
-- Tabela que guarda as Web Push subscriptions de cada corretor.
-- Um corretor pode ter varias subscriptions (1 por device/browser).
--
-- NOTA: Igual as outras tabelas (leads, imoveis, visitas), NAO usamos
-- Row Level Security aqui. O servidor LeadHouse usa JWT proprio (nao
-- Supabase Auth), entao auth.uid() nao resolve e RLS bloquearia tudo.
-- Ownership por usuario_id e enforced no application layer (filtros
-- nos endpoints e queries).

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

-- Se RLS foi habilitada por engano (versao anterior dessa migration),
-- desabilita pra liberar inserts/selects do servidor.
alter table push_subscriptions disable row level security;
drop policy if exists "owner_select" on push_subscriptions;
drop policy if exists "owner_insert" on push_subscriptions;
drop policy if exists "owner_delete" on push_subscriptions;
