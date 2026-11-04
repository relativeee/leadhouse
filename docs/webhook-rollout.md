# Ativacao das correcoes de WhatsApp

Este PR exige preparacao antes do deploy. Nao aplicar diretamente em producao sem validar em staging.

1. Aplicar `migrations/whatsapp_events.sql` no Supabase. As tabelas novas usam RLS e as RPCs so permitem `service_role`.
2. Configurar `META_APP_SECRET`, `WHATSAPP_PHONE_ID` e `META_WEBHOOK_USER_ID` (ID numerico do corretor dono desse numero em `usuarios`). A Meta suporta um numero/corretor configurado neste caminho; nao infere mais o dono pelo telefone do cliente ou por administrador.
3. Configurar `EVOLUTION_WEBHOOK_TOKEN` e atualizar as URLs das instancias existentes por `POST /api/admin/migrate-webhooks` como administrador. Configurar `CRON_SECRET` na Vercel.
4. Em staging, validar mensagem real via Meta e Evolution, assinatura invalida, mesma mensagem repetida, dois eventos simultaneos, mesmo telefone em dois corretores, pausa da Lia e lote Meta. Confirmar que a Evolution reenvia eventos apos HTTP 503; sem retry do provedor, mensagens concorrentes precisam de fila externa antes da ativacao.
5. Conferir `whatsapp_events`: sucesso fica `done`; falha fica `failed`; interrupcao pode deixar `processing`. O lock de conversa dura 120 segundos, acima do limite Vercel de 60 segundos. Nao aumentar maxDuration nem executar handlers por mais de 120 segundos sem renovar a lease.

## Falhas e recuperacao

Nao ha garantia de entrega exatamente uma vez na API externa. Timeout pode acontecer depois de WhatsApp aceitar texto/foto. Por isso eventos `failed` ou `processing` NAO sao reexecutados automaticamente: retornam 503 e precisam de revisao. Conferir conversa, logs e historico antes de decidir reprocessar. Retentar manualmente requer remover somente o registro do evento revisado e provocar redelivery; nunca limpar a tabela inteira. Um retry pode repetir ferramentas/fotos se houve entrega parcial.

O bloqueio serializa handlers WhatsApp, mas nao edicoes manuais/CSV do painel. Isso nao substitui uma futura fila/outbox e constraints para todos os produtores de dados. Notificacoes push e Calendar ainda usam tarefas sem await no pipeline existente; sua confiabilidade nao foi corrigida neste PR.

## Verificacao

`npm test` cobre assinatura, rejeicao sem segredos, isolamento em memoria, registro antes do acknowledgement, duplicatas/ocupacao/falhas e lotes Meta com mocks do banco. SQL e integracoes reais precisam da validacao de staging acima; nao foram executados no banco de producao.

## Rollback

Reverter o commit do aplicativo sem apagar tabelas/registro de eventos. Manter os segredos configurados. A versao antiga nao usa o ledger e pode repetir mensagens em redelivery; acompanhar o retorno do provedor.
