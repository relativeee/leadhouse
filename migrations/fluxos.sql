-- ============================================
-- LeadHouse — Migration: fluxos (Automacoes Fase 2)
-- Executar no SQL Editor do Supabase Dashboard DEPOIS de migrations/automacoes.sql
-- ============================================
-- Fluxos criados pelo corretor: gatilho -> grafo de nos (condicao | acao | esperar).
--
-- - fluxos: definicao. `nos` e um grafo { "<id>": {tipo, ..., proximo|sim|nao} }
--   validado no backend (utils/fluxosRegras.js validarFluxo).
-- - fluxo_inscricoes: um lead percorrendo um fluxo. O worker
--   /api/cron/automacoes avanca as inscricoes com proximo_em <= now().
-- - leads.ultima_msg_lead_em: carimbada por trigger quando total_mensagens
--   sobe (= lead mandou mensagem). Usada pra janela de 24h da Meta e pra
--   parar a sequencia quando o lead responde (evento lead_respondeu).
-- - automacao_execucoes.lead_id/canal: contagem de WhatsApp automatico por
--   lead por dia (trava de 2/dia).
--
-- Idempotente e sem DROP: pode rodar de novo sem efeito colateral.
-- Reversao rapida (para os fluxos sem mexer na Fase 1):
--   update fluxos set ativo = false;

alter table leads add column if not exists ultima_msg_lead_em timestamptz;
alter table automacao_execucoes add column if not exists lead_id bigint;
alter table automacao_execucoes add column if not exists canal text;
create index if not exists idx_automacao_execucoes_lead_canal
  on automacao_execucoes(lead_id, canal, criado_em) where lead_id is not null;

create table if not exists fluxos (
  id bigint generated always as identity primary key,
  usuario_id bigint not null references usuarios(id) on delete cascade,
  nome text not null,
  ativo boolean not null default false,
  gatilho jsonb not null,
  nos jsonb not null,
  no_inicial text not null,
  parar_se_responder boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_fluxos_usuario on fluxos(usuario_id) where ativo;

create table if not exists fluxo_inscricoes (
  id bigint generated always as identity primary key,
  fluxo_id bigint not null references fluxos(id) on delete cascade,
  usuario_id bigint not null references usuarios(id) on delete cascade,
  lead_id bigint not null references leads(id) on delete cascade,
  no_atual text,
  proximo_em timestamptz,
  status text not null default 'ativa' check (status in ('ativa', 'concluida', 'parada', 'erro')),
  motivo text,
  origem_chave text,           -- ev:123 | parado:... | visita:7:24h | manual:<ts>
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);
-- Um lead so pode estar uma vez ATIVO em cada fluxo.
create unique index if not exists uq_fluxo_inscricao_ativa on fluxo_inscricoes(fluxo_id, lead_id) where status = 'ativa';
-- O mesmo disparo (evento, SLA, marco de visita) nunca inscreve duas vezes.
create unique index if not exists uq_fluxo_inscricao_origem on fluxo_inscricoes(fluxo_id, origem_chave) where origem_chave is not null;
create index if not exists idx_fluxo_inscricoes_fila on fluxo_inscricoes(proximo_em) where status = 'ativa';
create index if not exists idx_fluxo_inscricoes_lead on fluxo_inscricoes(lead_id) where status = 'ativa';

-- BEFORE INSERT/UPDATE: carimba ultima_msg_lead_em quando chega mensagem do lead.
-- total_mensagens conta so mensagens do lead (role=user) — respostas da Lia e
-- envios automaticos nao mexem nele.
create or replace function leads_ultima_msg() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if coalesce(new.total_mensagens, 0) > 0 and new.ultima_msg_lead_em is null then
      new.ultima_msg_lead_em := now();
    end if;
  elsif coalesce(new.total_mensagens, 0) > coalesce(old.total_mensagens, 0) then
    new.ultima_msg_lead_em := now();
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_leads_ultima_msg') then
    create trigger trg_leads_ultima_msg before insert or update on leads
      for each row execute function leads_ultima_msg();
  end if;
end $$;

-- AFTER INSERT/UPDATE: mesma funcao da Fase 1 + evento lead_respondeu.
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
  if coalesce(new.total_mensagens, 0) > coalesce(old.total_mensagens, 0) then
    insert into lead_eventos(usuario_id, lead_id, tipo)
      values (new.usuario_id, new.id, 'lead_respondeu');
  end if;
  return new;
end $$;

alter table fluxos enable row level security;
alter table fluxo_inscricoes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'fluxos' and policyname = 'Bloqueia anon fluxos') then
    create policy "Bloqueia anon fluxos" on fluxos for all to anon using (false) with check (false);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'fluxo_inscricoes' and policyname = 'Bloqueia anon fluxo_inscricoes') then
    create policy "Bloqueia anon fluxo_inscricoes" on fluxo_inscricoes for all to anon using (false) with check (false);
  end if;
end $$;
