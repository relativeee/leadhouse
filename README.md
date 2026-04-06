# LeadHaus AI — Sistema de Qualificação de Leads Imobiliários

Servidor Node.js que recebe mensagens de leads via WhatsApp, conversa com eles usando Claude IA, classifica a temperatura do lead e salva tudo no Google Sheets — notificando o corretor automaticamente quando o lead está quente.

---

## Estrutura de Arquivos

```
leadhaus/
├── server.js                  # Servidor Express + lógica principal
├── prompts/
│   └── systemPrompt.js        # Personalidade e instruções da IA
├── services/
│   ├── claude.js              # Integração com Anthropic (Claude)
│   ├── whatsapp.js            # Envio de mensagens + parse do webhook
│   └── sheets.js              # Leitura e escrita no Google Sheets
├── utils/
│   └── leadScoring.js         # Cálculo de temperatura por pontuação
├── .env.example               # Modelo de variáveis de ambiente
├── package.json
└── README.md
```

---

## Pré-requisitos

- Node.js 18+
- Conta na Meta for Developers com WhatsApp Cloud API habilitado
- Chave de API do Claude (console.anthropic.com)
- Projeto no Google Cloud com a Sheets API habilitada
- Um domínio com HTTPS para o webhook (use ngrok em desenvolvimento)

---

## Passo a Passo — Configuração

### 1. Clone e instale as dependências

```bash
git clone <seu-repo>
cd leadhaus
npm install
```

### 2. Configure as variáveis de ambiente

```bash
cp .env.example .env
```

Edite o `.env` com os valores reais (veja cada seção abaixo).

---

### 3. WhatsApp Cloud API (Meta)

1. Acesse [developers.facebook.com](https://developers.facebook.com)
2. Crie um App do tipo **Business**
3. Adicione o produto **WhatsApp**
4. Vá em **WhatsApp > Configuração da API**
5. Gere um **Token de acesso permanente** → cole em `WHATSAPP_TOKEN`
6. Copie o **Phone Number ID** → cole em `WHATSAPP_PHONE_ID`
7. Em **Webhooks**, configure:
   - URL: `https://seu-dominio.com/webhook`
   - Token de verificação: o mesmo valor de `WEBHOOK_VERIFY_TOKEN` no `.env`
   - Campos: marque `messages`

---

### 4. Anthropic (Claude)

1. Acesse [console.anthropic.com](https://console.anthropic.com)
2. Crie uma API Key
3. Cole em `ANTHROPIC_API_KEY`

---

### 5. Google Sheets

#### 5a. Criar Service Account

1. Acesse [console.cloud.google.com](https://console.cloud.google.com)
2. Crie um projeto (ou use um existente)
3. Ative a **Google Sheets API**: Menu > APIs e Serviços > Biblioteca > Google Sheets API
4. Vá em **IAM & Admin > Service Accounts**
5. Crie uma Service Account
6. Clique na conta criada > **Chaves > Adicionar chave > JSON**
7. Faça download do arquivo JSON
8. Converta para uma única linha e cole em `GOOGLE_CREDENTIALS_JSON`:

```bash
# No terminal, para converter o JSON para uma linha só:
cat credentials.json | tr -d '\n'
```

#### 5b. Criar e compartilhar a planilha

1. Crie uma planilha no Google Sheets
2. Copie o ID da URL (entre `/d/` e `/edit`)
3. Cole em `GOOGLE_SHEET_ID`
4. Compartilhe a planilha com o email da Service Account (campo `client_email` do JSON) — dê permissão de **Editor**

---

### 6. Rode o servidor

```bash
# Desenvolvimento (com auto-reload)
npm run dev

# Produção
npm start
```

---

### 7. Exponha o servidor para o webhook (desenvolvimento local)

```bash
# Instale o ngrok se não tiver
npm install -g ngrok

# Exponha a porta 3000
ngrok http 3000
```

Use a URL HTTPS gerada (ex: `https://abc123.ngrok.io`) como URL do webhook na Meta.

---

## Fluxo de Funcionamento

```
Lead manda mensagem no WhatsApp
        ↓
Meta envia POST para /webhook
        ↓
server.js extrai telefone + mensagem
        ↓
Verifica duplicata (messageId)
        ↓
Adiciona ao histórico em memória
        ↓
Claude gera resposta curta e natural
        ↓
Resposta enviada ao lead via WhatsApp API
        ↓
Claude extrai JSON estruturado do histórico
        ↓
leadScoring valida/ajusta temperatura
        ↓
Dados salvos/atualizados no Google Sheets
        ↓
Se temperatura = quente → notifica corretor
```

---

## Campos Salvos no Google Sheets

| Coluna | Descrição |
|--------|-----------|
| Telefone | Identificador único do lead |
| Nome | Nome informado na conversa |
| Objetivo | comprar / alugar / investir |
| Tipo Imóvel | apartamento / casa / comercial / terreno |
| Bairro | Região de interesse |
| Faixa Valor | Orçamento informado |
| Pagamento | financiamento / à vista / FGTS |
| Prazo | Urgência do lead |
| Temperatura | quente / morno / frio |
| Próximo Passo | Ação recomendada para o corretor |
| Resumo | Resumo automático da conversa |
| Total Mensagens | Quantidade de mensagens enviadas pelo lead |
| Última Atualização | Timestamp da última interação |

---

## Próximas Evoluções Sugeridas

- [ ] Substituir histórico em memória por Redis (persistência entre restarts)
- [ ] Suporte a mensagens de áudio (transcrição via Whisper)
- [ ] Painel de visualização dos leads em tempo real
- [ ] Integração com agenda do corretor para agendamento automático
- [ ] Rate limiting por telefone para evitar abuso
- [ ] Modo de escalonamento: lead frio entra em fluxo de nutrição

---

## Suporte

Dúvidas? Entre em contato pelo WhatsApp configurado em `CORRETOR_TELEFONE`.
