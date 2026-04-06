/**
 * services/sheets.js
 * Integração com Google Sheets via googleapis.
 * Salva e atualiza dados dos leads na planilha configurada.
 */

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });
}

/**
 * Salva ou atualiza um lead na planilha.
 * Procura pelo telefone na coluna A. Se encontrar, atualiza a linha.
 * Se não encontrar, adiciona uma nova linha.
 *
 * @param {string} telefone - Telefone do lead (identificador único)
 * @param {Object} leadData - Dados estruturados do lead
 * @param {number} totalMensagens - Total de mensagens trocadas
 */
async function salvarLead(telefone, leadData, totalMensagens) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const aba = process.env.GOOGLE_SHEET_ABA || 'Leads';

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // Busca todos os telefones existentes na coluna A
    const leitura = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${aba}!A:A`,
    });

    const linhas = leitura.data.values || [];
    const linhaExistente = linhas.findIndex(row => row[0] === telefone);

    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' });

    const dados = [
      telefone,
      leadData.nome,
      leadData.objetivo,
      leadData.tipo_imovel,
      leadData.bairro,
      leadData.faixa_valor,
      leadData.pagamento,
      leadData.prazo,
      leadData.temperatura,
      leadData.proximo_passo,
      leadData.resumo,
      totalMensagens,
      agora, // última atualização
    ];

    if (linhaExistente > 0) {
      // Linha encontrada — atualiza (linha 1 = cabeçalho, então índice + 1 + 1)
      const range = `${aba}!A${linhaExistente + 1}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [dados] },
      });
      console.log(`[Sheets] Lead atualizado na linha ${linhaExistente + 1}: ${telefone}`);
    } else {
      // Lead novo — adiciona ao final
      // Garante cabeçalho na primeira execução
      if (linhas.length === 0) {
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `${aba}!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[
              'Telefone', 'Nome', 'Objetivo', 'Tipo Imóvel', 'Bairro',
              'Faixa Valor', 'Pagamento', 'Prazo', 'Temperatura',
              'Próximo Passo', 'Resumo', 'Total Mensagens', 'Última Atualização',
            ]],
          },
        });
      }

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${aba}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [dados] },
      });
      console.log(`[Sheets] Novo lead salvo: ${telefone}`);
    }
  } catch (err) {
    console.error('[Sheets] Erro ao salvar lead:', err.message);
    throw err;
  }
}

module.exports = { salvarLead };
