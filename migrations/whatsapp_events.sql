-- Apply before deploying the webhook changes. Only service_role can use these RPCs.
create table if not exists public.whatsapp_events (
  provider text not null,
  usuario_id bigint not null references public.usuarios(id) on delete cascade,
  telefone text not null,
  event_id text not null,
  owner uuid not null,
  status text not null check (status in ('processing', 'done', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, usuario_id, event_id)
);
create table if not exists public.whatsapp_conversation_locks (
  usuario_id bigint not null references public.usuarios(id) on delete cascade,
  telefone text not null,
  owner uuid not null,
  expires_at timestamptz not null,
  primary key (usuario_id, telefone)
);
alter table public.whatsapp_events enable row level security;
alter table public.whatsapp_conversation_locks enable row level security;
revoke all on public.whatsapp_events, public.whatsapp_conversation_locks from anon, authenticated;
grant all on public.whatsapp_events, public.whatsapp_conversation_locks to service_role;

create or replace function public.claim_whatsapp_event(
  p_provider text, p_user bigint, p_phone text, p_event text, p_owner uuid
) returns text language plpgsql set search_path = public as $$
declare previous_status text;
begin
  -- Transaction-scoped mutex protects the check+insert across all instances.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_phone, 0));
  select status into previous_status from whatsapp_events
    where provider = p_provider and usuario_id = p_user and event_id = p_event;
  if previous_status = 'done' then return 'done'; end if;
  -- Failed/abandoned events require review: a provider may have accepted a send
  -- even when our request timed out. Blind retries can duplicate replies/photos.
  if previous_status is not null then return 'review'; end if;
  if exists (select 1 from whatsapp_conversation_locks
    where usuario_id = p_user and telefone = p_phone and expires_at > now()) then
    return 'busy';
  end if;
  insert into whatsapp_conversation_locks values (p_user, p_phone, p_owner, now() + interval '120 seconds')
    on conflict (usuario_id, telefone) do update set owner = excluded.owner, expires_at = excluded.expires_at;
  insert into whatsapp_events(provider, usuario_id, telefone, event_id, owner, status)
    values (p_provider, p_user, p_phone, p_event, p_owner, 'processing');
  return 'claimed';
end $$;

create or replace function public.finish_whatsapp_event(
  p_provider text, p_user bigint, p_phone text, p_event text, p_owner uuid, p_success boolean
) returns void language plpgsql set search_path = public as $$
begin
  update whatsapp_events set status = case when p_success then 'done' else 'failed' end, updated_at = now()
    where provider = p_provider and usuario_id = p_user and event_id = p_event and owner = p_owner and status = 'processing';
  if not found then raise exception 'Event ownership lost'; end if;
  delete from whatsapp_conversation_locks where usuario_id = p_user and telefone = p_phone and owner = p_owner;
end $$;
revoke all on function public.claim_whatsapp_event(text,bigint,text,text,uuid) from public, anon, authenticated;
revoke all on function public.finish_whatsapp_event(text,bigint,text,text,uuid,boolean) from public, anon, authenticated;
grant execute on function public.claim_whatsapp_event(text,bigint,text,text,uuid) to service_role;
grant execute on function public.finish_whatsapp_event(text,bigint,text,text,uuid,boolean) to service_role;
