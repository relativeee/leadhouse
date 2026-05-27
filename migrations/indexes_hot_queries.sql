-- ============================================
-- LeadHouse — Migration: indexes pra queries quentes
-- Executar no SQL Editor do Supabase Dashboard
-- ============================================
-- Queries mais frequentes no webhook pipeline (Lia recebendo mensagens)
-- e no dashboard (listar leads/imoveis por corretor). Sem esses indexes,
-- Postgres faz sequential scan em toda a tabela — OK com 100 leads,
-- lento com 10k+.
--
-- Todos os indexes sao IF NOT EXISTS — seguro rodar multiplas vezes.

-- leads: busca por telefone+origem+usuario_id (webhook dedup, upsert, busca)
-- Usado em: buscarLeadPorTelefone, upsertLeadWhatsApp, webhook pipeline
create index if not exists idx_leads_telefone_origem_usuario
  on leads(telefone, origem, usuario_id);

-- leads: listagem por usuario ordenada por data (dashboard, admin metricas)
create index if not exists idx_leads_usuario_created
  on leads(usuario_id, created_at desc);

-- imoveis: listagem por usuario (dashboard, Lia tool imoveis)
create index if not exists idx_imoveis_usuario
  on imoveis(usuario_id);

-- visitas: listagem por usuario ordenada por data (dashboard, agenda)
create index if not exists idx_visitas_usuario_data
  on visitas(usuario_id, data asc);

-- usuarios: busca por email (login, forgot password, Google OAuth, Stripe webhook)
create index if not exists idx_usuarios_email
  on usuarios(email);

-- usuarios: busca por stripe_customer_id (Stripe webhook subscription.updated/deleted)
create index if not exists idx_usuarios_stripe_customer
  on usuarios(stripe_customer_id)
  where stripe_customer_id is not null;

-- usuarios: busca por evolution_instance_name (Evolution webhook identifica dono)
create index if not exists idx_usuarios_evolution_instance
  on usuarios(evolution_instance_name)
  where evolution_instance_name is not null;
