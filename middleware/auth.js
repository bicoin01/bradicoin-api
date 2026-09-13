// middleware/auth.js
// ============================================
// Middleware de autenticação JWT - Bradicoin
// ============================================

const jwt = require('jsonwebtoken');
const User = require('../models/User');

// ============================================
// MIDDLEWARE PRINCIPAL — VALIDA JWT
// ============================================

async function authenticate(req, res, next) {
    try {
        let token = null;

        // 1. Authorization: Bearer xxx
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
        }

        // 2. Query param ?token=xxx (fallback)
        if (!token && req.query.token) {
            token = req.query.token;
        }

        // 3. Cookie (fallback)
        if (!token && req.cookies && req.cookies.token) {
            token = req.cookies.token;
        }

        if (!token) {
            return res.status(401).json({
                success: false,
                error: 'Token não fornecido'
            });
        }

        // Verifica JWT
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Busca usuário
        const user = await User.findById(decoded.id);

        if (!user) {
            return res.status(401).json({
                success: false,
                error: 'Usuário não encontrado'
            });
        }

        if (user.status !== 'active') {
            return res.status(403).json({
                success: false,
                error: 'Conta suspensa ou inativa'
            });
        }

        // Injeta no request
        req.user = user;
        req.userId = user._id;
        next();

    } catch (error) {
        // Token expirado
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                error: 'Token expirado',
                code: 'TOKEN_EXPIRED'
            });
        }

        // Token inválido
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                success: false,
                error: 'Token inválido'
            });
        }

        // Outros erros
        console.error('Erro no middleware auth:', error);
        return res.status(500).json({
            success: false,
            error: 'Erro interno de autenticação'
        });
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

// Só autentica se tiver token, mas não bloqueia se não tiver
async function optionalAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const user = await User.findById(decoded.id);
            if (user && user.status === 'active') {
                req.user = user;
                req.userId = user._id;
            }
        }
    } catch (error) {
        // Ignora erros — auth é opcional
    }
    next();
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    authenticate,
    requireAdmin,
    optionalAuth
};
