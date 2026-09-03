# LeadHaus AI — Qualificação de Leads Imobiliários

SaaS multi-tenant que recebe mensagens de leads via WhatsApp, conversa com eles
usando Claude IA ("Lia"), classifica a temperatura do lead, persiste no Supabase
e notifica o corretor. Inclui autenticação, planos pagos via Hotmart, PWA com
push notifications e um painel web.

---

## Sumário

- [Arquitetura](#arquitetura)
- [Setup rápido](#setup-rápido)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Banco de dados](#banco-de-dados)
- [Os dois caminhos de WhatsApp](#os-dois-caminhos-de-whatsapp)
- [Pagamentos](#pagamentos)
- [Deploy](#deploy)
- [Mapa de rotas](#mapa-de-rotas)
- [Notas para quem está chegando](#notas-para-quem-está-chegando)

---

## Arquitetura

```
leadhouse/
├── server.js              # Express: ~73 rotas, middlewares, webhooks (arquivo grande)
├── prompts/
│   └── systemPrompt.js    # Personalidade e instruções da Lia
├── services/
│   ├── auth.js            # JWT, hash de senha, middleware de sessão
│   ├── claude.js          # Anthropic SDK — respostas e extração estruturada
│   ├── emails.js          # Transacionais via Resend
│   ├── evolution.js       # WhatsApp via Evolution API (Baileys)
│   ├── hotmart.js         # Webhooks e planos (provedor de pagamento ATIVO)
│   ├── liaTools.js        # Tool use da Lia (consulta imóveis, agenda, etc.)
│   ├── logger.js          # Log estruturado
│   ├── push.js            # Web Push (VAPID)
│   ├── sheets.js          # Google Sheets (backup opcional de leads)
│   ├── supabase.js        # Cliente Supabase (service_role)
│   └── whatsapp.js        # WhatsApp Cloud API oficial (Meta)
├── utils/
│   └── leadScoring.js     # Temperatura por pontuação (quente/morno/frio)
├── public/                # Painel, landing, login, PWA (sw.js, manifest)
├── migrations/            # SQL incremental (rodar na ordem, ver abaixo)
├── supabase-schema.sql    # Schema base
└── vercel.json            # Rotas, builds e cron
```

**Stack:** Node 18+ · Express · Supabase (Postgres) · Anthropic Claude ·
WhatsApp (Meta Cloud API **e** Evolution) · Hotmart · Resend · Sentry · Vercel.

---

## Setup rápido

```bash
git clone <repo>
cd leadhouse
npm install
cp .env.example .env   # preencha os valores — veja a seção abaixo
npm run dev            # nodemon na porta 3000
```

Para o webhook funcionar em desenvolvimento você precisa de HTTPS público:

```bash
npx ngrok http 3000
```

Use a URL gerada ao configurar o webhook na Meta ou na Evolution.

---

## Variáveis de ambiente

O [.env.example](.env.example) é a fonte da verdade — está comentado var a var,
com link de onde obter cada valor. Resumo do que **quebra o boot se faltar**:

| Var | Por quê |
|-----|---------|
| `JWT_SECRET` | assinatura das sessões |
| `SUPABASE_URL` | conexão com o banco |
| `SUPABASE_SERVICE_ROLE` | chave que bypassa RLS — **nunca exponha no front** |
| `ANTHROPIC_API_KEY` | a Lia não responde sem isso |

O resto é degradação graciosa: sem `RESEND_API_KEY` não sai email, sem
`VAPID_*` não sai push, sem `SENTRY_DSN` não há error tracking, e sem as vars
de Hotmart o checkout fica inativo.

> `.env` está no `.gitignore` e nunca foi commitado. Mantenha assim.

---

## Banco de dados

Rode no SQL Editor do Supabase, **nesta ordem**:

1. `supabase-schema.sql` — tabelas base: `usuarios`, `leads`, `imoveis`, `visitas`
2. `migrations/password_resets.sql`
3. `migrations/push_subscriptions.sql`
4. `migrations/hotmart_events.sql` — idempotência dos webhooks de pagamento
5. `migrations/stripe_events.sql` — legado, ver [Pagamentos](#pagamentos)
6. `migrations/indexes_hot_queries.sql` — índices; rode por último

Não há ferramenta de migration automatizada: o SQL é aplicado à mão.

---

## Os dois caminhos de WhatsApp

Isto costuma confundir quem chega. Existem **duas** integrações vivas:

| | Meta Cloud API | Evolution API |
|---|---|---|
| Serviço | [services/whatsapp.js](services/whatsapp.js) | [services/evolution.js](services/evolution.js) |
| Webhook | `POST /webhook` | `POST /webhook/evolution` |
| Autenticação do webhook | `X-Hub-Signature-256` via `META_APP_SECRET` | `?token=` via `EVOLUTION_WEBHOOK_TOKEN` |
| Número | oficial, aprovado pela Meta | número pessoal do corretor (Baileys) |

A Evolution valida o token por **query string** por compatibilidade com a v2.x.
Instâncias criadas antes desse esquema precisam de um
`POST /api/admin/migrate-webhooks` para reescrever a URL do webhook.

---

## Pagamentos

**Hotmart é o provedor ativo.** Stripe foi substituído — o código do webhook
continua no repositório e funcional, mas sem as env vars fica em no-op. As
rotas ainda se chamam `/api/stripe/*` (assinatura, troca de plano, cancelamento)
por compatibilidade com o front; isso é dívida técnica conhecida, não um bug.

Webhooks de pagamento são idempotentes via as tabelas `hotmart_events` /
`stripe_events` — o mesmo evento reprocessado não duplica efeito.

---

## Deploy

`git push` na branch `main` dispara o deploy na Vercel. A configuração de rotas,
o `maxDuration` de 60s e o cron diário (`/api/cron/trial-expiring`, 13:00 UTC)
estão em [vercel.json](vercel.json).

Ao mexer em qualquer coisa de `public/`, **suba a versão do cache no
[public/sw.js](public/sw.js)** — senão o service worker serve o bundle antigo
para quem já instalou o PWA.

Healthcheck: `GET /health`.

---

## Mapa de rotas

`server.js` tem ~3.400 linhas. Para navegar:

| Área | Prefixo | Proteção |
|------|---------|----------|
| Autenticação | `/api/auth/*` | pública (rate limited) + `authMiddleware` |
| Login Google / Calendar | `/api/google/*` | OAuth |
| Leads, imóveis, visitas | `/api/leads`, `/api/imoveis`, `/api/visitas` | `authMiddleware` + `requirePlan` |
| Agente / Lia | `/api/agente/*`, `/api/lia/*` | + `requireAI` |
| Push | `/api/push/*` | `authMiddleware` |
| Admin | `/api/admin/*` | `authMiddleware` + `adminOnly` |
| Webhooks | `/webhook`, `/webhook/evolution`, `/api/hotmart/webhook` | assinatura/token próprios |
| Cron | `/api/cron/*` | `CRON_SECRET` |

Os webhooks de pagamento são registrados **antes** do `express.json()` global
porque precisam do corpo cru para validar assinatura. Não mova essas linhas.

---

## Notas para quem está chegando

- **`server.js` é grande demais.** Quebrar em routers é a refatoração mais
  valiosa pendente, mas exige cuidado com a ordem dos middlewares.
- **Não há testes automatizados.** Validação hoje é manual + deploy.
- **Histórico de conversa fica em memória** no processo. Em serverless isso
  significa que reinícios perdem contexto — migrar para o banco é o próximo
  passo natural.
- **Rate limiting** existe em `/api/auth/*` e `/api/`, via `express-rate-limit`.
- `.env` nunca vai para o git. Para rodar local, peça os valores ao dono do
  projeto — não copie de logs nem de deploy.
