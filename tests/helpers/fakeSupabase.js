// Supabase falso em memoria — so o subconjunto do query builder usado pelos workers.
// Fica fora de *.test.js pra o `node --test` nao tentar rodar como teste.
//
// unique:   { tabela: ['col', ...] }  ou  { tabela: [{ cols: [...], onde: row => bool }, ...] }
//           (a 2a forma imita indice unico parcial: `... where status = 'ativa'`)
// defaults: { tabela: () => ({ coluna: valor }) }  — imita DEFAULT do Postgres no insert
// ausentes: ['tabela']  — simula migration nao aplicada (erro PGRST205)
function fakeSupabase(tabelas, { unique = {}, ausentes = [], defaults = {} } = {}) {
  let seq = 1000;

  function regrasUnicas(nome) {
    const u = unique[nome];
    if (!u) return [];
    if (typeof u[0] === 'string') return [{ cols: u, onde: () => true }];
    return u;
  }

  function violaUnico(nome, t, row, ignorar) {
    return regrasUnicas(nome).some(({ cols, onde }) =>
      onde(row) && t.some(r => r !== ignorar && onde(r) && cols.every(c => r[c] === row[c])));
  }

  function from(nome) {
    const filtros = [];
    let op = 'select', payload = null, limite = Infinity, modo = 'many';
    const b = {
      select() { return b; },
      insert(row) { op = 'insert'; payload = row; return b; },
      update(obj) { op = 'update'; payload = obj; return b; },
      upsert(row) { op = 'upsert'; payload = row; return b; },
      delete() { op = 'delete'; return b; },
      eq(c, v) { filtros.push(r => r[c] === v); return b; },
      in(c, vs) { filtros.push(r => vs.includes(r[c])); return b; },
      is(c, v) { filtros.push(r => (r[c] ?? null) === v); return b; },
      not(c, _op, v) { filtros.push(r => (r[c] ?? null) !== v); return b; },
      lt(c, v) { filtros.push(r => r[c] < v); return b; },
      gt(c, v) { filtros.push(r => r[c] > v); return b; },
      gte(c, v) { filtros.push(r => r[c] >= v); return b; },
      lte(c, v) { filtros.push(r => r[c] <= v); return b; },
      order() { return b; },
      limit(n) { limite = n; return b; },
      single() { modo = 'single'; return b; },
      maybeSingle() { modo = 'maybe'; return b; },
      then(ok, fail) { return Promise.resolve(exec()).then(ok, fail); },
    };
    function exec() {
      if (ausentes.includes(nome)) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${nome}' in the schema cache` } };
      const t = (tabelas[nome] ||= []);
      if (op === 'insert') {
        const row = { id: seq++, ...(defaults[nome]?.() || {}), ...payload };
        if (violaUnico(nome, t, row)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        t.push(row);
        return { data: row, error: null };
      }
      const alvo = t.filter(r => filtros.every(f => f(r)));
      if (op === 'update') {
        for (const r of alvo) {
          const novo = { ...r, ...payload };
          if (violaUnico(nome, t, novo, r)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          Object.assign(r, payload);
        }
        return { data: alvo, error: null };
      }
      if (op === 'delete') {
        tabelas[nome] = t.filter(r => !alvo.includes(r));
        return { data: alvo, error: null };
      }
      const data = alvo.slice(0, limite);
      if (modo === 'many') return { data, error: null };
      return { data: data[0] || null, error: null };
    }
    return b;
  }
  return { from };
}

module.exports = { fakeSupabase };
