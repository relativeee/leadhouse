/**
 * Cadastro ficticio fixo usado pela bateria. Mesmo formato da tabela imoveis
 * (valor/quartos como TEXT, em formatos variados como no banco real), pra que
 * a busca de verdade (utils/imoveisBusca.js) seja exercitada.
 */
const INVENTARIO = [
  { id: 101, titulo: 'Residencial Brisa do Mar', bairro: 'Tambaú', tipo: 'Apartamento', quartos: '2', valor: '380.000', area: '65', vagas: '1', status: 'disponivel', foto_url: 'https://exemplo.invalid/brisa.jpg' },
  { id: 102, titulo: 'Edifício Atlântico', bairro: 'Manaíra', tipo: 'Apartamento', quartos: '3', valor: '795.000', area: '98', vagas: '2', status: 'disponivel', foto_url: 'https://exemplo.invalid/atlantico.jpg' },
  { id: 103, titulo: 'Solar das Palmeiras', bairro: 'Cabo Branco', tipo: 'Apartamento', quartos: '3', valor: '650000', area: '90', vagas: '2', status: 'disponivel', foto_url: null },
  { id: 104, titulo: 'Casa Jardim do Bessa', bairro: 'Bessa', tipo: 'Casa', quartos: '4', valor: '1.200.000', area: '220', vagas: '3', status: 'disponivel', foto_url: 'https://exemplo.invalid/bessa.jpg' },
  { id: 105, titulo: 'Porto Real', bairro: 'Miramar', tipo: 'Apartamento', quartos: '4', valor: '2.500.000', area: '180', vagas: '3', status: 'disponivel', foto_url: 'https://exemplo.invalid/porto.jpg' },
  { id: 106, titulo: 'Edifício Mirante', bairro: 'Tambaú', tipo: 'Apartamento', quartos: '3', valor: 'R$ 690.000,00', area: '88', vagas: '2', status: 'disponivel', foto_url: 'https://exemplo.invalid/mirante.jpg' },
];

// Mesmo formato do bloco que o servidor injeta (calcularHorariosLivres).
const HORARIOS = `[HORÁRIOS DISPONÍVEIS PARA VISITAS]
Quando o cliente quiser agendar uma visita, sugira estes horários:
- sexta-feira 14/11: 10:00, 14:00, 16:00
- sábado 15/11: 09:00, 11:00
- segunda-feira 17/11: 10:00, 15:00

Sempre ofereça 2-3 opções ao cliente. Se nenhum horário servir, diga que vai consultar o corretor.`;

module.exports = { INVENTARIO, HORARIOS };
