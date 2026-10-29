-- ============================================
-- LeadHouse — Migration: roteiro da Lia (Fluxos Fase 2, entrega 3)
-- Executar no SQL Editor do Supabase Dashboard ANTES do deploy.
-- ============================================
-- usuarios.roteiro_ia: perguntas, tom e passagem ao corretor configurados na
-- tela Configuracoes -> Roteiro da Lia. Formato validado no backend
-- (utils/roteiroIA.js validarRoteiro). null = roteiro padrao da Lia.
--
-- O backend tolera a coluna ausente (Lia segue no roteiro padrao), mas a tela
-- so salva depois desta migration.
--
-- Idempotente e sem DROP. Reversao rapida (volta todo mundo ao padrao):
--   update usuarios set roteiro_ia = null;

alter table usuarios add column if not exists roteiro_ia jsonb;
