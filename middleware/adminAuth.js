// middleware/adminAuth.js
// ============================================
// Admin Auth Middleware — BradiChain
// ============================================
// Autenticação simples por API key via header X-Admin-Key.
// Independente do JWT de usuário — serve apenas para rotas
// administrativas (depositar no pool, pausar, status).
//
// Uso no .env:
//   ADMIN_API_KEY=sua-chave-super-secreta-aqui
//
// Uso no cliente (curl/Postman):
//   Header: X-Admin-Key: sua-chave-super-secreta-aqui
//   OU:     Authorization: Bearer sua-chave-super-secreta-aqui
// ============================================

const { AppError } = require('./error');

function requireAdmin(req, res, next) {
    const expectedKey = process.env.ADMIN_API_KEY;

    // 1. Servidor precisa ter a chave configurada
    if (!expectedKey) {
        console.error('🚨 ADMIN_API_KEY não está definida no .env');
        return next(new AppError('Configuração de admin ausente no servidor', 500));
    }

    // 2. Cliente precisa mandar o header
    const providedKey =
        req.headers['x-admin-key'] ||
        req.headers['X-Admin-Key'] ||
        req.headers['authorization']?.replace(/^Bearer\s+/i, '');

    if (!providedKey) {
        return next(new AppError('Header X-Admin-Key é obrigatório', 401));
    }

    // 3. Comparação em tempo constante (evita timing attacks)
    if (!safeEqual(providedKey, expectedKey)) {
        console.warn(`⚠️ Tentativa de acesso admin com chave inválida. IP: ${req.ip}`);
        return next(new AppError('X-Admin-Key inválido', 403));
    }

    // 4. Log de auditoria
    console.log(`🔐 Admin autenticado: ${req.method} ${req.originalUrl} (IP: ${req.ip})`);

    next();
}

// ============================================
// Comparação em tempo constante
// ============================================
// Evita timing attacks: sempre compara o mesmo número de bytes,
// mesmo que as strings tenham tamanhos diferentes.
// ============================================
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;

    const lenA = a.length;
    const lenB = b.length;
    const maxLen = Math.max(lenA, lenB);

    let diff = lenA ^ lenB;

    for (let i = 0; i < maxLen; i++) {
        const charA = i < lenA ? a.charCodeAt(i) : 0;
        const charB = i < lenB ? b.charCodeAt(i) : 0;
        diff |= charA ^ charB;
    }

    return diff === 0;
}

module.exports = { requireAdmin };
