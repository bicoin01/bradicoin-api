// routes/buy.js
// ============================================
// Rotas de compra de BradiCoin
// Monta em: /api/v1/buy
// ============================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const buyController = require('../controllers/buy');

// ⚠️ Ajuste o caminho/nome do middleware de auth se for diferente
let requireAuth;
try {
    const authMod = require('../middleware/auth');
    requireAuth = authMod.requireAuth
              || authMod.authenticate
              || authMod.verifyToken
              || authMod.protect
              || authMod;
} catch (e) {
    console.warn('[routes/buy] middleware/auth não encontrado — usando stub (NÃO USE EM PRODUÇÃO)');
    requireAuth = (req, res, next) => {
        req.user = { id: 'stub-user-id' };
        next();
    };
}

// ============================================
// RATE LIMITERS
// ============================================

// POST /create — 10 pedidos/hora por usuário
// Evita esgotar o range HD (9000 endereços)
const createOrderLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,      // 1 hora
    max: 10,                        // 10 pedidos/hora
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Por user_id (não por IP — usuários atrás de NAT compartilham IP)
        const uid = req.user?.id || req.user?._id;
        return uid ? `user:${uid}` : `ip:${req.ip}`;
    },
    message: {
        success: false,
        error: 'Muitos pedidos em pouco tempo. Aguarde 1 hora ou contate o suporte.'
    }
});

// POST /create — 100 pedidos/minuto global (proteção contra flood)
const createOrderGlobalLimiter = rateLimit({
    windowMs: 60 * 1000,            // 1 minuto
    max: 100,                       // 100 pedidos/minuto global
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => 'global',
    message: {
        success: false,
        error: 'Sistema ocupado. Tente novamente em alguns segundos.'
    }
});

// GET /:orderId — 60 req/min por user (polling do front é 5s = 12/min)
const getOrderLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const uid = req.user?.id || req.user?._id;
        return uid ? `user:${uid}` : `ip:${req.ip}`;
    },
    message: {
        success: false,
        error: 'Muitas consultas. Reduza a frequência de polling.'
    }
});

// GET /me — 30 req/min por user
const myOrdersLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const uid = req.user?.id || req.user?._id;
        return uid ? `user:${uid}` : `ip:${req.ip}`;
    },
    message: {
        success: false,
        error: 'Muitas consultas. Aguarde alguns segundos.'
    }
});

// ============================================
// ROTAS
// ============================================
// ⚠️ ORDEM IMPORTA: requireAuth ANTES do limiter que usa req.user

// POST /api/v1/buy/create
router.post(
    '/create',
    createOrderGlobalLimiter,   // 1º: global (sem req.user, barato)
    requireAuth,                // 2º: valida token + seta req.user
    createOrderLimiter,         // 3º: 10/hora por user (agora tem req.user.id)
    buyController.createOrder
);

// GET /api/v1/buy/me
router.get(
    '/me',
    requireAuth,                // 1º: seta req.user
    myOrdersLimiter,            // 2º: 30/min por user
    buyController.myOrders
);

// GET /api/v1/buy/:orderId
router.get(
    '/:orderId',
    requireAuth,                // 1º: seta req.user
    getOrderLimiter,            // 2º: 60/min por user
    buyController.getOrder
);

module.exports = router;
