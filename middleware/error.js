// middleware/error.js
// ============================================
// Tratamento global de erros - Bradicoin (v2.0)
// ============================================

const winston = require('winston');

// ============================================
// LOGGER CENTRALIZADO
// ============================================
// ⚠️ Este é o ÚNICO logger do projeto.
// Importe ele em outros arquivos com:
//   const { logger } = require('./middleware/error');
//
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({
            filename: 'error.log',
            level: 'error',
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 5
        }),
        new winston.transports.File({
            filename: 'combined.log',
            maxsize: 10 * 1024 * 1024,
            maxFiles: 5
        }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// ============================================
// SANITIZAR BODY (remove dados sensíveis do log)
// ============================================
const SENSITIVE_FIELDS = [
    'password',
    'newPassword',
    'currentPassword',
    'token',
    'signature',
    'privateKey',
    'publicKey',
    'twoFactorSecret',
    'twoFACode',
    'resetPasswordToken',
    'secret',
    'apiKey',
    'authorization',
    'cookie',
    'jwt'
];

function sanitizeForLog(obj, depth = 0) {
    if (depth > 3) return '[deep]';
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.slice(0, 10).map((v) => sanitizeForLog(v, depth + 1));

    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (SENSITIVE_FIELDS.some((f) => lowerKey.includes(f.toLowerCase()))) {
            out[key] = '[REDACTED]';
        } else if (typeof value === 'object' && value !== null) {
            out[key] = sanitizeForLog(value, depth + 1);
        } else if (typeof value === 'string' && value.length > 500) {
            out[key] = value.substring(0, 500) + '...[truncated]';
        } else {
            out[key] = value;
        }
    }
    return out;
}

// ============================================
// HANDLER GLOBAL DE ERROS
// ============================================
function errorHandler(err, req, res, next) {
    const isProduction = process.env.NODE_ENV === 'production';

    // 1. Log do erro (sanitizado)
    logger.error('API Error', {
        message: err.message,
        name: err.name,
        code: err.code || null,
        statusCode: err.statusCode || null,
        stack: isProduction ? undefined : err.stack,
        method: req.method,
        path: req.originalUrl?.split('?')[0] || req.path, // remove query strings
        ip: req.ip,
        userId: req.user?._id || null,
        body: sanitizeForLog(req.body),
        query: sanitizeForLog(req.query)
    });

    // ============================================
    // ERROS DO MONGOOSE
    // ============================================

    // Validação
    if (err.name === 'ValidationError') {
        const messages = Object.values(err.errors || {}).map((e) => e.message);
        return res.status(400).json({
            success: false,
            error: 'Erro de validação',
            details: messages
        });
    }

    // CastError (ID inválido)
    if (err.name === 'CastError') {
        return res.status(400).json({
            success: false,
            error: 'ID inválido'
        });
    }

    // ============================================
    // DUPLICAÇÃO (unique index)
    // ============================================
    if (err.code === 11000) {
        // ⚠️ Safe check (evita crash se keyPattern for undefined)
        const field = err.keyPattern
            ? Object.keys(err.keyPattern)[0]
            : 'Campo';

        return res.status(409).json({
            success: false,
            error: `${field} já está em uso`
        });
    }

    // ============================================
    // ERROS DO JWT
    // ============================================
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
        return res.status(401).json({
            success: false,
            error: 'Token inválido ou expirado'
        });
    }

    // ============================================
    // ERRO CUSTOM (com statusCode válido)
    // ============================================
    // ⚠️ Só aceita statusCode entre 400 e 599
    if (
        err.statusCode &&
        Number.isInteger(err.statusCode) &&
        err.statusCode >= 400 &&
        err.statusCode < 600
    ) {
        return res.status(err.statusCode).json({
            success: false,
            error: err.message || 'Erro'
        });
    }

    // ============================================
    // ERRO GENÉRICO (500)
    // ============================================
    return res.status(500).json({
        success: false,
        error: isProduction ? 'Erro interno do servidor' : err.message,
        ...(isProduction ? {} : { stack: err.stack })
    });
}

// ============================================
// HANDLER 404 — ROTAS NÃO ENCONTRADAS
// ============================================
function notFoundHandler(req, res, next) {
    // API → JSON 404
    if (req.path.startsWith('/api')) {
        return res.status(404).json({
            success: false,
            error: 'Rota não encontrada',
            path: req.path
        });
    }

    // Não-API → deixa passar (SPA fallback cuida)
    next();
}

// ============================================
// WRAPPER PARA ASYNC HANDLERS
// ============================================
// Uso:
//   router.get('/rota', asyncHandler(async (req, res) => { ... }))
//
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

// ============================================
// CLASSE DE ERRO CUSTOM
// ============================================
// Uso:
//   throw new AppError('Não autorizado', 401);
//
class AppError extends Error {
    constructor(message, statusCode = 500) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'AppError';
        Error.captureStackTrace(this, this.constructor);
    }
}

// ============================================
// EXPORTS
// ============================================
module.exports = {
    errorHandler,
    notFoundHandler,
    asyncHandler,
    AppError,
    logger,
    sanitizeForLog
};
