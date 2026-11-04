-- ============================================
-- LeadHouse — Migration: automacoes (Fase 1)
-- Executar no SQL Editor do Supabase Dashboard
-- ============================================
-- Motor de automacoes estilo CRM (gatilho -> condicao -> acao).
--
-- - leads.estagio_desde: desde quando o lead esta no estagio atual (SLA).
-- - lead_eventos: eventos do lead gravados por TRIGGER — cobre todos os
--   caminhos de escrita (webhooks Meta/Evolution, CRUD manual, /estagio,
--   importacao CSV). Consumido pelo worker /api/cron/automacoes.
-- - automacoes: liga/desliga + config por corretor. Sem linha = default
--   da receita definido em utils/automacoesRegras.js.
-- - automacao_execucoes: idempotencia (unique por receita+chave) e
--   historico exibido na aba Automacoes.
--
-- RLS: mesmo padrao das outras tabelas — bloqueia anon, backend usa
-- service_role. Ownership por usuario_id e enforced no application layer.
--
-- Idempotente: pode rodar de novo sem efeito colateral.
-- Reversao rapida (se a trigger causar problema nos webhooks):
--   drop trigger if exists trg_leads_evento on leads;
--   drop trigger if exists trg_leads_estagio_desde on leads;

alter table leads add column if not exists estagio_desde timestamptz default now();

create table if not exists lead_eventos (
  id bigint generated always as identity primary key,
  usuario_id bigint not null references usuarios(id) on delete cascade,
  lead_id bigint not null references leads(id) on delete cascade,
  tipo text not null,            -- lead_criado | estagio_mudou | temperatura_mudou
  de text,
  para text,
  criado_em timestamptz default now(),
  processado_em timestamptz
);
create index if not exists idx_lead_eventos_pendentes on lead_eventos(id) where processado_em is null;
create index if not exists idx_lead_eventos_lead on lead_eventos(lead_id);

create table if not exists automacoes (
  id bigint generated always as identity primary key,
  usuario_id bigint not null references usuarios(id) on delete cascade,
  receita text not null,         -- lead_quente | lembrete_visita | sla_corretor
  ativo boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  unique (usuario_id, receita)
);

create table if not exists automacao_execucoes (
  id bigint generated always as identity primary key,
  usuario_id bigint not null references usuarios(id) on delete cascade,
  receita text not null,
  chave text not null,           -- ex: lead:42:quente:901, visita:7:24h
  status text not null default 'ok',  -- ok | erro | pulado
  detalhe text,
  criado_em timestamptz default now(),
  unique (usuario_id, receita, chave)
);
create index if not exists idx_automacao_execucoes_usuario on automacao_execucoes(usuario_id, criado_em desc);

-- BEFORE UPDATE: carimba estagio_desde quando o estagio muda
create or replace function leads_estagio_desde() returns trigger language plpgsql as $$
begin
  if new.estagio is distinct from old.estagio then
    new.estagio_desde := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_leads_estagio_desde on leads;
create trigger trg_leads_estagio_desde before update on leads
  for each row execute function leads_estagio_desde();

-- AFTER INSERT/UPDATE: registra eventos para o motor
create or replace function leads_registrar_evento() returns trigger language plpgsql as $$
begin
  -- Lead sem dono (webhook Meta sem admin): nao registra. Sem esse guard o
  -- insert violaria o not null e derrubaria o upsert do lead.
  if new.usuario_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    insert into lead_eventos(usuario_id, lead_id, tipo, para)
      values (new.usuario_id, new.id, 'lead_criado', new.estagio);
    if new.temperatura = 'quente' then
      insert into lead_eventos(usuario_id, lead_id, tipo, de, para)
        values (new.usuario_id, new.id, 'temperatura_mudou', null, 'quente');
    end if;
    return new;
  end if;

  if new.estagio is distinct from old.estagio then
    insert into lead_eventos(usuario_id, lead_id, tipo, de, para)
      values (new.usuario_id, new.id, 'estagio_mudou', old.estagio, new.estagio);
  end if;
  if new.temperatura is distinct from old.temperatura then
    insert into lead_eventos(usuario_id, lead_id, tipo, de, para)
      values (new.usuario_id, new.id, 'temperatura_mudou', old.temperatura, new.temperatura);
  end if;
  return new;
end $$;

drop trigger if exists trg_leads_evento on leads;
create trigger trg_leads_evento after insert or update on leads
  for each row execute function leads_registrar_evento();

alter table lead_eventos enable row level security;
alter table automacoes enable row level security;
alter table automacao_execucoes enable row level security;
drop policy if exists "Bloqueia anon lead_eventos" on lead_eventos;
drop policy if exists "Bloqueia anon automacoes" on automacoes;
drop policy if exists "Bloqueia anon automacao_execucoes" on automacao_execucoes;
create policy "Bloqueia anon lead_eventos" on lead_eventos for all to anon using (false) with check (false);
create policy "Bloqueia anon automacoes" on automacoes for all to anon using (false) with check (false);
create policy "Bloqueia anon automacao_execucoes" on automacao_execucoes for all to anon using (false) with check (false);
