/**
 * services/auth.js
 * Autenticacao com bcrypt + JWT + Supabase.
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase } = require('./supabase');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('FATAL: JWT_SECRET nao definido'); process.exit(1); }
const JWT_EXPIRES = '7d';

async function registrar(nome, email, senha) {
  // Verifica se ja existe
  const { data: existe } = await supabase
    .from('usuarios')
    .select('id')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (existe) throw new Error('E-mail ja cadastrado');

  const senha_hash = await bcrypt.hash(senha, 10);

  const { data, error } = await supabase
    .from('usuarios')
    .insert({ nome, email: email.toLowerCase(), senha_hash })
    .select('id, nome, email, plano, is_admin')
    .single();

  if (error) throw error;

  const token = jwt.sign({ id: data.id, email: data.email, is_admin: !!data.is_admin }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  return { token, user: { id: data.id, nome: data.nome, email: data.email, plano: data.plano || null, is_admin: !!data.is_admin } };
}

async function login(email, senha) {
  const { data: user, error } = await supabase
    .from('usuarios')
    .select('id, nome, email, plano, senha_hash, is_admin')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (error) throw error;
  if (!user) throw new Error('E-mail ou senha incorretos');

  const senhaOk = await bcrypt.compare(senha, user.senha_hash);
  if (!senhaOk) throw new Error('E-mail ou senha incorretos');

  const token = jwt.sign({ id: user.id, email: user.email, is_admin: !!user.is_admin }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  return { token, user: { id: user.id, nome: user.nome, email: user.email, plano: user.plano || null, is_admin: !!user.is_admin } };
}

function verificarToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token nao fornecido' });
  }

  const decoded = verificarToken(header.split(' ')[1]);
  if (!decoded) {
    return res.status(401).json({ erro: 'Token invalido ou expirado' });
  }

  req.userId = decoded.id;
  req.userEmail = decoded.email;
  req.realUserId = decoded.id;
  req.realUserEmail = decoded.email;
  req.isAdmin = !!decoded.is_admin;

  // Impersonation: admin pode atuar como outro usuario via header X-Acting-As
  const actAs = req.headers['x-acting-as'];
  if (actAs) {
    // Fallback pra tokens antigos sem a claim is_admin: consulta o DB
    // (custo: +1 query somente em requests com X-Acting-As, raro no fluxo normal)
    if (!req.isAdmin) {
      try {
        const { data: user } = await supabase
          .from('usuarios')
          .select('is_admin')
          .eq('id', decoded.id)
          .maybeSingle();
        if (user?.is_admin) req.isAdmin = true;
      } catch (err) {
        console.error('[authMiddleware] erro fallback admin check:', err.message);
      }
    }

    if (req.isAdmin) {
      const targetId = parseInt(actAs, 10);
      if (Number.isFinite(targetId) && targetId > 0 && targetId !== decoded.id) {
        req.userId = targetId;
        req.isImpersonating = true;
      }
    }
  }

  next();
}

module.exports = { registrar, login, verificarToken, authMiddleware };
