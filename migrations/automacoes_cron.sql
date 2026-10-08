-- ============================================
-- LeadHouse — Migration: agendamento do worker de automacoes
-- Executar no SQL Editor do Supabase Dashboard DEPOIS de:
--   1) migrations/automacoes.sql
--   2) deploy do endpoint /api/cron/automacoes na Vercel
--   3) habilitar as extensoes pg_cron e pg_net (Database -> Extensions)
-- ============================================
-- O secret NAO fica neste arquivo. Rode UMA vez, a mao, trocando o valor
-- pelo CRON_SECRET configurado na Vercel:
--
--   select vault.create_secret('<CRON_SECRET>', 'leadhaus_cron_secret');
--
-- Verificacao (apos ~3 min):
--   select status_code, created from net._http_response order by created desc limit 3;  -- 200
--   select status, start_time from cron.job_run_details order by start_time desc limit 3; -- succeeded
--
-- Reversao:
--   select cron.unschedule('leadhaus-automacoes');

select cron.unschedule('leadhaus-automacoes')
where exists (select 1 from cron.job where jobname = 'leadhaus-automacoes');

select cron.schedule('leadhaus-automacoes', '* * * * *', $$
  select net.http_get(
    url := 'https://app.leadhouses.com.br/api/cron/automacoes',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'leadhaus_cron_secret')
    ),
    timeout_milliseconds := 55000
  );
$$);
