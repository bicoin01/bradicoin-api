// middleware/error.js
// ============================================
// Tratamento global de erros - Bradicoin
// ============================================

const winston = require('winston');

// ============================================
// LOGGER
// ============================================

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// ============================================
// HANDLER GLOBAL DE ERROS
// ============================================

function errorHandler(err, req, res, next) {
    // Log do erro
    logger.error('Erro na API:', {
        message: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
        ip: req.ip
    });

    // ========== ERROS DO MONGOOSE ==========

    // Erro de validação
    if (err.name === 'ValidationError') {
        const messages = Object.values(err.errors).map((e) => e.message);
        return res.status(400).json({
            success: false,
            error: 'Erro de validação',
            details: messages
        });
    }

    // ID inválido (CastError)
    if (err.name === 'CastError') {
        return res.status(400).json({
            success: false,
            error: 'ID inválido'
        });
    }

    // ========== ERRO DE DUPLICAÇÃO (unique) ==========

    if (err.code === 11000) {
        const field = Object.keys(err.keyPattern)[0];
        return res.status(409).json({
            success: false,
            error: `${field} já está em uso`
        });
    }

    // ========== ERROS DO JWT ==========

    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
        return res.status(401).json({
            success: false,
            error: 'Token inválido ou expirado'
        });
    }

    // ========== ERRO CUSTOM (com statusCode) ==========

    if (err.statusCode) {
        return res.status(err.statusCode).json({
            success: false,
            error: err.message
        });
    }

    // ========== ERRO GENÉRICO ==========

    const isProduction = process.env.NODE_ENV === 'production';
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
    if (req.path.startsWith('/api')) {
        return res.status(404).json({
            success: false,
            error: 'Rota não encontrada',
            path: req.path
        });
    }
    next();
}

// ============================================
// WRAPPER PARA ASYNC HANDLERS
// ============================================

// Evita ter que ficar escrevendo try/catch em toda rota async
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    errorHandler,
    notFoundHandler,
    asyncHandler,
    logger
};
