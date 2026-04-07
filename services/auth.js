/**
 * services/auth.js
 * Autenticacao com bcrypt + JWT + Supabase.
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase } = require('./supabase');

const JWT_SECRET = process.env.JWT_SECRET || 'leadhouse_secret_2024_change_me';
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
    .select('id, nome, email, plano')
    .single();

  if (error) throw error;

  const token = jwt.sign({ id: data.id, email: data.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  return { token, user: { id: data.id, nome: data.nome, email: data.email, plano: data.plano || null } };
}

async function login(email, senha) {
  const { data: user, error } = await supabase
    .from('usuarios')
    .select('*')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (error) throw error;
  if (!user) throw new Error('E-mail ou senha incorretos');

  const senhaOk = await bcrypt.compare(senha, user.senha_hash);
  if (!senhaOk) throw new Error('E-mail ou senha incorretos');

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  return { token, user: { id: user.id, nome: user.nome, email: user.email, plano: user.plano || null } };
}

function verificarToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
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
  next();
}

module.exports = { registrar, login, verificarToken, authMiddleware };
