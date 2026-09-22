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

## Ambientes

Este projeto é aberto a partir de mais de uma máquina. O que está disponível
depende de onde a sessão está rodando — **verifique antes de assumir**.

### macOS (`/Users/relative/leadhouse`) — ambiente enxuto

`~/.claude/` **não contém** `skills/`, `hooks/`, `rules/` nem `commands/`.
Disponíveis apenas as skills nativas do Claude Code:

- `code-review` — revisão do diff / PR
- `simplify` — review de qualidade de código
- `security-review` — auditoria de segurança das mudanças da branch
- `claude-api` — boas práticas Anthropic SDK (relevante para `services/claude.js`)
- `run` — subir o app para validar mudanças

Não há `node` no PATH desta máquina, então testes locais e `node --check`
não rodam aqui; validação acontece no deploy da Vercel.

O env var `MEGA_BRAIN_ROOT` está setado (herdado de `.claude/settings.local.json`),
mas aponta para um caminho Windows inexistente aqui — ignore-o neste ambiente.

### Windows (Mega Brain) — ambiente completo

```
MEGA_BRAIN_ROOT = c:\Users\magal\Documents\mybrain  (User-scope env var)
```

Nessa máquina `~/.claude/` traz skills, hooks, rules e commands adicionais
(incluindo `feature-dev`, `verification-before-completion` e a suite `/gsd:*`).

Commands que dependem de `Documents\mybrain\` (agents, knowledge, workspace) e
**só funcionam abrindo o Claude Code lá**:

`/jarvis-briefing`, `/conclave`, `/extract-dna`, `/ingest-empresa`, `/ingest-pessoal`, `/process-jarvis`, `/system-digest`, `/inbox`, `/agents`, `/dossiers`, `/debate`, `/compare`, `/ask`, `/create-agent`, `/view-dna`, `/mission-autopilot`, `/ler-drive`, `/extract-knowledge`, `/chat`

## Convenções específicas do LeadHaus

- **Secrets:** nunca commitar `.env`. Variáveis sensíveis em `.env` (gitignored).
- **Webhook URL:** configurada na Meta Console, não hardcoded.
- **Lead scoring:** thresholds em `utils/leadScoring.js`. Mudanças afetam classificação quente/morno/frio.
- **Migrations:** Supabase rodadas via SQL direto (ver `migrations/`).
- **Deploy:** `git push` para branch principal aciona Vercel.

## Regras do Mega Brain

Os arquivos em `C:\Users\magal\.claude\rules\` são carregados **apenas na máquina
Windows**. Fora dela valem como princípios, não como regras carregadas:

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
3. Verificar antes de declarar pronto (no macOS, sem a skill
   `verification-before-completion`: revisar o diff e conferir cada item pedido)
4. Não bypassar pre-commit hooks
