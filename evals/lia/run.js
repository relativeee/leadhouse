#!/usr/bin/env node
/**
 * Bateria de conversas da Lia.
 *
 *   npm run eval:lia                     # todos os casos
 *   npm run eval:lia -- --caso cpf       # um caso (pode repetir --caso)
 *   LIA_EFFORT=medium npm run eval:lia   # testar outro nivel de raciocinio
 *
 * Usa services/claude.js (mesmo prompt, modelo e tools da producao) com um
 * cadastro ficticio (evals/lia/inventario.js): nada e gravado no banco e nada
 * sai pelo WhatsApp. Precisa de ANTHROPIC_API_KEY no .env. Custa ~US$ 1 por
 * rodada completa.
 *
 * Diferencas conhecidas da producao: o [ESTADO DA CONVERSA] aqui so diz se a
 * Lia ja se apresentou (em producao tambem lista os dados extraidos por uma
 * chamada extra), e nao ha o bloco [IMOVEL COMPATIVEL] da pre-busca.
 *
 * Resultado: evals/lia/resultados/<data>.json e .md (ignorados pelo git).
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { gerarResposta, MODEL } = require('../../services/claude');
const { criarToolHandlers } = require('../../services/liaTools');
const { INVENTARIO, HORARIOS } = require('./inventario');
const { avaliarConversa } = require('./checks');
const todosCasos = require('./casos');

const NOME_CORRETOR = 'Luca';
const JUIZ_MODELO = 'claude-opus-5-5';
const CONCORRENCIA = 4;
const NOTA_MINIMA = 4;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Falta ANTHROPIC_API_KEY no .env (veja .env.example).');
  process.exit(1);
}
const client = new Anthropic();

// Supabase falso so com o que services/liaTools.js usa: select/eq/limit/maybeSingle.
function dbFalso(inventario) {
  return {
    supabase: {
      from() {
        const filtros = [];
        let limite = Infinity;
        const resultado = () => inventario.filter(im => filtros.every(([c, v]) => c === 'usuario_id' || String(im[c]) === String(v))).slice(0, limite);
        const q = {
          select() { return q; },
          eq(c, v) { filtros.push([c, v]); return q; },
          limit(n) { limite = n; return q; },
          maybeSingle: async () => ({ data: resultado()[0] || null, error: null }),
          then(ok, erro) { return Promise.resolve({ data: resultado(), error: null }).then(ok, erro); },
        };
        return q;
      },
    },
  };
}

function estadoDaConversa(historico) {
  const jaApresentou = historico.some(m => m.role === 'assistant');
  return `[ESTADO DA CONVERSA]\n- Mensagens trocadas: ${historico.length}.\n` + (jaApresentou
    ? '- Você já se apresentou. Não cumprimente nem se apresente de novo: continue a conversa de onde ela está.\n'
    : '- É a sua primeira resposta: apresente-se em uma frase curta.\n');
}

async function conversar(caso) {
  const inventario = caso.inventario || INVENTARIO;
  const historico = [];
  const turnos = [];
  const conversa = { imoveisEnviados: new Set() };
  const toolHandlers = criarToolHandlers({
    userId: 1,
    telefone: 'eval',
    conversa,
    db: dbFalso(inventario),
    sendImage: async () => {},
  });

  for (const lead of caso.mensagens) {
    historico.push({ role: 'user', content: lead });
    const contexto = `${estadoDaConversa(historico)}\n${HORARIOS}`;
    const inicio = Date.now();
    const r = await gerarResposta(historico, contexto, { nomeCorretor: NOME_CORRETOR, roteiro: caso.roteiro, toolHandlers });
    turnos.push({ lead, lia: r.texto, tools: r.toolsExecutadas, ms: Date.now() - inicio });
    historico.push({ role: 'assistant', content: r.texto || '(sem resposta)' });
  }
  return { turnos, inventario };
}

const SCHEMA_JUIZ = {
  type: 'object',
  properties: {
    naturalidade: { type: 'integer', description: '1 a 5: soa como uma pessoa no WhatsApp, reage ao lead, sem script' },
    fidelidade_fatos: { type: 'integer', description: '1 a 5: tudo que afirma sobre imóveis, valores, fotos e horários bate com o cadastro e com o que as ferramentas retornaram' },
    conducao: { type: 'integer', description: '1 a 5: avança a conversa (qualifica sem repetir, leva à visita quando faz sentido)' },
    roteiro: { type: 'integer', description: '1 a 5: segue o roteiro do corretor; 5 se não há roteiro' },
    atende_esperado: { type: 'boolean', description: 'a conversa cumpre o comportamento esperado do caso' },
    problemas: { type: 'array', items: { type: 'string' }, description: 'problemas concretos, citando a mensagem' },
    resumo: { type: 'string', description: 'uma frase sobre a conversa' },
  },
  required: ['naturalidade', 'fidelidade_fatos', 'conducao', 'roteiro', 'atende_esperado', 'problemas', 'resumo'],
  additionalProperties: false,
};

function transcrever(turnos) {
  return turnos.map((t, i) => {
    const tools = (t.tools || []).map(x => `   [ferramenta ${x.nome} ${JSON.stringify(x.input)} -> ${JSON.stringify(x.resultado).slice(0, 600)}]`).join('\n');
    return `Turno ${i + 1}\nLead: ${t.lead}\n${tools ? tools + '\n' : ''}Lia: ${t.lia}`;
  }).join('\n\n');
}

async function julgar(caso, turnos, inventario) {
  const prompt = `Você avalia conversas de WhatsApp da Lia, assistente virtual que atende leads de um corretor de imóveis (Luca) em João Pessoa.

Regras da Lia: fala natural e curta, uma pergunta por mensagem, sem markdown; nunca inventa imóvel, valor, foto ou horário (só o que vem das ferramentas e da lista de horários); não promete desconto, não calcula parcela, não pede documentos; leva à visita quando o lead se interessa; não promete ações que não faz (avisar o lead depois).

Cadastro de imóveis disponível nesta conversa:
${inventario.length ? inventario.map(i => `- ${i.titulo} (${i.bairro}, ${i.tipo}, ${i.quartos} quartos, ${i.valor}, ${i.foto_url ? 'com foto' : 'sem foto'})`).join('\n') : '(nenhum imóvel cadastrado)'}

${HORARIOS}

${caso.roteiro ? `Roteiro do corretor para esta conversa:\n${JSON.stringify(caso.roteiro, null, 2)}\n` : 'Sem roteiro do corretor.\n'}
Comportamento esperado neste caso: ${caso.esperado}

Conversa:
${transcrever(turnos)}

Avalie com rigor. Uma nota 5 em fidelidade_fatos exige zero afirmação sem base.`;

  const resp = await client.beta.messages.create({
    model: JUIZ_MODELO,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA_JUIZ } },
    messages: [{ role: 'user', content: prompt }],
  });
  if (resp.stop_reason === 'refusal') throw new Error('avaliador recusou');
  const texto = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(texto);
}

async function rodarCaso(caso) {
  try {
    const { turnos, inventario } = await conversar(caso);
    const { falhas, avisos } = avaliarConversa(turnos, caso, inventario);
    const juiz = await julgar(caso, turnos, inventario);
    const notas = [juiz.naturalidade, juiz.fidelidade_fatos, juiz.conducao, juiz.roteiro];
    const passou = !falhas.length && juiz.atende_esperado && Math.min(...notas) >= NOTA_MINIMA;
    return { id: caso.id, descricao: caso.descricao, passou, falhas, avisos, juiz, turnos };
  } catch (err) {
    return { id: caso.id, descricao: caso.descricao, passou: false, erro: err.message, falhas: [], avisos: [], turnos: [] };
  }
}

async function emParalelo(itens, n, fn) {
  const saida = new Array(itens.length);
  let proximo = 0;
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => {
    while (proximo < itens.length) {
      const i = proximo++;
      saida[i] = await fn(itens[i]);
      process.stdout.write(`${saida[i].passou ? '✓' : '✗'} ${saida[i].id}\n`);
    }
  }));
  return saida;
}

function relatorio(resultados, meta) {
  const ok = resultados.filter(r => r.passou).length;
  const linhas = [
    `# Bateria da Lia — ${meta.data}`,
    '',
    `Modelo: ${meta.modelo} · effort: ${meta.effort} · ${ok}/${resultados.length} casos passaram`,
    '',
    '| Caso | Resultado | Natural | Fatos | Condução | Roteiro | Falhas automáticas |',
    '|---|---|---|---|---|---|---|',
    ...resultados.map(r => `| ${r.id} | ${r.passou ? '✅' : '❌'} | ${r.juiz?.naturalidade ?? '-'} | ${r.juiz?.fidelidade_fatos ?? '-'} | ${r.juiz?.conducao ?? '-'} | ${r.juiz?.roteiro ?? '-'} | ${r.erro ? 'ERRO: ' + r.erro : r.falhas.map(f => f.regra).join(', ') || '—'} |`),
    '',
  ];
  for (const r of resultados) {
    linhas.push(`## ${r.passou ? '✅' : '❌'} ${r.id} — ${r.descricao}`, '');
    if (r.erro) { linhas.push(`Erro: ${r.erro}`, ''); continue; }
    if (r.juiz) linhas.push(`Avaliador: ${r.juiz.resumo}`, '');
    for (const f of r.falhas) linhas.push(`- ❌ ${f.regra}${f.turno ? ` (turno ${f.turno})` : ''}: ${f.detalhe}`);
    for (const p of r.juiz?.problemas || []) linhas.push(`- ⚠️ ${p}`);
    for (const a of r.avisos) linhas.push(`- ℹ️ ${a.regra} (turno ${a.turno}): ${a.detalhe}`);
    linhas.push('', '```');
    for (const t of r.turnos) {
      linhas.push(`Lead: ${t.lead}`);
      for (const x of t.tools || []) linhas.push(`  [${x.nome} ${JSON.stringify(x.input)}]`);
      linhas.push(`Lia (${(t.ms / 1000).toFixed(1)}s): ${t.lia}`, '');
    }
    linhas.push('```', '');
  }
  return linhas.join('\n');
}

(async () => {
  const filtro = process.argv.flatMap((a, i, arr) => (a === '--caso' ? [arr[i + 1]] : []));
  const casos = filtro.length ? todosCasos.filter(c => filtro.includes(c.id)) : todosCasos;
  if (!casos.length) { console.error(`Nenhum caso com id: ${filtro.join(', ')}`); process.exit(1); }

  const meta = { data: new Date().toISOString().slice(0, 16).replace('T', ' '), modelo: MODEL, effort: process.env.LIA_EFFORT || 'low' };
  console.log(`Rodando ${casos.length} caso(s) com ${meta.modelo} (effort ${meta.effort})...`);
  const resultados = await emParalelo(casos, CONCORRENCIA, rodarCaso);

  const dir = path.join(__dirname, 'resultados');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, meta.data.replace(/[: ]/g, '-'));
  fs.writeFileSync(`${base}.json`, JSON.stringify({ meta, resultados }, null, 2));
  fs.writeFileSync(`${base}.md`, relatorio(resultados, meta));

  const ok = resultados.filter(r => r.passou).length;
  console.log(`\n${ok}/${resultados.length} passaram. Relatório: ${base}.md`);
  process.exit(ok === resultados.length ? 0 : 1);
})();
