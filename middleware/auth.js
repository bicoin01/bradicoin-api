// middleware/auth.js
// ============================================
// Middleware de autenticação JWT - Bradicoin (v2.0)
// ============================================
// 🔐 SEGURANÇA:
//   - Token apenas via Authorization: Bearer
//   - Nunca aceita ?token= (vaza em logs)
//   - Verifica issuer + audience
//   - Verifica tokenVersion (permite logout real)
//   - Select mínimo (nunca traz password)
// ============================================

const jwt = require('jsonwebtoken');
const User = require('../models/User');

// ============================================
// CONSTANTES
// ============================================
const JWT_ALGORITHM = 'HS256';
const JWT_ISSUER = 'bradicoin-api';
const JWT_AUDIENCE = 'bradicoin-clients';

// Opções padrão do verify
const VERIFY_OPTIONS = {
    algorithms: [JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE
};

// ============================================
// EXTRAIR TOKEN DO REQUEST
// ============================================
// Apenas do header Authorization: Bearer xxx
// NÃO aceita ?token= (vaza em logs, proxies, histórico)
//
function extractToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || typeof authHeader !== 'string') return null;
    if (!authHeader.startsWith('Bearer ')) return null;

    const token = authHeader.substring(7).trim();
    if (!token) return null;

    return token;
}

// ============================================
// VERIFICAR TOKEN E BUSCAR USUÁRIO
// ============================================
async function verifyTokenAndGetUser(token) {
    // 1. Verifica JWT (assinatura, expiração, issuer, audience)
    const decoded = jwt.verify(token, process.env.JWT_SECRET, VERIFY_OPTIONS);

    // 2. Busca usuário SEM password e SEM dados sensíveis
    const user = await User.findById(decoded.id).select(
        '-password -twoFactorSecret -resetPasswordToken -resetPasswordExpires'
    );

    if (!user) {
        throw new Error('USER_NOT_FOUND');
    }

    // 3. Verifica status
    if (user.status !== 'active') {
        throw new Error('USER_INACTIVE');
    }

    // 4. Verifica tokenVersion (logout real)
    //    ⚠️ Precisamos buscar o tokenVersion separadamente,
    //    pois está no select: false
    const userWithVersion = await User.findById(decoded.id)
        .select('+tokenVersion')
        .lean();

    const currentVersion = userWithVersion?.tokenVersion ?? 0;
    const tokenVersion = decoded.v ?? 0;

    if (tokenVersion !== currentVersion) {
        throw new Error('TOKEN_REVOKED');
    }

    return user;
}

// ============================================
// MIDDLEWARE PRINCIPAL — AUTENTICAÇÃO OBRIGATÓRIA
// ============================================
async function authenticate(req, res, next) {
    try {
        const token = extractToken(req);

        if (!token) {
            return res.status(401).json({
                success: false,
                error: 'Token não fornecido',
                code: 'NO_TOKEN'
            });
        }

        const user = await verifyTokenAndGetUser(token);

        req.user = user;
        req.userId = user._id;

        next();
    } catch (error) {
        return handleAuthError(error, res);
    }
}

// ============================================
// MIDDLEWARE — SÓ ADMIN
// ============================================
function requireAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            error: 'Não autenticado'
        });
    }

    if (req.user.role !== 'admin') {
        return res.status(403).json({
            success: false,
            error: 'Acesso restrito a administradores'
        });
    }

    next();
}

// ============================================
// MIDDLEWARE — AUTH OPCIONAL
// ============================================
// Só autentica se tiver token válido, mas não bloqueia se não tiver.
// Útil para rotas que funcionam sem login mas dão bônus se logado.
//
async function optionalAuth(req, res, next) {
    try {
        const token = extractToken(req);

        if (!token) {
            return next(); // sem token = OK, só não autentica
        }

        const user = await verifyTokenAndGetUser(token);

        req.user = user;
        req.userId = user._id;
    } catch (error) {
        // Ignora erros de token (auth é opcional),
        // mas loga erros INESPERADOS (bugs, DB down, etc.)
        const expectedErrors = [
            'USER_NOT_FOUND',
            'USER_INACTIVE',
            'TOKEN_REVOKED',
            'JsonWebTokenError',
            'TokenExpiredError'
        ];

        if (!expectedErrors.includes(error.message) && !expectedErrors.includes(error.name)) {
            console.warn('⚠️ optionalAuth erro inesperado:', error.message);
        }
    }

    next();
}

// ============================================
// TRATAMENTO DE ERROS DE AUTENTICAÇÃO
// ============================================
function handleAuthError(error, res) {
    // Token expirado
    if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
            success: false,
            error: 'Token expirado',
            code: 'TOKEN_EXPIRED'
        });
    }

    // Token inválido (assinatura, formato, issuer, audience)
    if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({
            success: false,
            error: 'Token inválido',
            code: 'INVALID_TOKEN'
        });
    }

    // Usuário não encontrado
    if (error.message === 'USER_NOT_FOUND') {
        return res.status(401).json({
            success: false,
            error: 'Usuário não encontrado',
            code: 'USER_NOT_FOUND'
        });
    }

    // Usuário inativo/suspenso
    if (error.message === 'USER_INACTIVE') {
        return res.status(403).json({
            success: false,
            error: 'Conta suspensa ou inativa',
            code: 'USER_INACTIVE'
        });
    }

    // Token revogado (logout em outro dispositivo)
    if (error.message === 'TOKEN_REVOKED') {
        return res.status(401).json({
            success: false,
            error: 'Sessão expirada. Faça login novamente.',
            code: 'TOKEN_REVOKED'
        });
    }

    // Erro inesperado
    console.error('❌ Erro no middleware auth:', error);
    return res.status(500).json({
        success: false,
        error: 'Erro interno de autenticação'
    });
}

// ============================================
// EXPORTS
// ============================================
module.exports = {
    authenticate,
    requireAdmin,
    optionalAuth
};
