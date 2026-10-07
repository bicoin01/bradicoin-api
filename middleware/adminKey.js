// middleware/adminKey.js
// ============================================
// Proteção simples via header x-admin-key
// ============================================
// Uso pessoal: sem JWT, só uma chave secreta no .env
// ============================================

const { AppError } = require('./error');

function requireAdminKey(req, res, next) {
    const expected = process.env.ADMIN_KEY;

    if (!expected || expected.length < 16) {
        return next(new AppError('ADMIN_KEY não configurada no servidor (min 16 chars)', 500));
    }

    const provided = req.headers['x-admin-key'];

    if (!provided || provided !== expected) {
        return res.status(401).json({
            success: false,
            error: 'Admin key inválida ou ausente'
        });
    }

    next();
}

module.exports = { requireAdminKey };
