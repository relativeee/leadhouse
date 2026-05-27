# LeadHaus AI — Project Context for Claude Code

Sistema Node.js de qualificação de leads imobiliários via WhatsApp Cloud API + Claude AI + Google Sheets.

## Stack

- **Runtime:** Node.js 18+, Express
- **IA:** Anthropic Claude (`services/claude.js`)
- **Mensageria:** WhatsApp Cloud API / Meta (`services/whatsapp.js`)
- **Persistência:** Google Sheets API (`services/sheets.js`)
- **DB:** Supabase (ver `supabase-schema.sql`)
- **Deploy:** Vercel (`vercel.json`)

## Arquivos principais

- [server.js](server.js) — entrypoint Express
- [prompts/systemPrompt.js](prompts/systemPrompt.js) — personalidade da IA
- [services/](services/) — integrações externas
- [utils/leadScoring.js](utils/leadScoring.js) — temperatura por pontuação
- [migrations/](migrations/) — schema Supabase

## Mega Brain Integration

Este projeto compartilha skills, hooks, rules e commands com o **Mega Brain** global:

```
MEGA_BRAIN_ROOT = c:\Users\magal\Documents\mybrain  (User-scope env var)
```

### Disponível automaticamente (via `~/.claude/`)

| Tipo | Quantidade | Onde |
|------|-----------|------|
| Skills | 47 | `C:\Users\magal\.claude\skills\` |
| Hooks | 41 | `C:\Users\magal\.claude\hooks\` |
| Rules | 18 | `C:\Users\magal\.claude\rules\` |
| Commands | 39 | `C:\Users\magal\.claude\commands\` |

### Skills úteis para LeadHaus

- `code-review` — revisão de PRs
- `feature-dev` — desenvolvimento de feature
- `verification-before-completion` — verificação antes de declarar pronto
- `simplify` — review de qualidade de código
- `security-review` — auditoria de segurança
- `claude-api` — boas práticas Anthropic SDK (relevante para `services/claude.js`)
- GSD suite (`/gsd:*`) — planejamento de fases

### Commands que NÃO funcionam fora do Mega Brain

`/jarvis-briefing`, `/conclave`, `/extract-dna`, `/ingest-empresa`, `/ingest-pessoal`, `/process-jarvis`, `/system-digest`, `/inbox`, `/agents`, `/dossiers`, `/debate`, `/compare`, `/ask`, `/create-agent`, `/view-dna`, `/mission-autopilot`, `/ler-drive`, `/extract-knowledge`, `/chat`

→ Esses dependem de arquivos em `Documents\mybrain\` (agents, knowledge, workspace).
→ Para usar, abra o Claude Code em `c:\Users\magal\Documents\mybrain`.

## Convenções específicas do LeadHaus

- **Secrets:** nunca commitar `.env`. Variáveis sensíveis em `.env` (gitignored).
- **Webhook URL:** configurada na Meta Console, não hardcoded.
- **Lead scoring:** thresholds em `utils/leadScoring.js`. Mudanças afetam classificação quente/morno/frio.
- **Migrations:** Supabase rodadas via SQL direto (ver `migrations/`).
- **Deploy:** `git push` para branch principal aciona Vercel.

## Regras herdadas do Mega Brain global

Todas as regras em `C:\Users\magal\.claude\rules\` aplicam-se aqui:

- `agent-cognition.md` — protocolo cognitivo
- `agent-integrity.md` — integridade e rastreabilidade
- `ANTHROPIC-STANDARDS.md` — boas práticas hooks/skills/MCP
- `epistemic-standards.md` — anti-alucinação
- `mcp-governance.md` — governança MCP
- `no-secrets-in-memory.md` — proibição de credenciais em memory files
- `state-management.md` — gerenciamento de estado
- `directory-contract.md` — contrato de diretórios

## Workflow recomendado para mudanças

1. Plan mode antes de tarefas com >3 passos (`Shift+Tab` 2x)
2. Issue → Branch → PR → Merge (regra #30 do Mega Brain)
3. Verificar antes de declarar pronto (skill `verification-before-completion`)
4. Não bypassar pre-commit hooks
