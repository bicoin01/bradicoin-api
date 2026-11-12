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
const createOrderLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,      // 1 hora
    max: 10,                        // 10 pedidos/hora
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
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

// GET /treasury — 30 req/min por user
const treasuryLimiter = rateLimit({
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
// ⚠️ ORDEM IMPORTA:
//   1) Rotas estáticas primeiro (/create, /me, /treasury)
//   2) Rotas com parâmetro por último (/:orderId)
//   Senão /:orderId captura "treasury" e "me"

// POST /api/v1/buy/create
router.post(
    '/create',
    createOrderGlobalLimiter,   // 1º: global (sem req.user, barato)
    requireAuth,                // 2º: valida token + seta req.user
    createOrderLimiter,         // 3º: 10/hora por user
    buyController.createOrder
);

// GET /api/v1/buy/me
router.get(
    '/me',
    requireAuth,
    myOrdersLimiter,
    buyController.myOrders
);

// ============================================
// GET /api/v1/buy/treasury — status da tesouraria
// ============================================
// ⚠️ DEVE vir ANTES de /:orderId
router.get(
    '/treasury',
    requireAuth,
    treasuryLimiter,
    async (req, res) => {
        try {
            const Treasury = require('../models/Treasury');
            const WalletModel = require('../models/Wallet');

            const treasury = await Treasury.getMain();

            const agg = await WalletModel.aggregate([
                { $match: { status: 'active' } },
                { $group: { _id: null, total: { $sum: { $toDouble: '$balance' } } } }
            ]);

            const balanceBrd = parseFloat(treasury.balance.toString());
            const initialBrd = parseFloat(treasury.initialBalance.toString());

            res.json({
                success: true,
                data: {
                    balanceBrd: treasury.balance.toString(),
                    balanceUsd: (balanceBrd * 10).toFixed(2),
                    initialBrd: treasury.initialBalance.toString(),
                    initialUsd: (initialBrd * 10).toFixed(2),
                    totalSoldBrd: treasury.totalSold.toString(),
                    totalCreditedBrd: treasury.totalCredited.toString(),
                    lowBalanceAlertAt: treasury.lowBalanceAlertAt,
                    networkTotalSupply: (agg[0]?.total || 0).toFixed(8),
                    brdPriceUsd: 10
                }
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
);

// GET /api/v1/buy/:orderId
// ⚠️ ESTA DEVE SER A ÚLTIMA ROTA (captura tudo que sobrou)
router.get(
    '/:orderId',
    requireAuth,
    getOrderLimiter,
    buyController.getOrder
);

module.exports = router;
